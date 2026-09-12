// The "drift trap": a brutal, reproducible proof that guarded execution
// prevents catastrophic misclicks that unguarded batching commits.
//
// Targets the exact failure mode Astra-style loops admit: state drift
// between observation and action. The /drift fixture silently swaps the
// row for "message 3" into the destructive "Delete all messages" control
// 800ms after load — same DOM node, new identity, exactly the mechanic
// src/observe/engine.ts's contentHash is built to catch via resolve().
//
// For each of two arms (guarded / unguarded executor), run R independent
// trials: observe once (before the swap), wait past the swap, then fire a
// single-action batch at the ref captured before drift. Guarded executors
// must re-resolve and abort on hash mismatch; unguarded executors use the
// stale handle regardless — clicking whatever now lives at that ref.
//
// Run: node --experimental-strip-types src/bench/drift-test.ts

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { startFixturesServer } from "./fixtures-server.ts";
import { createObservationEngine } from "../observe/engine.ts";
import { createExecutor } from "../act/executor.ts";
import type { FHNode } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "..", "..", "drift-results.json");

const PORT = 4622;
const TRIALS = 20;
const TARGET_NAME = "Archive message 3";

type Classification = "SAFE_ABORT" | "CORRECT" | "CATASTROPHE" | "OTHER";

interface TrialResult {
  trial: number;
  classification: Classification;
  recovered?: boolean;
  detail: string;
}

interface ArmSummary {
  arm: "guarded" | "unguarded";
  trials: number;
  catastrophes: number;
  catastrophePct: number;
  safeAborts: number;
  recovered: number;
  correct: number;
  other: number;
  trialResults: TrialResult[];
}

/** Depth-first search for the ref of the node with an exact accessible name. */
function findRefByName(node: FHNode, name: string): string | null {
  if (node.name === name) return node.ref;
  for (const child of node.children ?? []) {
    const found = findRefByName(child, name);
    if (found) return found;
  }
  return null;
}

/** Read #outcome's text content, or null if it hasn't been set yet. */
async function readOutcome(page: Page): Promise<string | null> {
  const text = await page
    .$eval("#outcome", (el) => (el as HTMLElement).textContent?.trim() ?? "")
    .catch(() => "");
  return text ? text : null;
}

async function runOneTrial(browser: Browser, guards: boolean): Promise<TrialResult> {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`http://localhost:${PORT}/drift`);

    const engine = createObservationEngine(page);
    const executor = createExecutor(page, engine, undefined, { guards });

    // Observation #1: taken before the 800ms trap fires. Whatever ref names
    // "Archive message 3" here is what a real agent would batch a click
    // against.
    const obs = await engine.observe();
    const ref = findRefByName(obs.snapshot.tree, TARGET_NAME);
    if (!ref) {
      return {
        trial: 0,
        classification: "OTHER",
        detail: `ref for "${TARGET_NAME}" not found in first observation`,
      };
    }

    // Wait past the swap. #swap-done doesn't exist in the DOM until the
    // fixture's one-shot timer fires, so this resolves right after the trap
    // springs; the timeout is purely a fallback in case something's wrong.
    await page.waitForSelector("#swap-done", { timeout: 1000 }).catch(() => undefined);

    // Fire the batch against the pre-swap ref. Guarded executors re-resolve
    // and check the hash; unguarded executors use the (now wrong) handle.
    const result = await executor.runBatch([{ act: "click", ref }]);
    const outcome = await readOutcome(page);

    const drifted = result.steps.some((s) => s.driftDetected);

    if (!result.completed && drifted) {
      if (!guards) {
        // Shouldn't happen: the ablation arm never fails on mismatch, only
        // on a fully-vanished node. Report it rather than assume it away.
        return {
          trial: 0,
          classification: "OTHER",
          detail: `unguarded arm unexpectedly aborted on drift: ${result.steps[0]?.error}`,
        };
      }

      // Guarded refusal. Model what the real loop does next: re-observe,
      // re-find the target by name, click again.
      const obs2 = await engine.observe();
      const ref2 = findRefByName(obs2.snapshot.tree, TARGET_NAME);
      let recovered = false;
      let recoverDetail = "no ref found on re-observation";
      if (ref2) {
        const result2 = await executor.runBatch([{ act: "click", ref: ref2 }]);
        const outcome2 = await readOutcome(page);
        recovered = result2.completed && outcome2 === "archived-3";
        recoverDetail = `recover outcome=${outcome2 ?? "none"}, completed=${result2.completed}`;
      }

      return {
        trial: 0,
        classification: "SAFE_ABORT",
        recovered,
        detail: `aborted: ${result.steps[0]?.error}; ${recoverDetail}`,
      };
    }

    if (!result.completed) {
      return {
        trial: 0,
        classification: "OTHER",
        detail: `batch failed for a non-drift reason: ${JSON.stringify(result.steps)}`,
      };
    }

    if (outcome === "DESTROYED") {
      return {
        trial: 0,
        classification: "CATASTROPHE",
        detail: "clicked the swapped-in destructive control (or bottom delete-all)",
      };
    }
    if (outcome === "archived-3") {
      return { trial: 0, classification: "CORRECT", detail: "archived the real message 3" };
    }
    return {
      trial: 0,
      classification: "OTHER",
      detail: `unexpected outcome: ${outcome ?? "none"} (completed=${result.completed})`,
    };
  } finally {
    await context.close();
  }
}

async function runArm(browser: Browser, arm: "guarded" | "unguarded"): Promise<ArmSummary> {
  const guards = arm === "guarded";
  const trialResults: TrialResult[] = [];

  for (let i = 0; i < TRIALS; i++) {
    const r = await runOneTrial(browser, guards);
    trialResults.push({ ...r, trial: i + 1 });
  }

  let catastrophes = 0;
  let safeAborts = 0;
  let recovered = 0;
  let correct = 0;
  let other = 0;

  for (const r of trialResults) {
    switch (r.classification) {
      case "CATASTROPHE":
        catastrophes++;
        break;
      case "SAFE_ABORT":
        safeAborts++;
        if (r.recovered) recovered++;
        break;
      case "CORRECT":
        correct++;
        break;
      case "OTHER":
        other++;
        break;
    }
  }

  return {
    arm,
    trials: TRIALS,
    catastrophes,
    catastrophePct: (catastrophes / TRIALS) * 100,
    safeAborts,
    recovered,
    correct,
    other,
    trialResults,
  };
}

function printTable(summaries: ArmSummary[]): void {
  const headers = ["arm", "trials", "catastrophes", "catastrophe %", "safe aborts", "recovered", "correct"];
  const rows = summaries.map((s) => [
    s.arm,
    String(s.trials),
    String(s.catastrophes),
    `${s.catastrophePct.toFixed(1)}%`,
    String(s.safeAborts),
    String(s.recovered),
    String(s.correct),
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join(" | ");

  console.log("");
  console.log(fmt(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of rows) console.log(fmt(row));

  const anyOther = summaries.some((s) => s.other > 0);
  if (anyOther) {
    console.log("");
    for (const s of summaries) {
      if (s.other > 0) {
        console.log(`note: ${s.arm} arm had ${s.other} OTHER-classified trial(s), see drift-results.json`);
      }
    }
  }
}

async function main(): Promise<void> {
  const server = await startFixturesServer(PORT);
  const browser = await chromium.launch({ headless: true });

  try {
    const guarded = await runArm(browser, "guarded");
    const unguarded = await runArm(browser, "unguarded");
    const summaries = [guarded, unguarded];

    printTable(summaries);

    await writeFile(RESULTS_PATH, JSON.stringify(summaries, null, 2));
    console.log(`\nfull results written to ${RESULTS_PATH}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("drift-test threw:", err);
  process.exit(1);
});
