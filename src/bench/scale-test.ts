// Scale-benchmarking runner: two brutal, measured proofs.
//
// (A) Observation-cost scaling: full-tree observation cost grows with page
//     size while diff cost stays flat, measured on a parametric heavy page
//     (fixtures/noise.html, N distractor elements below the fold) rather
//     than asserted.
// (B) A payload-cost comparison of REAL observation strategies used by other
//     frameworks, measured on the SAME pages: an actual captured screenshot
//     (Anthropic's (w*h)/750 formula on real dimensions), a raw HTML dump
//     (what naive DOM agents send), a full a11y-style tree (Astra-style, our
//     engine's full serialization), and a fasthands diff.
//
// A third section runs the real agent loop (src/agent/loop.ts) end to end
// at N=500 and N=2000 under a fulltree config vs a fasthands config, to show
// the diff advantage survives inside the loop, not just per-observation.
//
// Runnable directly: `node --experimental-strip-types src/bench/scale-test.ts`

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import type { Action, AgentConfig, Observation, OraclePolicy } from "../types.ts";
import { createObservationEngine } from "../observe/engine.ts";
import { createExecutor } from "../act/executor.ts";
import { runAgent } from "../agent/loop.ts";
import { findRef } from "./oracle.ts";
import { startFixturesServer } from "./fixtures-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "..", "..", "scale-results.json");

// Port 4623 ONLY — other benchmark processes may be using 4620/4622
// concurrently on this machine.
const FIXTURES_PORT = 4623;

// The 1280x800 "computer-use" viewport SPEC.md's screenshot baseline is
// pegged to (see src/bench/run.ts SIMULATED_IMAGE_TOKENS_PER_TURN). Fixed
// here so the screenshot-token column is measured on real captured
// dimensions rather than assumed.
const VIEWPORT = { width: 1280, height: 800 };

// Anthropic's own image-token approximation: (width * height) / 750.
const SCREENSHOT_TOKEN_DIVISOR = 750;

const SCALE_NS = [50, 200, 500, 1000, 2000];
const LOOP_NS = [500, 2000];

// ---------------------------------------------------------------------------
// (A) + (B): per-N observation payload measurements
// ---------------------------------------------------------------------------

interface ScalePoint {
  n: number;
  nodes: number;
  htmlTokens: number;
  screenshotTokens: number;
  screenshotBytes: number; // PNG bytes — NOT a token count, reported separately.
  fullTreeTokens: number; // uncapped (budget 999999): true growth curve.
  fullAtBudgetTokens: number; // budget 2000: what survives truncation.
  diffTokens: number; // after one small state change, no invalidate().
}

function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

async function measureOne(browser: Browser, n: number): Promise<ScalePoint> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page: Page = await context.newPage();
  try {
    await page.goto(`http://localhost:${FIXTURES_PORT}/noise?n=${n}`, {
      waitUntil: "domcontentloaded",
    });

    const engine = createObservationEngine(page);

    // Full tree, uncapped — the true growth curve, no truncation shaving it.
    const fullObs = await engine.observe(999_999);
    const nodes = fullObs.snapshot.nodeCount;
    const fullTreeTokens = fullObs.approxTokens;

    // A second observe() against an unchanged page would otherwise diff to
    // ~nothing, so force full again (this is exactly what the fulltree loop
    // style does every turn) and measure at the real operating budget.
    engine.invalidate();
    const fullAtBudgetObs = await engine.observe(2000);
    const fullAtBudgetTokens = fullAtBudgetObs.approxTokens;

    // One small, real state change, then a diff observation (no invalidate).
    await page.fill("#alpha", "diffcheck");
    const diffObs = await engine.observe(999_999);
    const diffTokens = diffObs.approxTokens;
    if (diffObs.kind !== "diff") {
      console.warn(`n=${n}: expected a "diff" observation after the fill, got "${diffObs.kind}".`);
    }

    const html = await page.content();
    const htmlTokens = ceilDiv(html.length, 4);

    const screenshotBuffer = await page.screenshot();
    const viewport = page.viewportSize();
    const w = viewport?.width ?? VIEWPORT.width;
    const h = viewport?.height ?? VIEWPORT.height;
    const screenshotTokens = ceilDiv(w * h, SCREENSHOT_TOKEN_DIVISOR);
    const screenshotBytes = screenshotBuffer.length;

    return {
      n,
      nodes,
      htmlTokens,
      screenshotTokens,
      screenshotBytes,
      fullTreeTokens,
      fullAtBudgetTokens,
      diffTokens,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Mini agent-loop comparison: same noise fixture, real runAgent, real
// executor — fulltree config vs fasthands config, at N=500 and N=2000.
//
// The oracle deliberately splits the task across two turns (fill Alpha+Beta,
// then fill Gamma + submit + done) instead of one big batch. Turn 1 is a
// full tree for BOTH styles regardless of `diffing` (a freshly created
// engine always sends full on its first observe()), so it proves nothing by
// itself. Turn 2 is where the styles diverge: fulltree's `diffing: false`
// forces engine.invalidate() before every observe(), so it pays for a fresh
// full tree again; fasthands takes a real diff of two changed textboxes.
// That divergence is the point of this section — it would be invisible with
// a single-turn oracle, since both styles would tie at "one full tree."
// ---------------------------------------------------------------------------

interface LoopPoint {
  n: number;
  style: "fulltree" | "fasthands";
  turns: number;
  totalObservationTokens: number;
  success: boolean;
}

function makeNoiseOracle(): OraclePolicy {
  return {
    id: "oracle",
    nextActions(_taskId: string, turn: number, observation: Observation): Action[] {
      // Oracle inspects the full live snapshot tree (never observation.text)
      // per the pattern in src/bench/oracle.ts — true even on a "diff" turn.
      const tree = observation.snapshot.tree;

      if (turn === 1) {
        const actions: Action[] = [];
        const alphaRef = findRef(tree, "textbox", "Alpha");
        const betaRef = findRef(tree, "textbox", "Beta");
        if (alphaRef) actions.push({ act: "fill", ref: alphaRef, value: "a1" });
        if (betaRef) actions.push({ act: "fill", ref: betaRef, value: "b2" });
        return actions;
      }

      const actions: Action[] = [];
      const gammaRef = findRef(tree, "textbox", "Gamma");
      const submitRef = findRef(tree, "button", "Submit noise");
      if (gammaRef) actions.push({ act: "fill", ref: gammaRef, value: "c3" });
      if (submitRef) actions.push({ act: "click", ref: submitRef });
      actions.push({ act: "done", result: "submitted noise form" });
      return actions;
    },
  };
}

async function verifyNoiseSubmitted(page: Page): Promise<boolean> {
  try {
    const headings = await page.locator("h1").allTextContents();
    return headings.some((h) => h.trim() === "Noise submitted");
  } catch {
    return false;
  }
}

const LOOP_CONFIGS: Record<"fulltree" | "fasthands", AgentConfig> = {
  fulltree: { batching: true, diffing: false, maxTurns: 10, observationBudget: 2000 },
  fasthands: { batching: true, diffing: true, maxTurns: 10, observationBudget: 2000 },
};

async function runLoopOne(
  browser: Browser,
  n: number,
  style: "fulltree" | "fasthands",
): Promise<LoopPoint> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page: Page = await context.newPage();
  try {
    await page.goto(`http://localhost:${FIXTURES_PORT}/noise?n=${n}`, {
      waitUntil: "domcontentloaded",
    });

    const engine = createObservationEngine(page);
    const executor = createExecutor(page, engine);
    const brain = makeNoiseOracle();

    const run = await runAgent({
      page,
      engine,
      executor,
      brain,
      task: {
        id: "noise",
        description: "Fill Alpha with a1, Beta with b2, Gamma with c3, then submit noise.",
      },
      config: LOOP_CONFIGS[style],
    });

    const success = await verifyNoiseSubmitted(page);
    return { n, style, turns: run.turns, totalObservationTokens: run.totalObservationTokens, success };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function printScaleTable(points: ScalePoint[]): void {
  const cols = ["N", "nodes", "html tokens", "screenshot tokens", "full tree tokens", "full@2000budget", "diff tokens"];
  const widths = [6, 7, 12, 18, 17, 16, 11];

  console.log(cols.map((c, i) => pad(c, widths[i]!)).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const p of points) {
    console.log(
      [
        padLeft(String(p.n), widths[0]!),
        padLeft(String(p.nodes), widths[1]!),
        padLeft(String(p.htmlTokens), widths[2]!),
        padLeft(String(p.screenshotTokens), widths[3]!),
        padLeft(String(p.fullTreeTokens), widths[4]!),
        padLeft(String(p.fullAtBudgetTokens), widths[5]!),
        padLeft(String(p.diffTokens), widths[6]!),
      ].join(" | "),
    );
  }
}

function printScreenshotBytesTable(points: ScalePoint[]): void {
  console.log("");
  console.log("screenshot PNG bytes (NOT tokens — raw capture size, for reference only):");
  const cols = ["N", "screenshot bytes"];
  const widths = [6, 16];
  console.log(cols.map((c, i) => pad(c, widths[i]!)).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const p of points) {
    console.log([padLeft(String(p.n), widths[0]!), padLeft(String(p.screenshotBytes), widths[1]!)].join(" | "));
  }
}

function printLoopTable(points: LoopPoint[]): void {
  console.log("");
  console.log("=== mini agent-loop comparison (real runAgent + executor, oracle policy, noise fixture) ===");
  const cols = ["N", "style", "turns", "totalObservationTokens", "success"];
  const widths = [6, 10, 6, 22, 8];
  console.log(cols.map((c, i) => pad(c, widths[i]!)).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const p of points) {
    console.log(
      [
        padLeft(String(p.n), widths[0]!),
        pad(p.style, widths[1]!),
        padLeft(String(p.turns), widths[2]!),
        padLeft(String(p.totalObservationTokens), widths[3]!),
        pad(p.success ? "PASS" : "FAIL", widths[4]!),
      ].join(" | "),
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let fixtures: { close(): void } | undefined;
  try {
    fixtures = await startFixturesServer(FIXTURES_PORT);
  } catch (err) {
    console.warn(
      `Could not start fixtures server on port ${FIXTURES_PORT} (${(err as Error).message}); ` +
        "assuming one is already running there.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  const scalePoints: ScalePoint[] = [];
  const loopPoints: LoopPoint[] = [];

  try {
    for (const n of SCALE_NS) {
      console.log(`measuring n=${n}...`);
      const point = await measureOne(browser, n);
      scalePoints.push(point);
    }

    for (const n of LOOP_NS) {
      for (const style of ["fulltree", "fasthands"] as const) {
        console.log(`running loop n=${n} style=${style}...`);
        const point = await runLoopOne(browser, n, style);
        loopPoints.push(point);
      }
    }
  } finally {
    await browser.close();
    fixtures?.close();
  }

  console.log("");
  console.log("=== observation cost scaling (fixtures/noise.html) ===");
  printScaleTable(scalePoints);
  printScreenshotBytesTable(scalePoints);
  printLoopTable(loopPoints);

  await writeFile(RESULTS_PATH, JSON.stringify({ scale: scalePoints, loopComparison: loopPoints }, null, 2));
  console.log("");
  console.log(`wrote scale results to ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("scale-test failed:", err);
  process.exit(1);
});
