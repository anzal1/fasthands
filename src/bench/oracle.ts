// Deterministic scripted policy standing in for a competent model, so
// `npm run bench` is reproducible with zero API keys.
//
// CRITICAL DESIGN NOTE: this never hardcodes refs or turn numbers as a
// dispatch key. Every script inspects the CURRENT observation.snapshot.tree
// (always the full live snapshot, even when observation.kind === "diff" —
// see the Observation contract in types.ts) and decides what to do next
// purely from visible DOM state:
//   - "is the success text/element already present?" -> done
//   - "which fields still don't match the target value?" -> fill just those
//   - "which control isn't findable yet?" -> scroll to make progress
//
// This matters because the agent loop truncates a batch to its first action
// for the screenshot baseline (config.batching === false — see
// src/agent/loop.ts). If a script returned a fixed, hardcoded action list per
// (taskId, turn), the screenshot style would replay the same first action
// forever once turns stop lining up with script indices (e.g. re-clicking a
// toggle switch back off, or re-typing into an already-filled field that
// then gets re-submitted early). Because every script here re-derives its
// batch from live element values/state each call, it naturally degrades to
// "one action of real progress per call" under truncation and to "the full
// ideal batch in one round trip" under batching — both from the exact same
// function. That's what "the oracle gives every style the same competence"
// means in practice.

import type { Action, FHNode, Observation, OraclePolicy } from "../types.ts";
import { FIXTURE_DATA } from "./tasks.ts";

// ---------- generic tree search helpers ----------

function flatten(node: FHNode, acc: FHNode[] = []): FHNode[] {
  acc.push(node);
  for (const child of node.children ?? []) flatten(child, acc);
  return acc;
}

/** Find the first node matching an exact role and a case-insensitive
 *  substring of its accessible name. */
export function findNode(tree: FHNode, role: string, nameIncludes: string): FHNode | null {
  const roleLower = role.toLowerCase();
  const needle = nameIncludes.toLowerCase();
  const visit = (node: FHNode): FHNode | null => {
    if ((node.role ?? "").toLowerCase() === roleLower && (node.name ?? "").toLowerCase().includes(needle)) {
      return node;
    }
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(tree);
}

export function findRef(tree: FHNode, role: string, nameIncludes: string): string | null {
  return findNode(tree, role, nameIncludes)?.ref ?? null;
}

/** All matches for a role + name substring, in document order. */
export function findAllRefs(tree: FHNode, role: string, nameIncludes: string): string[] {
  const roleLower = role.toLowerCase();
  const needle = nameIncludes.toLowerCase();
  const out: string[] = [];
  const visit = (node: FHNode) => {
    if ((node.role ?? "").toLowerCase() === roleLower && (node.name ?? "").toLowerCase().includes(needle)) {
      out.push(node.ref);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return out;
}

/** Same as findNode/findRef but tries a list of candidate roles in order.
 *  Used where the accessible role a not-yet-built ObservationEngine assigns
 *  to a given tag is ambiguous from the frozen contract alone (e.g. a native
 *  <select> could plausibly surface as "combobox" or "listbox"). */
function findNodeAny(tree: FHNode, roles: string[], nameIncludes: string): FHNode | null {
  for (const role of roles) {
    const node = findNode(tree, role, nameIncludes);
    if (node) return node;
  }
  return null;
}

function findRefAny(tree: FHNode, roles: string[], nameIncludes: string): string | null {
  return findNodeAny(tree, roles, nameIncludes)?.ref ?? null;
}

function textContains(tree: FHNode, needle: string): boolean {
  const n = needle.toLowerCase();
  return flatten(tree).some(
    (node) => (node.name ?? "").toLowerCase().includes(n) || (node.value ?? "").toLowerCase().includes(n),
  );
}

// ---------- per-task scripts ----------

function formScript(tree: FHNode): Action[] {
  const { name, email, guests, date, confirmationCode } = FIXTURE_DATA.form;

  if (textContains(tree, "Reservation confirmed") || textContains(tree, confirmationCode)) {
    return [{ act: "done", result: confirmationCode }];
  }

  const nameRef = findRefAny(tree, ["textbox", "input"], "full name");
  const emailRef = findRefAny(tree, ["textbox", "input"], "email");
  const guestsRef = findRefAny(tree, ["combobox", "listbox", "select"], "guests");
  const dateRef = findRefAny(tree, ["textbox", "input"], "date");
  const reserveRef = findRef(tree, "button", "reserve");

  if (!nameRef || !emailRef || !guestsRef || !dateRef || !reserveRef) {
    return [{ act: "scroll", direction: "down" }];
  }

  const nameNode = findNodeAny(tree, ["textbox", "input"], "full name");
  const emailNode = findNodeAny(tree, ["textbox", "input"], "email");
  const guestsNode = findNodeAny(tree, ["combobox", "listbox", "select"], "guests");
  const dateNode = findNodeAny(tree, ["textbox", "input"], "date");

  const actions: Action[] = [];
  if ((nameNode?.value ?? "") !== name) actions.push({ act: "fill", ref: nameRef, value: name });
  if ((emailNode?.value ?? "") !== email) actions.push({ act: "fill", ref: emailRef, value: email });
  if ((guestsNode?.value ?? "") !== guests) actions.push({ act: "select", ref: guestsRef, value: guests });
  if ((dateNode?.value ?? "") !== date) actions.push({ act: "fill", ref: dateRef, value: date });
  actions.push({ act: "click", ref: reserveRef });
  actions.push({ act: "expect", textContains: "Reservation confirmed" });
  return actions;
}

function searchScript(tree: FHNode): Action[] {
  const { query, target } = FIXTURE_DATA.search;
  const targetLower = target.toLowerCase();

  if (textContains(tree, "added to cart")) {
    return [{ act: "done", result: target }];
  }

  const addToCartRef = findRef(tree, "button", "add to cart");
  if (addToCartRef) {
    return [
      { act: "click", ref: addToCartRef },
      { act: "expect", textContains: "Added to cart" },
    ];
  }

  // "dell xps" is present in the unfiltered 12-item catalog and absent once
  // the search has actually been applied — a DOM-observable "has the filter
  // run yet" signal that's independent of the searchbox's live value (which
  // could already read "pixelbook" one action before Search is clicked).
  const filtered = !textContains(tree, "dell xps");
  if (filtered) {
    const productRef = findRef(tree, "listitem", targetLower);
    if (productRef) return [{ act: "click", ref: productRef }];
    return [{ act: "scroll", direction: "down" }];
  }

  const searchboxRef = findRefAny(tree, ["searchbox", "textbox"], "search products");
  const searchButtonRef = findRef(tree, "button", "search");
  if (!searchboxRef) return [{ act: "scroll", direction: "down" }];

  const searchNode = findNodeAny(tree, ["searchbox", "textbox"], "search products");
  const actions: Action[] = [];
  if (!(searchNode?.value ?? "").toLowerCase().includes(query)) {
    actions.push({ act: "fill", ref: searchboxRef, value: query });
  }
  if (searchButtonRef) actions.push({ act: "click", ref: searchButtonRef });
  return actions.length > 0 ? actions : [{ act: "scroll", direction: "down" }];
}

function checkoutScript(tree: FHNode): Action[] {
  const { name, address, city, orderId } = FIXTURE_DATA.checkout;

  if (textContains(tree, "Order placed") || textContains(tree, orderId)) {
    return [{ act: "done", result: orderId }];
  }

  const placeOrderRef = findRef(tree, "button", "place order");
  if (placeOrderRef) {
    return [
      { act: "click", ref: placeOrderRef },
      { act: "expect", textContains: "Order placed" },
    ];
  }

  const payRadioRef = findRef(tree, "radio", "pay on delivery");
  if (payRadioRef) {
    const payRadioNode = findNode(tree, "radio", "pay on delivery");
    const continueRef = findRef(tree, "button", "continue");
    const actions: Action[] = [];
    // Gate the click on live state: a radio click is idempotent value-wise,
    // but an UNCONDITIONAL click here would sit at index 0 of every batch
    // this function returns. Under 1-action/turn truncation (screenshot
    // style) that means "click the radio" forever, since the loop always
    // takes actions[0] and continueRef (index 1) never gets its turn. Same
    // fix as the switches in settingsScript below.
    if (!payRadioNode?.state?.includes("checked")) {
      actions.push({ act: "click", ref: payRadioRef });
    }
    if (continueRef) {
      actions.push({ act: "click", ref: continueRef });
      actions.push({ act: "expect", textContains: "Review" });
    }
    return actions.length > 0 ? actions : [{ act: "scroll", direction: "down" }];
  }

  const nameRef = findRefAny(tree, ["textbox", "input"], "full name");
  const addressRef = findRefAny(tree, ["textbox", "input"], "address");
  const cityRef = findRefAny(tree, ["textbox", "input"], "city");
  if (nameRef && addressRef && cityRef) {
    const nameNode = findNodeAny(tree, ["textbox", "input"], "full name");
    const addressNode = findNodeAny(tree, ["textbox", "input"], "address");
    const cityNode = findNodeAny(tree, ["textbox", "input"], "city");

    const actions: Action[] = [];
    if ((nameNode?.value ?? "") !== name) actions.push({ act: "fill", ref: nameRef, value: name });
    if ((addressNode?.value ?? "") !== address) actions.push({ act: "fill", ref: addressRef, value: address });
    if ((cityNode?.value ?? "") !== city) actions.push({ act: "fill", ref: cityRef, value: city });

    const continueRef = findRef(tree, "button", "continue");
    if (continueRef) {
      actions.push({ act: "click", ref: continueRef });
      actions.push({ act: "expect", textContains: "Payment" });
    }
    return actions.length > 0 ? actions : [{ act: "scroll", direction: "down" }];
  }

  return [{ act: "scroll", direction: "down" }];
}

function settingsScript(tree: FHNode): Action[] {
  if (textContains(tree, "Preferences saved")) {
    return [{ act: "done", result: "saved" }];
  }

  const darkRef = findRefAny(tree, ["switch", "button"], "dark mode");
  const emailRef = findRefAny(tree, ["switch", "button"], "email digest");
  const telemetryRef = findRefAny(tree, ["switch", "button"], "telemetry");
  const saveRef = findRef(tree, "button", "save");

  if (!darkRef || !emailRef || !telemetryRef || !saveRef) {
    return [{ act: "scroll", direction: "down" }];
  }

  const darkNode = findNodeAny(tree, ["switch", "button"], "dark mode");
  const emailNode = findNodeAny(tree, ["switch", "button"], "email digest");
  const telemetryNode = findNodeAny(tree, ["switch", "button"], "telemetry");

  const actions: Action[] = [];
  if (!darkNode?.state?.includes("checked")) actions.push({ act: "click", ref: darkRef });
  if (!emailNode?.state?.includes("checked")) actions.push({ act: "click", ref: emailRef });
  if (telemetryNode?.state?.includes("checked")) actions.push({ act: "click", ref: telemetryRef });
  actions.push({ act: "click", ref: saveRef });
  actions.push({ act: "expect", textContains: "Preferences saved" });
  return actions;
}

function listScript(tree: FHNode): Action[] {
  const { target } = FIXTURE_DATA.list;

  const headingHit = flatten(tree).some(
    (n) => /^h1$|heading/i.test(n.role ?? "") && (n.name ?? "").trim() === target,
  );
  if (headingHit) {
    return [{ act: "done", result: target }];
  }

  // The fixture's row buttons carry the row identity right in their own
  // accessible name (aria-label="Details for Order #4711"), so a plain
  // findRef already disambiguates the right row without needing to walk
  // sibling/parent structure.
  const detailsRef = findRef(tree, "button", `details for ${target.toLowerCase()}`);
  if (detailsRef) {
    return [{ act: "click", ref: detailsRef }];
  }

  return [{ act: "scroll", direction: "down" }];
}

function signupScript(tree: FHNode, observation: Observation): Action[] {
  const d = FIXTURE_DATA.signup;

  if (textContains(tree, "Account created") || textContains(tree, d.welcomeCode)) {
    return [{ act: "done", result: d.welcomeCode }];
  }

  const emailNode = findNodeAny(tree, ["textbox", "input"], "email");
  const userNode = findNodeAny(tree, ["textbox", "input"], "username");
  const passNode = findNodeAny(tree, ["textbox", "input"], "password");
  const dateNode = findNodeAny(tree, ["textbox", "input"], "birth date");
  const termsNode = findNodeAny(tree, ["checkbox", "switch"], "terms");
  const submitRef = findRef(tree, "button", "create account");

  if (!emailNode || !userNode || !passNode || !dateNode || !termsNode || !submitRef) {
    return [{ act: "scroll", direction: "down" }];
  }

  // A competent model uses whatever information it was actually given.
  // Without xray it does what the task description says: try "sam"/"hunter2",
  // learn from the rejection, adjust. With xray the hidden rules are in the
  // observation itself, so it picks compliant values on the first pass.
  // The "previous attempt failed" signal is also purely state-driven: the
  // naive values are still sitting in the fields.
  const sawHiddenRules = observation.text.includes("(hidden rule)");
  const attempted = (userNode.value ?? "") === d.naiveUsername || (passNode.value ?? "") === d.naivePassword;
  // Monotonic: once any field already holds a corrected value we are
  // mid-correction and must not downgrade the others back to naive. Without
  // this, 1-action-per-turn truncation flip-flops the username between
  // "sam_1" (attempted -> correct it) and "sam" (corrected value no longer
  // matches naive -> attempted reads false -> re-fill naive) forever.
  const corrected =
    (userNode.value ?? "") === d.validUsername || (passNode.value ?? "") === d.validPassword;
  const useValid = sawHiddenRules || attempted || corrected;
  const username = useValid ? d.validUsername : d.naiveUsername;
  const password = useValid ? d.validPassword : d.naivePassword;

  const actions: Action[] = [];
  if ((emailNode.value ?? "") !== d.email) actions.push({ act: "fill", ref: emailNode.ref, value: d.email });
  if ((userNode.value ?? "") !== username) actions.push({ act: "fill", ref: userNode.ref, value: username });
  if ((passNode.value ?? "") !== password) actions.push({ act: "fill", ref: passNode.ref, value: password });
  if ((dateNode.value ?? "") !== d.date) actions.push({ act: "fill", ref: dateNode.ref, value: d.date });
  if (!termsNode.state?.includes("checked")) actions.push({ act: "click", ref: termsNode.ref });
  actions.push({ act: "click", ref: submitRef });
  actions.push({ act: "expect", textContains: "Account created" });
  return actions;
}

const SCRIPTS: Record<string, (tree: FHNode, observation: Observation) => Action[]> = {
  form: formScript,
  search: searchScript,
  checkout: checkoutScript,
  settings: settingsScript,
  list: listScript,
  signup: signupScript,
};

export function createOracle(): OraclePolicy {
  return {
    id: "oracle",
    nextActions(taskId: string, _turn: number, observation: Observation): Action[] {
      const script = SCRIPTS[taskId];
      if (!script) {
        // Unknown task id: keep making progress rather than stalling.
        return [{ act: "scroll", direction: "down" }];
      }
      const actions = script(observation.snapshot.tree, observation);
      return actions.length > 0 ? actions : [{ act: "scroll", direction: "down" }];
    },
  };
}
