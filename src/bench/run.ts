// Benchmark orchestrator. Runs all 5 tasks under all 3 loop styles and
// prints/records comparable metrics. Keyless by default (oracle policy);
// pass --provider anthropic|openai|compat --model X to drive a real model
// instead, when the relevant API key is set.
//
// `npm run bench` (see package.json) runs this file directly under
// `node --experimental-strip-types`.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import type { AgentConfig, BenchResult, LoopStyle, OraclePolicy, Provider, RunResult } from "../types.ts";
import { createObservationEngine } from "../observe/engine.ts";
import { createExecutor } from "../act/executor.ts";
import { runAgent } from "../agent/loop.ts";
import { createXray } from "../xray/xray.ts";
import { createOracle } from "./oracle.ts";
import { tasks } from "./tasks.ts";
import { startFixturesServer } from "./fixtures-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "..", "..", "bench-results.json");
const FIXTURES_PORT = 4620;

const STYLES: LoopStyle[] = ["screenshot", "fulltree", "fasthands", "xray"];

// Fairness rules (SPEC.md "Benchmark design"): the oracle gives every style
// the same competence — the loop itself, not the brain, is what changes
// batching/diffing behavior. Anthropic-style screenshot loop takes the
// known-minimum single action per turn (config.batching=false, maxTurns
// raised to compensate); the Astra-style fulltree loop gets batching but a
// forced full tree every turn (config.diffing=false); fasthands gets both
// edges. Tasks and success verifiers are identical across all three.
const STYLE_CONFIGS: Record<LoopStyle, AgentConfig> = {
  screenshot: { batching: false, diffing: false, maxTurns: 25, observationBudget: 2000 },
  fulltree: { batching: true, diffing: false, maxTurns: 15, observationBudget: 2000 },
  fasthands: { batching: true, diffing: true, maxTurns: 15, observationBudget: 2000 },
  // fasthands + the capability layer: HTML-contract annotations in the
  // observation (their tokens counted against us), preflight gate on submits.
  xray: { batching: true, diffing: true, maxTurns: 15, observationBudget: 2000 },
};

// Anthropic's own (width * height) / 750 approximation for image tokens,
// evaluated at the standard 1280x800 computer-use viewport: 1280*800/750 ≈
// 1365.3, rounded up to 1366 per screenshot. The screenshot-style loop takes
// exactly one screenshot per turn.
const SIMULATED_IMAGE_TOKENS_PER_TURN = 1366;

// ---------- CLI ----------

interface CliArgs {
  provider?: string;
  model?: string;
  baseUrl?: string;
  repeat: number;
  styles?: LoopStyle[];
  tasks?: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider") args.provider = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--base-url") args.baseUrl = argv[++i];
    else if (argv[i] === "--repeat") args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === "--styles") args.styles = argv[++i].split(",") as LoopStyle[];
    else if (argv[i] === "--tasks") args.tasks = argv[++i].split(",");
  }
  return args;
}

/** Load a real Provider from src/providers/*.ts when --provider is given and
 *  its API key is present; otherwise (including on any load/signature
 *  mismatch) fall back to the keyless oracle so `npm run bench` never hard
 *  fails. Provider modules are built by a parallel agent against the same
 *  frozen `Provider` contract but weren't available to read while this file
 *  was written; factory names below were confirmed against the actual files
 *  once they landed (createAnthropicProvider(model, apiKey?),
 *  createOpenAIProvider(model, apiKey?, baseUrl?),
 *  createCompatProvider(model, baseUrl, apiKey?)). */
async function makeBrainFactory(args: CliArgs): Promise<() => Provider | OraclePolicy> {
  if (!args.provider) return () => createOracle();

  const model = args.model ?? "default";

  try {
    switch (args.provider) {
      case "anthropic": {
        if (!process.env.ANTHROPIC_API_KEY) {
          console.warn("--provider anthropic given but ANTHROPIC_API_KEY is not set; using oracle.");
          return () => createOracle();
        }
        const { createAnthropicProvider } = await import("../providers/anthropic.ts");
        return () => createAnthropicProvider(model);
      }
      case "openai": {
        if (!process.env.OPENAI_API_KEY) {
          console.warn("--provider openai given but OPENAI_API_KEY is not set; using oracle.");
          return () => createOracle();
        }
        const { createOpenAIProvider } = await import("../providers/openai.ts");
        return () => createOpenAIProvider(model, undefined, args.baseUrl);
      }
      case "compat": {
        const baseUrl = args.baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? "http://localhost:11434/v1";
        const { createCompatProvider } = await import("../providers/compat.ts");
        return () => createCompatProvider(model, baseUrl, process.env.OPENAI_API_KEY);
      }
      default:
        console.warn(`Unknown --provider "${args.provider}"; using oracle.`);
        return () => createOracle();
    }
  } catch (err) {
    console.warn(`Failed to load provider "${args.provider}":`, (err as Error).message, "- using oracle.");
    return () => createOracle();
  }
}

// ---------- run one (task, style) cell ----------

function effectiveTokens(result: BenchResult): number {
  // For the screenshot style, the real ObservationEngine still runs under
  // the hood (the oracle needs a tree to find refs in), but that text was
  // never what a real screenshot loop would send the model — it would send
  // an image. So for reporting/comparison purposes the screenshot style's
  // observation cost is *entirely* the simulated image tokens; its text
  // tokens count as 0, per SPEC.md's benchmark design.
  return result.style === "screenshot" ? (result.simulatedImageTokens ?? 0) : result.run.totalObservationTokens;
}

async function runOne(
  browser: Browser,
  taskId: string,
  description: string,
  fixturePath: string,
  style: LoopStyle,
  makeBrain: () => Provider | OraclePolicy,
): Promise<BenchResult> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const config = STYLE_CONFIGS[style];

  let run: RunResult;
  try {
    await page.goto(`http://localhost:${FIXTURES_PORT}${fixturePath}`, { waitUntil: "domcontentloaded" });

    const engine = createObservationEngine(page);
    const xray = style === "xray" ? createXray(page) : undefined;
    const executor = createExecutor(page, engine, xray);
    const brain = makeBrain();

    const start = Date.now();
    try {
      run = await runAgent({
        page,
        engine,
        executor,
        brain,
        task: { id: taskId, description },
        config,
        xray,
      });
    } catch (err) {
      console.error(`runAgent threw for ${taskId}/${style}:`, err);
      run = {
        taskId,
        success: false,
        turns: 0,
        totalObservationTokens: 0,
        totalWallMs: Date.now() - start,
        turnLogs: [],
      };
    }

    // Ground truth: whatever the agent believes about its own success, the
    // fixture's DOM is the arbiter. Overwrite `success` with the verifier's
    // answer so a model that fabricates a `done` payload (or that quietly
    // completes the task without ever calling done) is scored correctly.
    const verified = await tasks
      .find((t) => t.id === taskId)!
      .verify(page)
      .catch(() => false);
    run = { ...run, success: verified };
  } finally {
    await context.close();
  }

  const result: BenchResult = {
    taskId,
    style,
    run,
    simulatedImageTokens: style === "screenshot" ? SIMULATED_IMAGE_TOKENS_PER_TURN * run.turns : undefined,
  };
  return result;
}

// ---------- statistics across repeats ----------

interface CellStats {
  taskId: string;
  style: LoopStyle;
  reps: number;
  successes: number;
  turns: { mean: number; sd: number };
  tokens: { mean: number; sd: number };
  wallMs: { mean: number; sd: number };
}

function meanSd(values: number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

function aggregate(results: BenchResult[]): CellStats[] {
  const cells: CellStats[] = [];
  for (const task of tasks) {
    for (const style of STYLES) {
      const rows = results.filter((r) => r.taskId === task.id && r.style === style);
      if (rows.length === 0) continue;
      cells.push({
        taskId: task.id,
        style,
        reps: rows.length,
        successes: rows.filter((r) => r.run.success).length,
        turns: meanSd(rows.map((r) => r.run.turns)),
        tokens: meanSd(rows.map((r) => effectiveTokens(r))),
        wallMs: meanSd(rows.map((r) => r.run.totalWallMs)),
      });
    }
  }
  return cells;
}

function fmtMs(v: { mean: number; sd: number }): string {
  return v.sd > 0 ? `${v.mean.toFixed(0)}±${v.sd.toFixed(0)}` : v.mean.toFixed(0);
}

function printAggregateTable(cells: CellStats[]): void {
  const widths = [10, 11, 8, 10, 14, 12];
  const cols = ["task", "style", "success", "turns", "tokens", "wall ms"];
  console.log(cols.map((c, i) => pad(c, widths[i]!)).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  let lastTask = "";
  for (const c of cells) {
    if (lastTask && c.taskId !== lastTask) console.log("");
    lastTask = c.taskId;
    console.log(
      [
        pad(c.taskId, widths[0]!),
        pad(c.style, widths[1]!),
        pad(`${c.successes}/${c.reps}`, widths[2]!),
        padLeft(fmtMs(c.turns), widths[3]!),
        padLeft(fmtMs(c.tokens), widths[4]!),
        padLeft(fmtMs(c.wallMs), widths[5]!),
      ].join(" | "),
    );
  }
}

// ---------- reporting ----------

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function printTable(results: BenchResult[]): void {
  const cols = ["task", "style", "success", "turns", "tokens", "wall ms"];
  const widths = [10, 11, 8, 6, 8, 8];

  const headerLine = cols.map((c, i) => pad(c, widths[i]!)).join(" | ");
  console.log(headerLine);
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));

  for (const task of tasks) {
    for (const style of STYLES) {
      const r = results.find((x) => x.taskId === task.id && x.style === style);
      if (!r) continue;
      const row = [
        pad(r.taskId, widths[0]!),
        pad(r.style, widths[1]!),
        pad(r.run.success ? "PASS" : "FAIL", widths[2]!),
        padLeft(String(r.run.turns), widths[3]!),
        padLeft(String(effectiveTokens(r)), widths[4]!),
        padLeft(String(r.run.totalWallMs), widths[5]!),
      ];
      console.log(row.join(" | "));
    }
    console.log("");
  }
}

interface StyleTotals {
  tokens: number;
  turns: number;
  wallMs: number;
  successes: number;
  count: number;
}

function totalsByStyle(results: BenchResult[]): Map<LoopStyle, StyleTotals> {
  const map = new Map<LoopStyle, StyleTotals>();
  for (const style of STYLES) {
    const rows = results.filter((r) => r.style === style);
    map.set(style, {
      tokens: rows.reduce((sum, r) => sum + effectiveTokens(r), 0),
      turns: rows.reduce((sum, r) => sum + r.run.turns, 0),
      wallMs: rows.reduce((sum, r) => sum + r.run.totalWallMs, 0),
      successes: rows.filter((r) => r.run.success).length,
      count: rows.length,
    });
  }
  return map;
}

function printTotals(results: BenchResult[]): void {
  const totals = totalsByStyle(results);

  console.log("=== totals per style ===");
  const widths = [11, 10, 8, 8, 10];
  console.log(
    [pad("style", widths[0]!), pad("success", widths[1]!), pad("turns", widths[2]!), pad("tokens", widths[3]!), pad("wall ms", widths[4]!)].join(
      " | ",
    ),
  );
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const style of STYLES) {
    const t = totals.get(style)!;
    console.log(
      [
        pad(style, widths[0]!),
        pad(`${t.successes}/${t.count}`, widths[1]!),
        padLeft(String(t.turns), widths[2]!),
        padLeft(String(t.tokens), widths[3]!),
        padLeft(String(t.wallMs), widths[4]!),
      ].join(" | "),
    );
  }

  console.log("");
  console.log("=== vs baselines ===");
  for (const ours of ["fasthands", "xray"] as LoopStyle[]) {
    const o = totals.get(ours);
    if (!o) continue;
    for (const baseline of ["screenshot", "fulltree"] as LoopStyle[]) {
      const b = totals.get(baseline)!;
      const tokenReduction = b.tokens > 0 ? ((b.tokens - o.tokens) / b.tokens) * 100 : 0;
      const turnReduction = b.turns > 0 ? ((b.turns - o.turns) / b.turns) * 100 : 0;
      console.log(
        `${ours} vs ${baseline}: ${tokenReduction.toFixed(1)}% fewer tokens, ${turnReduction.toFixed(1)}% fewer turns`,
      );
    }
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const makeBrain = await makeBrainFactory(args);

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
  const results: BenchResult[] = [];

  const runTasks = args.tasks ? tasks.filter((t) => args.tasks!.includes(t.id)) : tasks;
  const runStyles = args.styles ?? STYLES;
  try {
    for (let rep = 1; rep <= args.repeat; rep++) {
      if (args.repeat > 1) console.log(`--- repetition ${rep}/${args.repeat} ---`);
      for (const task of runTasks) {
        for (const style of runStyles) {
          const result = await runOne(browser, task.id, task.description, task.fixturePath, style, makeBrain);
          results.push(result);
        }
      }
    }
  } finally {
    await browser.close();
    fixtures?.close();
  }

  console.log("");
  if (args.repeat > 1) {
    printAggregateTable(aggregate(results));
  } else {
    printTable(results);
  }
  printTotals(results);
  if (args.repeat > 1) {
    console.log(`(totals aggregated over ${args.repeat} repetitions per cell)`);
  }

  await writeFile(
    RESULTS_PATH,
    JSON.stringify({ repeat: args.repeat, aggregate: aggregate(results), raw: results }, null, 2),
  );
  console.log("");
  console.log(`wrote ${results.length} results to ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("bench run failed:", err);
  process.exit(1);
});
