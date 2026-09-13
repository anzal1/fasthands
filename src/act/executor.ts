// fasthands executor — runs a batch of Actions against a live page, guarded
// by re-resolving every ref immediately before acting on it. Never fires
// blind on a stale target: that's the whole point.

import type { Page } from "playwright";
import type {
  Action,
  BatchResult,
  Executor,
  ObservationEngine,
  ResolvedNode,
  StepResult,
} from "../types.ts";
import type { Xray } from "../xray/xray.ts";

const ACTION_TIMEOUT_MS = 5000;
const DEFAULT_SCROLL_AMOUNT = 600;
const SETTLE_DELAY_MS = 150;
const SETTLE_CAP_MS = 2000;
const ANIMATION_SETTLE_CAP_MS = 800;
/** Pixels of slack allowed outside an element's box before a pointer/stroke
 *  coordinate is rejected. A hair over the edge (rounding, sub-pixel layout)
 *  shouldn't fail a step; a coordinate that's actually off the element should. */
const BOUNDS_TOLERANCE_PX = 2;
/** Hard cap on stroke path length — a runaway path is a model error, not
 *  something the executor should spend minutes replaying. */
const MAX_STROKE_POINTS = 64;

// ---------------------------------------------------------------------------
// Ambient shim so this file typechecks without a "dom" lib entry (we can't
// touch tsconfig.json, which is out of scope). This identifier only ever runs
// inside page.evaluate() callbacks, i.e. in the browser realm — never in the
// Node realm this file is compiled/stripped in. `declare const` emits no
// runtime code, so this is purely a type-level fix. Mirrors the same shim in
// src/observe/engine.ts.
// ---------------------------------------------------------------------------
declare const document: any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when (x,y) — in the element's own local coordinate space — falls
 *  inside its box, plus a small tolerance. Shared by "pointer" and "stroke"
 *  so both actions reject out-of-bounds coordinates the same way. */
function inBounds(x: number, y: number, box: Box, tolerance = BOUNDS_TOLERANCE_PX): boolean {
  return (
    x >= -tolerance &&
    y >= -tolerance &&
    x <= box.width + tolerance &&
    y <= box.height + tolerance
  );
}

/** Race a promise against a hard timeout, throwing on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** After a click/goto, wait briefly for the page to settle so the next
 *  observation isn't captured mid-transition. Capped at 2s total; never
 *  throws (a page that never reaches domcontentloaded just times out).
 *
 *  Also awaits finite CSS/Web Animations (capped at 800ms): the browser
 *  itself knows when motion has settled via document.getAnimations(), which
 *  beats sleeping a fixed number of ms — a fixed sleep either wastes idle
 *  time waiting past when things actually finished, or under-waits and hands
 *  the next observe() a page still mid-transition (wrong refs/hashes
 *  captured while an element is still moving). Infinite animations
 *  (spinners, indefinite pulses) are excluded, or we'd wait forever for
 *  something that never finishes. Guarded so pages without a real
 *  `evaluate` (e.g. the FakePage used by smoke tests) just skip this step. */
async function settle(page: Page): Promise<void> {
  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    sleep(SETTLE_CAP_MS),
  ]);
  await sleep(SETTLE_DELAY_MS);

  const awaitAnimations = async (): Promise<void> => {
    try {
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a: any) => {
              try {
                const t = a.effect?.getTiming?.();
                return t && t.iterations !== Infinity;
              } catch {
                return false;
              }
            })
            .map((a: any) => a.finished.catch(() => {})),
        ),
      );
    } catch {
      // No real `evaluate` (fake pages in smoke tests) or animations API
      // unavailable — settle() degrades to the wait above.
    }
  };

  await Promise.race([awaitAnimations(), sleep(ANIMATION_SETTLE_CAP_MS)]);
}

/** Resolve a ref via the engine. When `guards` is true (the default, safe
 *  path), require it to still match what the model last saw — a hash
 *  mismatch aborts the batch as drift. When `guards` is false (the ablation
 *  arm, modeling a batch fired blind against a stale observation), the
 *  mismatch is ignored and the live handle is used anyway; only a fully
 *  vanished node fails. Returns the ResolvedNode on success, or an error
 *  string describing the drift/absence for the caller to record. */
async function resolveGuarded(
  engine: ObservationEngine,
  ref: string,
  guards: boolean,
): Promise<{ node: ResolvedNode } | { error: string }> {
  const node = await engine.resolve(ref);
  if (node === null) {
    return { error: `drift: ref ${ref} no longer exists` };
  }
  if (guards && !node.stillMatches) {
    return { error: `drift: ref ${ref} no longer matches` };
  }
  return { node };
}

/** True when the element is a genuine submit control inside a form — the only
 *  case where the xray preflight gate applies. */
async function isSubmitControl(handle: unknown): Promise<boolean> {
  const h = handle as {
    evaluate: (fn: (el: Element) => boolean) => Promise<boolean>;
  };
  try {
    return await h.evaluate((el) => {
      const input = el as HTMLInputElement;
      const form = input.form ?? el.closest("form");
      if (!form) return false;
      const tag = el.tagName;
      // A <button>'s .type property defaults to "submit" when unset.
      return (tag === "BUTTON" || tag === "INPUT") && input.type === "submit";
    });
  } catch {
    return false;
  }
}

export function createExecutor(
  page: Page,
  engine: ObservationEngine,
  xray?: Xray,
  opts?: { guards?: boolean },
): Executor {
  const guards = opts?.guards ?? true;

  async function runBatch(actions: Action[]): Promise<BatchResult> {
    const steps: StepResult[] = [];
    let doneResult: string | undefined;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      try {
        switch (action.act) {
          case "click": {
            const resolved = await resolveGuarded(engine, action.ref, guards);
            if ("error" in resolved) {
              steps.push({ action, ok: false, error: resolved.error, driftDetected: true });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            // xray preflight gate: refuse to click a submit whose form the
            // browser itself says is invalid — report the exact violations so
            // recovery costs a replan, not a wasted submit-observe-retry loop.
            if (xray && (await isSubmitControl(resolved.node.handle))) {
              const violations = await xray.preflight(action.ref);
              if (violations.length > 0) {
                const detail = violations
                  .map((v) => `${v.ref ?? v.field}: ${v.message || v.rule}`)
                  .join("; ");
                steps.push({
                  action,
                  ok: false,
                  error: `preflight: submit blocked by browser validation — ${detail}`,
                });
                return { steps, completed: false, abortedAt: i, done: doneResult };
              }
            }
            const handle = resolved.node.handle as { click: () => Promise<void> };
            await withTimeout(handle.click(), ACTION_TIMEOUT_MS, "click");
            await settle(page);
            steps.push({ action, ok: true });
            break;
          }

          case "fill": {
            const resolved = await resolveGuarded(engine, action.ref, guards);
            if ("error" in resolved) {
              steps.push({ action, ok: false, error: resolved.error, driftDetected: true });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const handle = resolved.node.handle as { fill: (v: string) => Promise<void> };
            await withTimeout(handle.fill(action.value), ACTION_TIMEOUT_MS, "fill");
            steps.push({ action, ok: true });
            break;
          }

          case "select": {
            const resolved = await resolveGuarded(engine, action.ref, guards);
            if ("error" in resolved) {
              steps.push({ action, ok: false, error: resolved.error, driftDetected: true });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const handle = resolved.node.handle as {
              selectOption: (v: unknown) => Promise<string[]>;
            };
            try {
              await withTimeout(
                handle.selectOption({ value: action.value }),
                ACTION_TIMEOUT_MS,
                "select",
              );
            } catch {
              // fall back to matching by visible label
              await withTimeout(
                handle.selectOption({ label: action.value }),
                ACTION_TIMEOUT_MS,
                "select",
              );
            }
            steps.push({ action, ok: true });
            break;
          }

          case "pointer": {
            const resolved = await resolveGuarded(engine, action.ref, guards);
            if ("error" in resolved) {
              steps.push({ action, ok: false, error: resolved.error, driftDetected: true });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const handle = resolved.node.handle as {
              boundingBox: () => Promise<Box | null>;
            };
            const box = await withTimeout(
              handle.boundingBox(),
              ACTION_TIMEOUT_MS,
              "pointer boundingBox",
            );
            if (box === null) {
              steps.push({
                action,
                ok: false,
                error: `pointer: ref ${action.ref} has no layout box`,
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            // An out-of-bounds pointer is a model error, not something to fire
            // blind — reject rather than clicking wherever that lands.
            if (!inBounds(action.x, action.y, box)) {
              steps.push({
                action,
                ok: false,
                error: `pointer: (${action.x},${action.y}) outside ${action.ref}'s ${box.width}x${box.height} box`,
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const absX = box.x + action.x;
            const absY = box.y + action.y;
            await withTimeout(page.mouse.click(absX, absY), ACTION_TIMEOUT_MS, "pointer");
            await settle(page);
            steps.push({ action, ok: true });
            break;
          }

          case "stroke": {
            const resolved = await resolveGuarded(engine, action.ref, guards);
            if ("error" in resolved) {
              steps.push({ action, ok: false, error: resolved.error, driftDetected: true });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const handle = resolved.node.handle as {
              boundingBox: () => Promise<Box | null>;
            };
            const box = await withTimeout(
              handle.boundingBox(),
              ACTION_TIMEOUT_MS,
              "stroke boundingBox",
            );
            if (box === null) {
              steps.push({
                action,
                ok: false,
                error: `stroke: ref ${action.ref} has no layout box`,
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            if (action.path.length > MAX_STROKE_POINTS) {
              steps.push({
                action,
                ok: false,
                error: `stroke: path exceeds ${MAX_STROKE_POINTS} points`,
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            if (action.path.length < 2) {
              steps.push({
                action,
                ok: false,
                error: "stroke: path requires at least 2 points",
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const outOfBounds = action.path.find((p) => !inBounds(p.x, p.y, box));
            if (outOfBounds) {
              steps.push({
                action,
                ok: false,
                error: `stroke: (${outOfBounds.x},${outOfBounds.y}) outside ${action.ref}'s ${box.width}x${box.height} box`,
              });
              return { steps, completed: false, abortedAt: i, done: doneResult };
            }
            const [first, ...rest] = action.path;
            await withTimeout(
              page.mouse.move(box.x + first.x, box.y + first.y),
              ACTION_TIMEOUT_MS,
              "stroke move",
            );
            await withTimeout(page.mouse.down(), ACTION_TIMEOUT_MS, "stroke down");
            // Interpolation is for SPARSE paths (a 2-point drag needs
            // intermediate moves so apps see a continuous gesture). A dense
            // path already carries its own curvature — interpolating every
            // segment 4x just multiplies CDP round-trips.
            const moveSteps = action.path.length > 2 ? 1 : 4;
            for (const point of rest) {
              await withTimeout(
                page.mouse.move(box.x + point.x, box.y + point.y, { steps: moveSteps }),
                ACTION_TIMEOUT_MS,
                "stroke move",
              );
            }
            await withTimeout(page.mouse.up(), ACTION_TIMEOUT_MS, "stroke up");
            // No settle() here: strokes draw, they don't navigate, and
            // stroke-heavy workloads (hatching, handwriting) run thousands
            // per task — a per-stroke settle delay would dominate wall clock.
            // A stroke that does mutate the page is caught by the next
            // observation like any other change.
            steps.push({ action, ok: true });
            break;
          }

          case "press": {
            await withTimeout(page.keyboard.press(action.key), ACTION_TIMEOUT_MS, "press");
            steps.push({ action, ok: true });
            break;
          }

          case "scroll": {
            const amount = action.amount ?? DEFAULT_SCROLL_AMOUNT;
            const dy = action.direction === "up" ? -amount : amount;
            await withTimeout(page.mouse.wheel(0, dy), ACTION_TIMEOUT_MS, "scroll");
            steps.push({ action, ok: true });
            break;
          }

          case "goto": {
            await withTimeout(page.goto(action.url), ACTION_TIMEOUT_MS, "goto");
            engine.invalidate();
            await settle(page);
            steps.push({ action, ok: true });
            break;
          }

          case "wait": {
            const ms = Math.min(action.ms, 3000);
            await sleep(ms);
            steps.push({ action, ok: true });
            break;
          }

          case "expect": {
            if (action.ref !== undefined) {
              const resolved = await resolveGuarded(engine, action.ref, guards);
              if ("error" in resolved) {
                steps.push({ action, ok: false, error: resolved.error });
                return { steps, completed: false, abortedAt: i, done: doneResult };
              }
            }
            if (action.textContains !== undefined) {
              const content = await withTimeout(
                page.content(),
                ACTION_TIMEOUT_MS,
                "expect textContains",
              );
              if (!content.includes(action.textContains)) {
                steps.push({
                  action,
                  ok: false,
                  error: `expect failed: page does not contain "${action.textContains}"`,
                });
                return { steps, completed: false, abortedAt: i, done: doneResult };
              }
            }
            steps.push({ action, ok: true });
            break;
          }

          case "done": {
            doneResult = action.result;
            steps.push({ action, ok: true });
            const allOk = steps.every((s) => s.ok);
            return { steps, completed: allOk, done: doneResult };
          }

          default: {
            const _exhaustive: never = action;
            void _exhaustive;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({ action, ok: false, error: message });
        return { steps, completed: false, abortedAt: i, done: doneResult };
      }
    }

    const completed = steps.every((s) => s.ok);
    return { steps, completed, done: doneResult };
  }

  return { runBatch };
}
