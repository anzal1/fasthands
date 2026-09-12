// fasthands council mode — self-consistency booster for weak/open-weight
// models (xray capability layer, see SPEC.md v0.2).
//
// Idea: fire k proposals at the same brain in parallel instead of trusting
// a single completion. Score each proposal purely against ref-resolvability
// (checked against the actual snapshot tree, so this is cheap and doesn't
// need another model call) plus a couple of cheap batch-quality heuristics,
// and take the winner. This never talks to the executor or the page — it's
// a pure scoring function over Action[] plus the snapshot the model saw.

import type { Action, ChatMessage, FHNode, Provider, Snapshot } from "../types.ts";

export interface CouncilVerdict {
  actions: Action[];
  scores: number[];
  winner: number;
  rawTexts: string[];
}

const BLOAT_THRESHOLD = 12;
const GUARD_BONUS = 0.5;
const TERMINATOR_BONUS = 1;
const VALID_REF_BONUS = 1;
const INVALID_REF_PENALTY = -2;

/** Walk the FHNode tree and collect every ref present in the snapshot. */
function collectRefs(node: FHNode, out: Set<string>): void {
  out.add(node.ref);
  if (node.children) {
    for (const child of node.children) collectRefs(child, out);
  }
}

/** The ref a single action targets, if any. Only click/fill/select always
 *  target a ref; `expect` targets one optionally. */
function refOf(action: Action): string | undefined {
  switch (action.act) {
    case "click":
    case "fill":
    case "select":
      return action.ref;
    case "expect":
      return action.ref;
    default:
      return undefined;
  }
}

/** Score one proposed batch against the snapshot the model was shown.
 *  Higher is better. An empty proposal (no actions at all — including a
 *  provider call that rejected or returned nothing) is disqualified. */
function scoreProposal(actions: Action[], validRefs: Set<string>): number {
  if (actions.length === 0) return -Infinity;

  let score = 0;
  let hasGuard = false;

  for (const action of actions) {
    const ref = refOf(action);
    if (ref !== undefined) {
      score += validRefs.has(ref) ? VALID_REF_BONUS : INVALID_REF_PENALTY;
    }
    if (action.act === "expect") hasGuard = true;
  }

  if (hasGuard) score += GUARD_BONUS;

  const last = actions[actions.length - 1];
  if (last.act === "done" || last.act === "expect") score += TERMINATOR_BONUS;

  if (actions.length > BLOAT_THRESHOLD) score -= actions.length - BLOAT_THRESHOLD;

  return score;
}

/** True if `challenger` should replace `current` as the winner: strictly
 *  higher score, or equal score with fewer actions. Because we only ever
 *  replace on a strict improvement, the first (lowest-index) proposal to
 *  reach a given score/length pair keeps the win — that's the "lowest
 *  index" tie-break, it falls out of iteration order rather than needing
 *  a separate check. */
function isBetter(
  challenger: number,
  current: number,
  scores: number[],
  actionsList: Action[][],
): boolean {
  if (scores[challenger] !== scores[current]) return scores[challenger] > scores[current];
  return actionsList[challenger].length < actionsList[current].length;
}

/** Sample k proposals from `brain` in parallel and take the best-scoring
 *  one. Used after the loop stalls (e.g. two turns with no progress) to
 *  lift weak models via self-consistency rather than a smarter single
 *  completion. */
export async function council(
  brain: Provider,
  messages: ChatMessage[],
  snapshot: Snapshot,
  k = 3,
): Promise<CouncilVerdict> {
  const validRefs = new Set<string>();
  collectRefs(snapshot.tree, validRefs);

  const settled = await Promise.allSettled(
    Array.from({ length: k }, () => brain.complete(messages)),
  );

  const actionsList: Action[][] = [];
  const rawTexts: string[] = [];
  const scores: number[] = [];

  for (const result of settled) {
    if (result.status === "rejected") {
      actionsList.push([]);
      rawTexts.push(`<council: proposal rejected: ${String(result.reason)}>`);
      scores.push(-Infinity);
      continue;
    }
    actionsList.push(result.value.actions);
    rawTexts.push(result.value.rawText);
    scores.push(scoreProposal(result.value.actions, validRefs));
  }

  let winner = 0;
  for (let i = 1; i < scores.length; i++) {
    if (isBetter(i, winner, scores, actionsList)) winner = i;
  }

  return { actions: actionsList[winner] ?? [], scores, winner, rawTexts };
}
