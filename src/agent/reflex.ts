// fasthands reflex cache — deterministic replay for repeat tasks (xray
// capability layer, see SPEC.md v0.2).
//
// Design note: a replayed trace is NOT trusted blindly. Every turn's
// Action[] still goes through the same drift-guarded executor as a
// model-planned turn (src/act/executor.ts re-resolves every ref before
// acting). If the site has changed underneath the trace, the executor
// aborts the batch on drift exactly like it would for a fresh plan, the
// caller calls invalidate() to evict the stale trace, and the loop falls
// back to asking the model. Reflex therefore never trades correctness for
// speed — it only trades tokens for wall clock on the happy path where the
// origin hasn't changed since the trace was recorded.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Action } from "../types.ts";

export interface ReflexTrace {
  origin: string;
  taskKey: string;
  description: string;
  turns: Action[][];
  recordedAt: number;
  successes: number;
}

export interface ReflexStore {
  lookup(origin: string, taskDescription: string): ReflexTrace | null;
  record(origin: string, taskDescription: string, turns: Action[][]): void;
  /** Called when a replay aborts on drift: evict the stale trace so the
   *  next attempt at this task falls back to the model instead of
   *  replaying the same doomed actions. */
  invalidate(origin: string, taskDescription: string): void;
  /** Atomic write: tmp file + rename, so a crash mid-save never corrupts
   *  the store (a reader just sees the old file, or the new one — never a
   *  half-written one). */
  save(): void;
}

/** 32-bit FNV-1a. Good enough for a cache key, not for security. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Keep it simple per spec: lowercase + collapse whitespace. No attempt to
 *  strip quoted digits or other task-specific normalization. */
function normalizeDescription(description: string): string {
  return description.toLowerCase().trim().replace(/\s+/g, " ");
}

function taskKeyFor(origin: string, taskDescription: string): string {
  return fnv1a(`${origin}::${normalizeDescription(taskDescription)}`);
}

function isReflexTrace(value: unknown): value is ReflexTrace {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.origin === "string" &&
    typeof v.taskKey === "string" &&
    typeof v.description === "string" &&
    Array.isArray(v.turns) &&
    typeof v.recordedAt === "number" &&
    typeof v.successes === "number"
  );
}

/** Load whatever is at filePath into a Map, tolerating a missing or
 *  corrupt file by starting empty (never throws). */
function loadFromDisk(filePath: string): Map<string, ReflexTrace> {
  const entries = new Map<string, ReflexTrace>();
  if (!existsSync(filePath)) return entries;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return entries;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries; // corrupt file: tolerated, start empty
  }

  if (typeof parsed !== "object" || parsed === null) return entries;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isReflexTrace(value)) entries.set(key, value);
  }
  return entries;
}

/** Default: .fasthands/reflex.json under process.cwd(). */
export function createReflexStore(filePath?: string): ReflexStore {
  const path = filePath ?? join(process.cwd(), ".fasthands", "reflex.json");
  const entries = loadFromDisk(path);

  function lookup(origin: string, taskDescription: string): ReflexTrace | null {
    return entries.get(taskKeyFor(origin, taskDescription)) ?? null;
  }

  function record(origin: string, taskDescription: string, turns: Action[][]): void {
    const key = taskKeyFor(origin, taskDescription);
    const existing = entries.get(key);
    entries.set(key, {
      origin,
      taskKey: key,
      description: taskDescription,
      turns,
      recordedAt: Date.now(),
      successes: existing ? existing.successes + 1 : 1,
    });
  }

  function invalidate(origin: string, taskDescription: string): void {
    entries.delete(taskKeyFor(origin, taskDescription));
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    const obj: Record<string, ReflexTrace> = {};
    for (const [key, value] of entries) obj[key] = value;
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
    renameSync(tmpPath, path);
  }

  return { lookup, record, invalidate, save };
}
