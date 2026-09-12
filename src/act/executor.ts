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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *  throws (a page that never reaches domcontentloaded just times out). */
async function settle(page: Page): Promise<void> {
  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    sleep(SETTLE_CAP_MS),
  ]);
  await sleep(SETTLE_DELAY_MS);
}

/** Resolve a ref via the engine and require it to still match what the model
 *  last saw. Returns the ResolvedNode on success, or an error string
 *  describing the drift/absence for the caller to record. */
async function resolveGuarded(
  engine: ObservationEngine,
  ref: string,
): Promise<{ node: ResolvedNode } | { error: string }> {
  const node = await engine.resolve(ref);
  if (node === null) {
    return { error: `drift: ref ${ref} no longer exists` };
  }
  if (!node.stillMatches) {
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

export function createExecutor(page: Page, engine: ObservationEngine, xray?: Xray): Executor {
  async function runBatch(actions: Action[]): Promise<BatchResult> {
    const steps: StepResult[] = [];
    let doneResult: string | undefined;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      try {
        switch (action.act) {
          case "click": {
            const resolved = await resolveGuarded(engine, action.ref);
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
            const resolved = await resolveGuarded(engine, action.ref);
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
            const resolved = await resolveGuarded(engine, action.ref);
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
              const resolved = await resolveGuarded(engine, action.ref);
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
