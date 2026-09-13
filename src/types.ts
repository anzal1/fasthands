// fasthands shared contract. Builders implement AGAINST this file and never edit it.
// Any change goes through the tech lead.

// ---------- Observation ----------

/** One node in the compact interactive tree. Refs are stable across turns
 *  (derived from role+name+structural position hash), so a diff can say
 *  "e12 changed" and the executor can re-resolve e12 later. */
export interface FHNode {
  ref: string;            // "e1", "e2", ... stable within a page lifetime
  role: string;           // ARIA role or tag fallback
  name: string;           // accessible name, truncated to 80 chars
  value?: string;         // current value for inputs
  state?: string[];       // ["checked","disabled","expanded","focused",...]
  inViewport: boolean;
  children?: FHNode[];
}

export interface Snapshot {
  url: string;
  title: string;
  tree: FHNode;           // rooted at body
  nodeCount: number;
  capturedAt: number;     // ms epoch
}

/** What actually gets serialized to the model. Exactly one of full/diff is set. */
export interface Observation {
  kind: "full" | "diff";
  text: string;           // the serialized payload sent to the model
  snapshot: Snapshot;     // underlying snapshot (not sent; for guards/refs)
  approxTokens: number;   // text.length / 4, rounded up
}

export interface ObservationEngine {
  /** Capture a snapshot and serialize. Sends a full tree on first call or
   *  after navigation; otherwise a diff against the previous snapshot.
   *  `budget` caps approxTokens: out-of-viewport / non-interactive nodes are
   *  dropped first, then names truncated. */
  observe(budget?: number): Promise<Observation>;
  /** Force the next observe() to send a full tree (e.g. after navigation). */
  invalidate(): void;
  /** Resolve a ref from the LAST snapshot to a live locator-ish handle.
   *  Returns null if the node no longer exists or moved (drift). */
  resolve(ref: string): Promise<ResolvedNode | null>;
}

export interface ResolvedNode {
  ref: string;
  /** Click/fill target: a Playwright element handle under the hood. */
  handle: unknown;
  stillMatches: boolean;  // hash matches what the model last saw
}

// ---------- Actions ----------

export type Action =
  | { act: "click"; ref: string }
  | { act: "fill"; ref: string; value: string }
  | { act: "select"; ref: string; value: string }
  | { act: "press"; key: string }                    // e.g. "Enter", "Control+a"
  | { act: "scroll"; direction: "up" | "down"; amount?: number }
  | { act: "goto"; url: string }
  | { act: "wait"; ms: number }                      // capped at 3000 by executor
  | { act: "expect"; ref?: string; textContains?: string } // guard: abort batch if unmet
  /** Click at (x,y) in CSS pixels relative to the ref element's top-left.
   *  For canvases, WebGL scenes, maps — anything the tree can't target.
   *  The ref is still drift-guarded before the pointer moves. */
  | { act: "pointer"; ref: string; x: number; y: number }
  /** Drag a continuous path (pointerdown → moves → pointerup) with points in
   *  CSS pixels relative to the ref element's top-left. Drawing, sliders,
   *  3D orbit. Ref is drift-guarded; path capped at 64 points by executor. */
  | { act: "stroke"; ref: string; path: { x: number; y: number }[] }
  | { act: "done"; result: string };                 // task complete, report result

export interface StepResult {
  action: Action;
  ok: boolean;
  error?: string;         // "drift: ref e12 no longer matches", "timeout", ...
  driftDetected?: boolean;
}

export interface BatchResult {
  steps: StepResult[];
  completed: boolean;     // every step ok
  abortedAt?: number;     // index of first failed step
  done?: string;          // set when a `done` action executed
}

export interface Executor {
  /** Run actions in order. Before each ref-targeting step, re-resolve the ref;
   *  if the node is gone or its hash changed, abort the batch (drift) rather
   *  than clicking the wrong thing. Never throws for step failures. */
  runBatch(actions: Action[]): Promise<BatchResult>;
}

// ---------- Providers ----------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Uniform provider contract. Implementations use plain fetch, no SDKs.
 *  The model must return a JSON array of Actions; provider parses/repairs it. */
export interface Provider {
  readonly id: string;    // "anthropic" | "openai" | "openai-compat"
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<{
    actions: Action[];
    rawText: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

/** Deterministic scripted policy for keyless benchmarking: given the task id
 *  and turn number, returns the actions a competent model would emit under
 *  the loop style being measured. */
export interface OraclePolicy {
  readonly id: "oracle";
  nextActions(taskId: string, turn: number, observation: Observation): Action[];
}

// ---------- Agent loop ----------

export interface AgentConfig {
  maxTurns: number;       // default 15
  observationBudget: number; // default 2000 approx tokens
  batching: boolean;      // false = one action per turn (baseline mode)
  diffing: boolean;       // false = full tree every turn (Astra-style baseline)
}

export interface TurnLog {
  turn: number;
  observationTokens: number;
  observationKind: "full" | "diff";
  actionsPlanned: number;
  actionsCompleted: number;
  wallMs: number;
}

export interface RunResult {
  taskId: string;
  success: boolean;
  result?: string;        // the `done` payload
  turns: number;
  totalObservationTokens: number;
  totalWallMs: number;
  turnLogs: TurnLog[];
}

// ---------- Benchmark ----------

export interface BenchTask {
  id: string;
  description: string;    // the natural-language goal given to the model
  fixturePath: string;    // e.g. "/checkout" on the fixtures server
  /** Verifier run against the live page after the agent says done. */
  verify(page: unknown): Promise<boolean>;
}

export type LoopStyle = "screenshot" | "fulltree" | "fasthands" | "xray";

export interface BenchResult {
  taskId: string;
  style: LoopStyle;
  run: RunResult;
  /** For "screenshot" style: simulated image tokens per Anthropic's
   *  (w*h)/750 formula for a 1280x800 viewport, counted per turn. */
  simulatedImageTokens?: number;
}

// ---------- Fixture contract (scaffolder implements, bench depends on) ----------
// Fixtures server: plain node http on port 4620, serves these routes.
// All pages: real HTML, no frameworks, deterministic, semantic roles/labels.
//
// /form       "Book a table": name(textbox "Full name"), email(textbox "Email"),
//             guests(combobox "Guests" opts 1-6), date(textbox "Date"),
//             submit(button "Reserve"). Success -> h1 "Reservation confirmed"
//             and #confirmation-code appears.
// /search     "Find the cheapest laptop": searchbox "Search products",
//             button "Search", results list (listitem per product with name+price),
//             clicking a product -> detail page with button "Add to cart";
//             success -> element [data-cart-count] becomes "1" with cheapest item.
//             Data: 12 fixed products, cheapest is "Pixelbook Lite" $499.
// /checkout   3-step wizard: shipping (3 textboxes + button "Continue"),
//             payment (radio "Pay on delivery" + button "Continue"),
//             review (button "Place order"). Success -> h1 "Order placed",
//             #order-id appears.
// /settings   Toggle page: 8 labeled switches; task: enable "Dark mode" and
//             "Email digest", disable "Telemetry", click button "Save".
//             Success -> status region shows "Preferences saved".
// /list       Infinite-ish scroll: 60 rows, 20 rendered per scroll; task:
//             find row "Order #4711" (appears in third batch) and click its
//             "Details" button. Success -> h1 "Order #4711".
// /signup     Validation trap: email/username/password/date/terms with rules
//             machine-readable in HTML attributes but invisible until a
//             failed submit (username pattern [a-z0-9_]{5,15}, password
//             pattern (?=.*\d).{8,}). Success -> h1 "Account created" and
//             #welcome-code "FH-SIGNUP-77" visible.
// /whiteboard Canvas drawing app: h1 "Whiteboard", <canvas id="board"
//             width=600 height=400 aria-label="Drawing board">, button
//             "Clear board". Pointer events draw 3px black strokes.
//             App state: window.__strokes = Array<Array<{x,y}>> in canvas
//             CSS-pixel coords, one array per completed stroke. Task: draw
//             an X. Verified from __strokes geometry, not pixels.
// /chart      Canvas bar chart, NO DOM text: 4 bars for Q1-Q4 revenue
//             (412, 371, 518, 297 $k), each with fillText label
//             "Q1 $412k" centered 12px above its bar. Clicks hit-test
//             bars and set <p id="picked"> to the quarter name. Task:
//             click the highest-revenue quarter's bar -> #picked "Q3".
// /scene3d    Three.js WebGL scene (three served locally): three named box
//             meshes "red crate", "blue crate", "green crate" at distinct
//             positions, fixed camera, ambient+directional light, NO DOM
//             text naming them. Canvas click raycasts and sets
//             <p id="hit"> to the hit mesh name. Task: click the red
//             crate -> #hit "red crate".
