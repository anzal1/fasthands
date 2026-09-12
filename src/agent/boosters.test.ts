// Plain smoke script (no test framework) for the xray booster deliverables:
// council mode and the reflex cache. Run with:
//   node --experimental-strip-types src/agent/boosters.test.ts
// Exits 0 on all pass, 1 on any failure. No network, no Playwright.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, ChatMessage, FHNode, Provider, Snapshot } from "../types.ts";
import { council } from "./council.ts";
import { createReflexStore } from "./reflex.ts";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok:   ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================================
// council
// =====================================================================

/** Snapshot fixture: a body with five interactive children, refs e1..e5. */
function makeSnapshot(): Snapshot {
  const tree: FHNode = {
    ref: "root",
    role: "body",
    name: "",
    inViewport: true,
    children: [
      { ref: "e1", role: "textbox", name: "Full name", inViewport: true },
      { ref: "e2", role: "textbox", name: "Email", inViewport: true },
      { ref: "e3", role: "combobox", name: "Guests", inViewport: true },
      { ref: "e4", role: "textbox", name: "Date", inViewport: true },
      { ref: "e5", role: "button", name: "Reserve", inViewport: true },
    ],
  };
  return { url: "http://localhost:4620/form", title: "Book a table", tree, nodeCount: 6, capturedAt: Date.now() };
}

const FAKE_MESSAGES: ChatMessage[] = [{ role: "system", content: "test" }];

type CannedResponse = { actions: Action[]; rawText: string } | Error;

/** A Provider whose complete() returns queued canned responses, one per
 *  call, in call order. Each call sleeps briefly so a test can prove the
 *  k calls actually ran in parallel rather than serially. */
function makeFakeProvider(queue: CannedResponse[], delayMs = 20): { provider: Provider; callCount: () => number } {
  let calls = 0;
  const provider: Provider = {
    id: "fake",
    model: "fake-model-1",
    async complete(_messages: ChatMessage[]) {
      const index = calls;
      calls++;
      await sleep(delayMs);
      const item = queue[index];
      if (item === undefined) throw new Error(`fake provider: no queued response for call ${index}`);
      if (item instanceof Error) throw item;
      return { actions: item.actions, rawText: item.rawText, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { provider, callCount: () => calls };
}

async function testCouncilBogusRefLoses(): Promise<void> {
  const snapshot = makeSnapshot();

  const bogus: CannedResponse = {
    actions: [
      { act: "click", ref: "e1" },
      { act: "fill", ref: "e2", value: "jane@example.com" },
      { act: "click", ref: "e99" }, // does not exist
    ],
    rawText: "bogus",
  };
  const clean: CannedResponse = {
    actions: [
      { act: "click", ref: "e1" },
      { act: "fill", ref: "e2", value: "jane@example.com" },
      { act: "done", result: "booked" },
    ],
    rawText: "clean",
  };
  const empty: CannedResponse = { actions: [], rawText: "" };

  const { provider } = makeFakeProvider([bogus, clean, empty]);
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, 3);

  assert(verdict.winner === 1, `council: clean proposal (index 1) wins, got winner=${verdict.winner}`);
  assert(verdict.scores[0] < verdict.scores[1], "council: bogus-ref proposal scores lower than clean proposal");
  assert(verdict.scores[1] === 3, `council: clean proposal scores +1+1+1(done end)=3, got ${verdict.scores[1]}`);
  assert(verdict.actions[verdict.actions.length - 1]?.act === "done", "council: winning actions end with done");
}

async function testCouncilEmptyNeverWins(): Promise<void> {
  const snapshot = makeSnapshot();

  const empty: CannedResponse = { actions: [], rawText: "" };
  const rejected: CannedResponse = new Error("provider blew up");
  const mediocre: CannedResponse = {
    actions: [{ act: "click", ref: "e1" }],
    rawText: "mediocre",
  };

  const { provider } = makeFakeProvider([empty, rejected, mediocre]);
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, 3);

  assert(verdict.scores[0] === -Infinity, "council: empty proposal scores -Infinity");
  assert(verdict.scores[1] === -Infinity, "council: rejected proposal scores -Infinity");
  assert(verdict.winner === 2, `council: only non-empty, non-rejected proposal wins, got winner=${verdict.winner}`);
  assert(verdict.actions.length === 1, "council: winning actions come from the surviving proposal");
}

async function testCouncilAllEmptyStillPicksSomething(): Promise<void> {
  const snapshot = makeSnapshot();
  const { provider } = makeFakeProvider([
    { actions: [], rawText: "" },
    new Error("boom"),
  ]);
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, 2);
  assert(verdict.scores.every((s) => s === -Infinity), "council: all-empty field scores all -Infinity");
  assert(verdict.actions.length === 0, "council: all-empty field returns an empty winning batch, not a crash");
}

async function testCouncilGuardBreaksTie(): Promise<void> {
  const snapshot = makeSnapshot();

  // Without the guard bonus these two would score identically: 3 ref hits
  // (each +1) plus the trailing-done bonus (+1) = 4. The only thing that
  // separates them is the +0.5 guard bonus on the one using `expect`.
  const noGuard: CannedResponse = {
    actions: [
      { act: "click", ref: "e1" },
      { act: "click", ref: "e2" },
      { act: "click", ref: "e3" },
      { act: "done", result: "done" },
    ],
    rawText: "no-guard",
  };
  const withGuard: CannedResponse = {
    actions: [
      { act: "expect", ref: "e1" },
      { act: "click", ref: "e2" },
      { act: "click", ref: "e3" },
      { act: "done", result: "done" },
    ],
    rawText: "with-guard",
  };

  const { provider } = makeFakeProvider([noGuard, withGuard]);
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, 2);

  assert(verdict.scores[0] === 4, `council: no-guard batch scores 4, got ${verdict.scores[0]}`);
  assert(verdict.scores[1] === 4.5, `council: guarded batch scores 4.5 (4 + 0.5 guard bonus), got ${verdict.scores[1]}`);
  assert(verdict.winner === 1, "council: guard bonus breaks the tie in favor of the guarded batch");
}

async function testCouncilTieBreaksOnFewerActionsThenIndex(): Promise<void> {
  const snapshot = makeSnapshot();

  // Two proposals score identically (2 valid refs, no guard, no terminator)
  // but the second is shorter -> it should win on the fewer-actions rule.
  const longer: CannedResponse = {
    actions: [
      { act: "click", ref: "e1" },
      { act: "click", ref: "e2" },
      { act: "press", key: "Tab" }, // no ref, no score effect
      { act: "press", key: "Tab" },
    ],
    rawText: "longer",
  };
  const shorter: CannedResponse = {
    actions: [
      { act: "click", ref: "e1" },
      { act: "click", ref: "e2" },
    ],
    rawText: "shorter",
  };

  const { provider } = makeFakeProvider([longer, shorter]);
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, 2);

  assert(verdict.scores[0] === verdict.scores[1], "council: both proposals score identically on ref hits");
  assert(verdict.winner === 1, "council: shorter proposal wins the tie-break on action count");
}

async function testCouncilParallelism(): Promise<void> {
  const snapshot = makeSnapshot();
  const k = 4;
  const delayMs = 30;
  const queue: CannedResponse[] = Array.from({ length: k }, (_, i) => ({
    actions: [{ act: "click", ref: "e1" }],
    rawText: `proposal-${i}`,
  }));
  const { provider, callCount } = makeFakeProvider(queue, delayMs);

  const start = Date.now();
  const verdict = await council(provider, FAKE_MESSAGES, snapshot, k);
  const elapsed = Date.now() - start;

  assert(callCount() === k, `council: all k=${k} proposals were requested, got ${callCount()}`);
  assert(verdict.rawTexts.length === k, `council: verdict carries all ${k} raw texts`);
  // Serial execution would take >= k * delayMs; parallel should land well
  // under that (generous slack for CI jitter).
  assert(
    elapsed < k * delayMs,
    `council: k calls ran in parallel (elapsed ${elapsed}ms < serial floor ${k * delayMs}ms)`,
  );
}

// =====================================================================
// reflex
// =====================================================================

function testReflexRoundtripAndInvalidate(): void {
  const dir = mkdtempSync(join(tmpdir(), "fasthands-reflex-"));
  const filePath = join(dir, "reflex.json");
  const origin = "http://localhost:4620";

  const store1 = createReflexStore(filePath);
  assert(store1.lookup(origin, "Book a table") === null, "reflex: fresh store has no entry");

  const turns: Action[][] = [
    [{ act: "fill", ref: "e1", value: "Jane" }, { act: "fill", ref: "e2", value: "jane@example.com" }],
    [{ act: "click", ref: "e5" }, { act: "done", result: "booked" }],
  ];
  store1.record(origin, "Book a table", turns);
  store1.save();

  const store2 = createReflexStore(filePath);
  const found = store2.lookup(origin, "Book a table");
  assert(found !== null, "reflex: roundtrip lookup finds the recorded trace after save + reload");
  assert(found?.turns.length === 2, "reflex: recorded turns roundtrip through save/load intact");
  assert(found?.successes === 1, "reflex: first record sets successes to 1");
  assert(found?.origin === origin, "reflex: origin roundtrips");

  // normalization: case + extra whitespace still hits the same entry
  const normalized = store2.lookup(origin, "Book  a TABLE");
  assert(normalized !== null, "reflex: normalized lookup (case/whitespace) matches the same entry");
  assert(normalized?.taskKey === found?.taskKey, "reflex: normalized description produces the same taskKey");

  // recording again against the reloaded store increments successes
  store2.record(origin, "book a table", turns);
  const again = store2.lookup(origin, "Book a table");
  assert(again?.successes === 2, "reflex: re-recording an existing task increments successes");

  // invalidate removes the entry
  store2.invalidate(origin, "Book a table");
  assert(store2.lookup(origin, "Book a table") === null, "reflex: invalidate removes the entry");

  // and the removal is not visible to a store created before the invalidate
  // (each store only reflects what it loaded / recorded itself) — sanity,
  // not a requirement, so just confirm store2 itself no longer has it after
  // a fresh reload once saved.
  store2.save();
  const store3 = createReflexStore(filePath);
  assert(store3.lookup(origin, "Book a table") === null, "reflex: invalidate persists across save/reload");
}

function testReflexCorruptFileTolerated(): void {
  const dir = mkdtempSync(join(tmpdir(), "fasthands-reflex-corrupt-"));
  const filePath = join(dir, "reflex.json");
  writeFileSync(filePath, "{ this is not : valid json ][", "utf8");

  let store: ReturnType<typeof createReflexStore> | undefined;
  let threw = false;
  try {
    store = createReflexStore(filePath);
  } catch {
    threw = true;
  }

  assert(!threw, "reflex: corrupt file does not throw on load");
  assert(store !== undefined && store.lookup("http://x", "anything") === null, "reflex: corrupt file tolerated, store starts empty");
}

function testReflexMissingFileTolerated(): void {
  const dir = mkdtempSync(join(tmpdir(), "fasthands-reflex-missing-"));
  const filePath = join(dir, "nested", "reflex.json"); // parent dir doesn't exist yet either

  const store = createReflexStore(filePath);
  assert(store.lookup("http://x", "anything") === null, "reflex: missing file tolerated, store starts empty");

  store.record("http://x", "do a thing", [[{ act: "done", result: "ok" }]]);
  store.save(); // must create the nested directory
  const reloaded = createReflexStore(filePath);
  assert(reloaded.lookup("http://x", "do a thing") !== null, "reflex: save() creates missing parent directories");
}

// =====================================================================
// run
// =====================================================================

async function main(): Promise<void> {
  await testCouncilBogusRefLoses();
  await testCouncilEmptyNeverWins();
  await testCouncilAllEmptyStillPicksSomething();
  await testCouncilGuardBreaksTie();
  await testCouncilTieBreaksOnFewerActionsThenIndex();
  await testCouncilParallelism();

  testReflexRoundtripAndInvalidate();
  testReflexCorruptFileTolerated();
  testReflexMissingFileTolerated();

  if (failures > 0) {
    console.error(`\n${failures} booster check(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nall booster checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("boosters test threw:", err);
  process.exit(1);
});
