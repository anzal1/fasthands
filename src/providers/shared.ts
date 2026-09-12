// Shared plumbing for all provider adapters: JSON-array extraction/repair,
// Action shape validation, and a couple of small fetch helpers. No SDKs.

import type { Action } from "../types.ts";

/** Strip ```json / ``` fences (and stray backticks) from a model reply. */
function stripFences(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

/** Slice from the first '[' to the last ']' — the model is instructed to
 *  reply with ONLY a JSON array, but some models wrap it in prose anyway. */
function extractArraySlice(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/** Remove trailing commas before ] or } — the one "repair" we attempt.
 *  We deliberately do NOT try single->double quote rewriting: that's not a
 *  safe transform on arbitrary text and can corrupt otherwise-valid JSON. */
function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, "$1");
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);
void VALID_ROLES;

function isValidAction(candidate: unknown): candidate is Action {
  if (typeof candidate !== "object" || candidate === null) return false;
  const a = candidate as Record<string, unknown>;
  switch (a.act) {
    case "click":
    case "select":
      // select's runtime shape check is identical to click's (act, ref[, value])
      if (a.act === "select") return typeof a.ref === "string" && typeof a.value === "string";
      return typeof a.ref === "string";
    case "fill":
      return typeof a.ref === "string" && typeof a.value === "string";
    case "press":
      return typeof a.key === "string";
    case "scroll":
      return (
        (a.direction === "up" || a.direction === "down") &&
        (a.amount === undefined || typeof a.amount === "number")
      );
    case "goto":
      return typeof a.url === "string";
    case "wait":
      return typeof a.ms === "number";
    case "expect":
      return (
        (a.ref === undefined || typeof a.ref === "string") &&
        (a.textContains === undefined || typeof a.textContains === "string")
      );
    case "done":
      return typeof a.result === "string";
    default:
      return false;
  }
}

/** Parse a model reply into a validated Action[]. On any failure to find or
 *  parse a JSON array, returns an empty list so the agent loop can re-prompt.
 *  Invalid-shaped entries within an otherwise-valid array are dropped. */
export function parseActions(rawText: string): Action[] {
  const stripped = stripFences(rawText);
  const slice = extractArraySlice(stripped);
  if (slice === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    try {
      parsed = JSON.parse(removeTrailingCommas(slice));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidAction);
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/** POST JSON with the given headers; throws on non-2xx with response body
 *  included in the error message for debuggability. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} -> ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}
