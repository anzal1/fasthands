// Paint the Mona Lisa stroke plan onto the /whiteboard fixture through the
// real fasthands pipeline: observe -> find the canvas ref -> guarded stroke
// batches. Run headed so a human can watch:
//   node --experimental-strip-types demos/paint.ts [--headless]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Action, FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";
import { createPixelWatch } from "../src/canvas/pixels.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(__dirname, "monalisa.json"), "utf8")) as {
  strokes: { name: string; path: [number, number][] }[];
};

const headless = process.argv.includes("--headless");

function findCanvasRef(node: FHNode): string | null {
  if (node.role === "canvas") return node.ref;
  for (const c of node.children ?? []) {
    const hit = findCanvasRef(c);
    if (hit) return hit;
  }
  return null;
}

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 8 });
const page = await browser.newPage({ viewport: { width: 780, height: 620 } });
await page.goto("http://localhost:4620/whiteboard", { waitUntil: "domcontentloaded" });

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);
const pixels = createPixelWatch(page);

const obs = await engine.observe(2000);
const canvasRef = findCanvasRef(obs.snapshot.tree);
if (!canvasRef) throw new Error("no canvas in observation");
console.log(`observation: ${obs.approxTokens} tokens, canvas is ${canvasRef}`);

const start = Date.now();
let strokesSent = 0;
let stepsOk = 0;
let batches = 0;

const BATCH = 12;
for (let i = 0; i < plan.strokes.length; i += BATCH) {
  const actions: Action[] = plan.strokes.slice(i, i + BATCH).map((s) => ({
    act: "stroke",
    ref: canvasRef,
    path: s.path.map(([x, y]) => ({ x, y })),
  }));
  const result = await executor.runBatch(actions);
  batches++;
  strokesSent += actions.length;
  stepsOk += result.steps.filter((s) => s.ok).length;
  if (!result.completed) {
    console.log(`batch ${batches} aborted:`, result.steps[result.abortedAt!]?.error);
  }
}

const wallMs = Date.now() - start;
const strokeCount = await page.evaluate(() => (window as any).__strokes.length);
const ink = await pixels.summarize();

console.log(JSON.stringify({
  planStrokes: plan.strokes.length,
  strokesSent,
  stepsOk,
  strokesOnBoard: strokeCount,
  batches,
  wallMs,
}, null, 2));
console.log("pixel check:", ink.text.trim());

const canvasEl = await page.$(`[data-fh-ref="${canvasRef}"]`);
const box = await canvasEl!.boundingBox();
await page.screenshot({ path: join(__dirname, "out-fasthands.png"), clip: box! });
console.log("saved demos/out-fasthands.png");

if (!headless) await page.waitForTimeout(8000);
await browser.close();
