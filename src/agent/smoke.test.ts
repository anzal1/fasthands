// Plain smoke script (no test framework) for the systems-eng deliverables:
// executor, agent loop, provider parsing. Run with:
//   node --experimental-strip-types src/agent/smoke.test.ts
// Exits 0 on all pass, 1 on any failure. No network, no real Playwright.

import type {
  Action,
  Observation,
  ObservationEngine,
  OraclePolicy,
  ResolvedNode,
  Snapshot,
} from "../types.ts";
import { createExecutor } from "../act/executor.ts";
import { runAgent } from "./loop.ts";
import { parseActions } from "../providers/shared.ts";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok:   ${message}`);
  }
}

// ---------- shared fakes ----------

function makeSnapshot(url = "http://localhost:4620/fixture"): Snapshot {
  return {
    url,
    title: "fixture",
    tree: { ref: "e0", role: "body", name: "", inViewport: true, children: [] },
    nodeCount: 1,
    capturedAt: Date.now(),
  };
}

function makeObservation(text = "e1 button \"Go\"\ne2 textbox \"Name\""): Observation {
  return {
    kind: "full",
    text,
    snapshot: makeSnapshot(),
    approxTokens: Math.ceil(text.length / 4),
  };
}

/** Minimal fake Page: only the surface executor.ts actually touches. */
function makeFakePage() {
  return {
    waitForLoadState: async () => undefined,
    keyboard: { press: async (_key: string) => undefined },
    mouse: { wheel: async (_x: number, _y: number) => undefined },
    goto: async (_url: string) => undefined,
    content: async () => "<html><body>ok</body></html>",
  };
}

// ---------- (1) executor aborts batch on drift ----------

async function testExecutorDriftAbort(): Promise<void> {
  let clickCalled = false;

  const fakeEngine: ObservationEngine = {
    observe: async () => makeObservation(),
    invalidate: () => undefined,
    resolve: async (ref: string): Promise<ResolvedNode | null> => ({
      ref,
      handle: {
        click: async () => {
          clickCalled = true;
        },
      },
      stillMatches: false, // drift: the model's ref no longer matches the live page
    }),
  };

  const executor = createExecutor(makeFakePage() as unknown as import("playwright").Page, fakeEngine);
  const result = await executor.runBatch([{ act: "click", ref: "e1" }]);

  assert(clickCalled === false, "executor: drifted ref never gets clicked");
  assert(result.completed === false, "executor: batch with drift is not completed");
  assert(result.abortedAt === 0, "executor: abortedAt points at the drifted step");
  assert(result.steps[0].ok === false, "executor: drifted step is not ok");
  assert(result.steps[0].driftDetected === true, "executor: drifted step flags driftDetected");
}

// ---------- (2) loop completes a 2-turn task via OraclePolicy ----------

async function testLoopTwoTurnOracle(): Promise<void> {
  const fakeEngine: ObservationEngine = {
    observe: async () => makeObservation(),
    invalidate: () => undefined,
    resolve: async (ref: string): Promise<ResolvedNode | null> => ({
      ref,
      handle: {
        click: async () => undefined,
      },
      stillMatches: true,
    }),
  };

  const executor = createExecutor(makeFakePage() as unknown as import("playwright").Page, fakeEngine);

  const oracle: OraclePolicy = {
    id: "oracle",
    nextActions(_taskId: string, turn: number, _observation: Observation): Action[] {
      if (turn === 1) return [{ act: "click", ref: "e1" }];
      return [{ act: "done", result: "finished" }];
    },
  };

  const result = await runAgent({
    page: makeFakePage() as unknown as import("playwright").Page,
    engine: fakeEngine,
    executor,
    brain: oracle,
    task: { id: "t1", description: "click the button then finish" },
    config: { maxTurns: 5, observationBudget: 2000, batching: true, diffing: true },
  });

  assert(result.turns === 2, `loop: expected 2 turns, got ${result.turns}`);
  assert(result.success === true, "loop: run succeeds via done action");
  assert(result.result === "finished", "loop: RunResult.result carries the done payload");
  assert(
    result.totalObservationTokens > 0,
    "loop: totalObservationTokens sums observation approxTokens",
  );
}

// ---------- (3) provider parser ----------

function testProviderParser(): void {
  const fenced = "```json\n[{\"act\":\"click\",\"ref\":\"e1\"}]\n```";
  const parsedFenced = parseActions(fenced);
  assert(parsedFenced.length === 1, "parser: fenced JSON array parses to 1 action");
  assert(
    parsedFenced[0]?.act === "click" && (parsedFenced[0] as { ref: string }).ref === "e1",
    "parser: fenced JSON action shape is preserved",
  );

  const garbage = "sorry, I can't help with that right now.";
  const parsedGarbage = parseActions(garbage);
  assert(parsedGarbage.length === 0, "parser: garbage input returns []");

  const trailingComma = '[{"act":"wait","ms":100},]';
  const parsedRepaired = parseActions(trailingComma);
  assert(parsedRepaired.length === 1, "parser: trailing-comma JSON gets repaired and parses");
  assert(
    parsedRepaired[0]?.act === "wait" && (parsedRepaired[0] as { ms: number }).ms === 100,
    "parser: repaired action shape is preserved",
  );
}

// ---------- run ----------

async function main(): Promise<void> {
  await testExecutorDriftAbort();
  await testLoopTwoTurnOracle();
  testProviderParser();

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nall smoke checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("smoke test threw:", err);
  process.exit(1);
});
