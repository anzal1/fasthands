// Designer mode: compose an original illustration on excalidraw.com — a real,
// unmodified third-party production app. The agent works like a designer:
// selects tools with the app's own keyboard shortcuts, drags shapes out on
// the canvas through guarded pointer/stroke actions, tries the app's color
// panel when it can observe one, and verifies its work through Excalidraw's
// own persisted scene state (localStorage) — no vision anywhere.
//   node --experimental-strip-types demos/designer.ts [--headed]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Action, FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes("--headed");

function findAll(node: FHNode, pred: (n: FHNode) => boolean, acc: FHNode[] = []): FHNode[] {
  if (pred(node)) acc.push(node);
  for (const c of node.children ?? []) findAll(c, pred, acc);
  return acc;
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("https://excalidraw.com", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500); // let the app boot
await page.keyboard.press("Escape"); // dismiss any welcome hints

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);

const obs = await engine.observe(4000);
const canvases = findAll(obs.snapshot.tree, (n) => n.role === "canvas");
if (canvases.length === 0) throw new Error("no canvas observed on excalidraw.com");
// Excalidraw layers a static canvas under an interactive one; the interactive
// canvas is the last in DOM order. If strokes land nowhere we fall back.
let board = canvases[canvases.length - 1];
console.log(
  `observed excalidraw: ${canvases.length} canvases (using ${board.ref} = ${board.value}), ` +
    `${findAll(obs.snapshot.tree, (n) => n.role === "button").length} buttons, ${obs.approxTokens} tokens`,
);

const elementCount = async (): Promise<number> =>
  page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem("excalidraw") ?? "[]") as unknown[]).length;
    } catch {
      return -1;
    }
  });

// Tool selection via Excalidraw's stable digit shortcuts:
// 1 select, 2 rectangle, 4 ellipse, 6 line, 7 draw (pencil), 8 text.
const tool = (key: string): Action => ({ act: "press", key });
const drag = (x1: number, y1: number, x2: number, y2: number): Action => ({
  act: "stroke",
  ref: board.ref,
  path: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
});
const draw = (pts: [number, number][]): Action => ({
  act: "stroke",
  ref: board.ref,
  path: pts.map(([x, y]) => ({ x, y })),
});

// Probe: one rectangle, then check the scene registered it.
let result = await executor.runBatch([tool("2"), drag(300, 620, 980, 640)]);
if ((await elementCount()) < 1 && canvases.length > 1) {
  board = canvases[0];
  console.log(`probe drew nothing; switching to canvas ${board.ref}`);
  result = await executor.runBatch([tool("2"), drag(300, 620, 980, 640)]);
}
console.log(`probe: ${result.completed ? "ok" : "failed"}, scene elements: ${await elementCount()}`);

// ---- the illustration: "Liftoff" — a rocket over clouds, moon and stars ----
const plan: Action[][] = [
  // launch pad line already drawn as the probe (300,620)-(980,640) rectangle base
  // rocket body
  [tool("2"), drag(590, 300, 690, 500)],
  // nose cone
  [tool("7"), draw([[590, 300], [640, 210], [690, 300]])],
  // fins
  [tool("7"), draw([[590, 480], [545, 560], [590, 545]])],
  [tool("7"), draw([[690, 480], [735, 560], [690, 545]])],
  // window
  [tool("4"), drag(615, 350, 665, 400)],
  // flame
  [tool("7"), draw([[605, 505], [640, 600], [675, 505]])],
  [tool("7"), draw([[622, 505], [640, 560], [658, 505]])],
  // clouds: three ellipses hugging the pad
  [tool("4"), drag(360, 580, 560, 650)],
  [tool("4"), drag(520, 600, 760, 670)],
  [tool("4"), drag(720, 575, 930, 645)],
  // moon
  [tool("4"), drag(1010, 130, 1110, 230)],
  // stars: little plus marks
  [tool("7"), draw([[380, 180], [380, 200]])],
  [tool("7"), draw([[370, 190], [390, 190]])],
  [tool("7"), draw([[480, 120], [480, 138]])],
  [tool("7"), draw([[471, 129], [489, 129]])],
  [tool("7"), draw([[880, 90], [880, 108]])],
  [tool("7"), draw([[871, 99], [889, 99]])],
  [tool("7"), draw([[300, 320], [300, 338]])],
  [tool("7"), draw([[291, 329], [309, 329]])],
  // motion streaks beside the rocket
  [tool("6"), drag(560, 330, 560, 430)],
  [tool("6"), drag(720, 330, 720, 430)],
];

let ok = 0, planned = 0;
for (const batch of plan) {
  planned += batch.length;
  const r = await executor.runBatch(batch);
  ok += r.steps.filter((s) => s.ok).length;
  if (!r.completed) console.log("batch aborted:", r.steps[r.abortedAt!]?.error);
}

// Title, like a designer labels a frame: text tool, click, type, escape.
const title: Action[] = [
  tool("8"),
  { act: "pointer", ref: board.ref, x: 545, y: 700 },
  ...[..."LIFTOFF"].map((ch): Action => ({ act: "press", key: ch })),
  tool("Escape"),
];
const tr = await executor.runBatch(title);
ok += tr.steps.filter((s) => s.ok).length;
planned += title.length;

const elements = await elementCount();
console.log(JSON.stringify({ planned, ok, sceneElements: elements }, null, 2));

// Verify through the app's own state: what did Excalidraw record?
const summary = await page.evaluate(() => {
  try {
    const els = JSON.parse(localStorage.getItem("excalidraw") ?? "[]") as { type: string; text?: string }[];
    const byType: Record<string, number> = {};
    for (const e of els) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return { byType, text: els.find((e) => e.type === "text")?.text ?? null };
  } catch {
    return null;
  }
});
console.log("excalidraw scene:", JSON.stringify(summary));

await page.keyboard.press("Escape");
await page.screenshot({ path: join(__dirname, "out-excalidraw.png") });
console.log("saved demos/out-excalidraw.png");

if (headed) await page.waitForTimeout(8000);
await browser.close();
