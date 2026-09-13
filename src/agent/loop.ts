// fasthands agent loop: observe -> plan -> guarded-batch-act, repeat.
// This is where the three architectural bets (diffing, batching, guards)
// actually get exercised end to end.

import type {
  Action,
  AgentConfig,
  ChatMessage,
  Executor,
  Observation,
  ObservationEngine,
  OraclePolicy,
  Provider,
  RunResult,
  TurnLog,
} from "../types.ts";
import type { Xray } from "../xray/xray.ts";
import { council } from "./council.ts";

/** A sense augments observations with a domain-specific annotation block —
 *  canvas command streams, 3D scene projections, pixel diffs. Annotation
 *  tokens are counted toward observationTokens like everything else. */
export interface Sense {
  annotate(): Promise<{ text: string; approxTokens: number; count: number }>;
}

const REPROMPT_TEXT =
  "Your last reply was not valid JSON. Reply with ONLY a JSON array of actions.";

function isOraclePolicy(brain: Provider | OraclePolicy): brain is OraclePolicy {
  return brain.id === "oracle";
}

/** The system prompt: explains the observation format, the Action schema,
 *  and the rules for batching/guarding. Written once per run with the task
 *  description baked in. */
const XRAY_PROMPT_SECTION = `
## xray annotations (when present)

Observations may end with an "xray:" block — facts the harness read from the
page's own HTML contract and validation engine:

  e13 · required, email format
  e15 · (hidden rule) 8+ chars incl. a digit
  e20 · → submits form (BLOCKED: 2 invalid: e13 required, e15 needs a digit)

"(hidden rule)" marks constraints that are INVISIBLE on the rendered page —
you would only discover them by failing a submit. "→" lines predict what an
action will do before you take it. Trust these facts: satisfy every rule
BEFORE clicking a submit marked BLOCKED, and pick values that already comply.
The executor will refuse to click a submit whose form is currently invalid
and will tell you exactly which fields fail, so a blocked submit never costs
you more than a replan.
`;

export function buildSystemPrompt(taskDescription: string, xrayEnabled = false): string {
  return `You are a browser automation agent. You control a web page through a
compact accessibility-tree observation and emit JSON actions; you do not see
pixels or screenshots.

## Observation format

Each turn you receive either a FULL tree or a DIFF against the tree you saw
last turn.

A full tree is a flat list of lines, one per interactive/relevant node:

  e12 button "Add to cart" [disabled]
  e13 textbox "Email"
  e14 combobox "Guests" = "2"

Each line is \`<ref> <role> "<accessible name>" [<states>] [= <value>]\`.
\`ref\` is a stable id you pass back in actions (e.g. "e12"). States like
disabled/checked/expanded/focused appear in brackets when present. Nodes
outside the current viewport may be omitted or truncated first if the
observation is over budget — scroll if you don't see what you need.

A diff has up to three sections after the first turn:

  ~ e14 combobox "Guests" = "3"      (changed: same ref, new state/value)
  + e20 button "Reserve"             (added since last turn)
  - e12 button "Add to cart"         (removed since last turn)

Refs are stable across turns as long as the underlying element is stable, so
a ref from three turns ago may still be valid — but always re-check against
the MOST RECENT observation before relying on it; the executor will refuse
to act on a ref that has drifted (changed identity) or disappeared.

## Actions

Reply with ONLY a JSON array of action objects, no prose, no markdown fence.
Every element must be one of:

  {"act": "click", "ref": "e12"}
  {"act": "fill", "ref": "e13", "value": "jane@example.com"}
  {"act": "select", "ref": "e14", "value": "3"}
  {"act": "press", "key": "Enter"}
  {"act": "scroll", "direction": "down", "amount": 600}
  {"act": "goto", "url": "https://example.com/cart"}
  {"act": "wait", "ms": 500}
  {"act": "expect", "ref": "e20"}
  {"act": "expect", "textContains": "Order placed"}
  {"act": "pointer", "ref": "e14", "x": 312, "y": 180}
  {"act": "stroke", "ref": "e14", "path": [{"x":50,"y":50},{"x":120,"y":90}]}
  {"act": "done", "result": "Booked table for 3 at 7pm, confirmation ABC123"}

pointer clicks at coordinates in CSS pixels RELATIVE to the ref element's
top-left corner — for canvases, maps, 3D scenes and anything the tree can't
target directly. stroke drags a continuous path the same way (max 64 points).
Out-of-bounds coordinates are rejected before anything fires.

## Rules

- Batch as many SAFE steps as you can into one turn's array — filling three
  form fields and clicking submit is normally one batch, not four turns.
  Batching is how we avoid burning a model round trip per click.
- Before a risky or state-changing step (submitting, navigating, deleting),
  consider prefacing it with an {"act":"expect",...} guard so the batch
  aborts cleanly instead of acting on a page that isn't what you expect.
- The executor re-resolves every ref immediately before acting on it. If a
  ref has drifted (the page changed underneath it), the batch stops right
  there and you'll get a fresh observation next turn — just look at the new
  observation and replan; you do not need to guess what happened.
- Only ever act on refs from the most recent observation you were given.
- When the task is complete, finish your action array with
  {"act": "done", "result": "<short human-readable summary of what you did>"}.
  Do not include a done action until the task is actually finished.
- If you are unsure what changed, prefer a small batch (or a single
  "expect") over a large one — cheaper to recover from a drift abort on a
  short batch than a long one.
- If the item you need is NOT in the observation, it is not on screen yet:
  scroll or navigate until it appears. NEVER act on a similar-looking
  substitute — "Order #4670" is not "Order #4711".
- Checkboxes, radios, and switches are toggled with "click". "select" is
  only for dropdown <select> elements.
- If a batch aborts, the error message tells you the exact failing step. Fix
  that step and continue the task. A failure is never a reason to emit done.
- done is a claim about the CURRENT page, not about your effort: only emit it
  when the observation in front of you already shows the goal state, and pair
  it with an expect that quotes that exact evidence.
- A scroll ends your batch: content revealed by scrolling only exists in the
  NEXT observation, so scroll, stop, and look before acting on anything new.
${xrayEnabled ? XRAY_PROMPT_SECTION : ""}
## Task

${taskDescription}`;
}

function renderObservationMessage(
  turn: number,
  observation: Observation,
  note?: string,
): ChatMessage {
  const header =
    observation.kind === "full"
      ? `Turn ${turn} — full observation (url: ${observation.snapshot.url}):`
      : `Turn ${turn} — diff observation (url: ${observation.snapshot.url}):`;
  const prefix = note ? `${note}\n` : "";
  return { role: "user", content: `${prefix}${header}\n${observation.text}` };
}

/** Ask a Provider for actions, re-prompting once if it fails to return any
 *  valid actions (per spec: append a "reply with only JSON" nudge and retry
 *  once; if still empty, give up for this turn). Mutates `history` in place
 *  so the conversation stays coherent across turns. */
async function getActionsFromProvider(
  provider: Provider,
  history: ChatMessage[],
): Promise<{ actions: Action[]; inputTokens: number; outputTokens: number }> {
  let result = await provider.complete(history);
  let inputTokens = result.usage.inputTokens;
  let outputTokens = result.usage.outputTokens;

  if (result.actions.length === 0) {
    history.push({ role: "assistant", content: result.rawText });
    history.push({ role: "user", content: REPROMPT_TEXT });
    const retry = await provider.complete(history);
    inputTokens += retry.usage.inputTokens;
    outputTokens += retry.usage.outputTokens;
    if (retry.actions.length > 0) {
      history.push({ role: "assistant", content: retry.rawText });
      return { actions: retry.actions, inputTokens, outputTokens };
    }
    history.push({ role: "assistant", content: retry.rawText });
    return { actions: [], inputTokens, outputTokens };
  }

  history.push({ role: "assistant", content: result.rawText });
  return { actions: result.actions, inputTokens, outputTokens };
}

export async function runAgent(opts: {
  page: import("playwright").Page;
  engine: ObservationEngine;
  executor: Executor;
  brain: Provider | OraclePolicy;
  task: { id: string; description: string };
  config: AgentConfig;
  /** Optional capability layer: annotates observations with HTML-contract
   *  rules and predicted consequences. Annotation tokens are counted toward
   *  observationTokens so benchmark wins survive their own cost. */
  xray?: Xray;
  /** Optional extra senses (canvas tap, 3D scene introspection, pixel diff).
   *  Each contributes an annotation block to the observation; their tokens
   *  are counted toward observationTokens like everything else. */
  senses?: Sense[];
  /** Council mode: sample this many proposals per turn in parallel and take
   *  the one whose refs all resolve and whose guard discipline scores best.
   *  Lifts small models; needs sampling diversity (set FH_TEMPERATURE > 0). */
  council?: number;
}): Promise<RunResult> {
  const { engine, executor, brain, task, config, xray } = opts;

  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(task.description, xray !== undefined) },
  ];

  const turnLogs: TurnLog[] = [];
  let success = false;
  let finalResult: string | undefined;
  let pendingNote: string | undefined;
  let doneReviewed = false;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const turnStart = Date.now();

    if (config.diffing === false) {
      // Astra-style baseline: force a full tree every turn.
      engine.invalidate();
    }

    const observation = await engine.observe(config.observationBudget);

    if (xray) {
      const refs = [...new Set(observation.text.match(/\be\d+\b/g) ?? [])];
      const annotations = await xray.annotate(refs);
      if (annotations.count > 0) {
        observation.text += `\n\n${annotations.text}`;
        observation.approxTokens += annotations.approxTokens;
      }
    }

    for (const sense of opts.senses ?? []) {
      try {
        const a = await sense.annotate();
        if (a.count > 0) {
          observation.text += `\n\n${a.text}`;
          observation.approxTokens += a.approxTokens;
        }
      } catch {
        // A sense that fails this turn (tainted canvas, no scene yet) just
        // contributes nothing; the base observation stands on its own.
      }
    }

    history.push(renderObservationMessage(turn, observation, pendingNote));
    pendingNote = undefined;

    let actions: Action[];
    if (isOraclePolicy(brain)) {
      actions = brain.nextActions(task.id, turn, observation);
    } else if (opts.council && opts.council > 1) {
      const verdict = await council(brain, history, observation.snapshot, opts.council);
      if (verdict.actions.length > 0) {
        history.push({ role: "assistant", content: verdict.rawTexts[verdict.winner] ?? "" });
        actions = verdict.actions;
      } else {
        const got = await getActionsFromProvider(brain, history);
        actions = got.actions;
      }
    } else {
      const got = await getActionsFromProvider(brain, history);
      actions = got.actions;
    }

    if (config.batching === false && actions.length > 1) {
      // screenshot-baseline mode: one action per turn, no batching credit.
      actions = actions.slice(0, 1);
    }

    let actionsCompleted = 0;
    if (actions.length > 0) {
      const batchResult = await executor.runBatch(actions);
      actionsCompleted = batchResult.steps.filter((s) => s.ok).length;

      if (batchResult.done !== undefined && config.reviewDone && !isOraclePolicy(brain) && !doneReviewed) {
        // Done-review gate: don't accept the first done — bounce it back
        // against a fresh observation with the task text. A model that was
        // right re-affirms for one extra turn; a model that hallucinated
        // completion gets confronted with the contradiction instead of
        // silently failing the task.
        doneReviewed = true;
        pendingNote =
          `REVIEW before finishing. The task is: "${task.description}". ` +
          `You claimed: "${batchResult.done}". Check the observation below carefully: ` +
          `if the goal is not ACTUALLY visible on the page, keep working on the task; ` +
          `only emit done again if the goal is truly achieved.`;
        turnLogs.push({
          turn,
          observationTokens: observation.approxTokens,
          observationKind: observation.kind,
          actionsPlanned: actions.length,
          actionsCompleted,
          wallMs: Date.now() - turnStart,
        });
        continue;
      }

      if (batchResult.done !== undefined) {
        success = true;
        finalResult = batchResult.done;

        turnLogs.push({
          turn,
          observationTokens: observation.approxTokens,
          observationKind: observation.kind,
          actionsPlanned: actions.length,
          actionsCompleted,
          wallMs: Date.now() - turnStart,
        });
        break;
      }
      // Drift aborts (and any other batch failure) do NOT fail the run —
      // we just fall through to the next turn and get a fresh observation,
      // carrying a note about what aborted so the model can replan precisely.
      if (!batchResult.completed && batchResult.abortedAt !== undefined) {
        const failed = batchResult.steps[batchResult.abortedAt];
        pendingNote = `Previous batch aborted at step ${batchResult.abortedAt + 1} of ${actions.length}: ${failed?.error ?? "unknown error"}.`;
      }
    }

    turnLogs.push({
      turn,
      observationTokens: observation.approxTokens,
      observationKind: observation.kind,
      actionsPlanned: actions.length,
      actionsCompleted,
      wallMs: Date.now() - turnStart,
    });
  }

  // FH_DEBUG_DIR: dump the full conversation per run for postmortems on
  // live-model behavior. Off unless the env var is set.
  if (process.env.FH_DEBUG_DIR) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(process.env.FH_DEBUG_DIR, { recursive: true });
    const name = `${task.id}-b${config.batching ? 1 : 0}d${config.diffing ? 1 : 0}${xray ? "x" : ""}.json`;
    writeFileSync(
      `${process.env.FH_DEBUG_DIR}/${name}`,
      JSON.stringify({ success, turns: turnLogs.length, history }, null, 1),
    );
  }

  const totalObservationTokens = turnLogs.reduce((sum, t) => sum + t.observationTokens, 0);
  const totalWallMs = turnLogs.reduce((sum, t) => sum + t.wallMs, 0);

  return {
    taskId: task.id,
    success,
    result: finalResult,
    turns: turnLogs.length,
    totalObservationTokens,
    totalWallMs,
    turnLogs,
  };
}
