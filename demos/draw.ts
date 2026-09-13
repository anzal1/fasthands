// Draw ANY image on the whiteboard like a human: flowing strokes along form,
// contours first, then tone. Usage:
//   node --experimental-strip-types demos/draw.ts <imageUrl> [--headed] [--crop top,bottom] [--max N]
// The image host must send CORS headers (Wikimedia does).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";
import { createPixelWatch } from "../src/canvas/pixels.ts";
import { planHumanStrokes, planToBatches } from "../src/canvas/artist.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const imageUrl = args.find((a) => !a.startsWith("--"));
if (!imageUrl) {
  console.error("usage: node --experimental-strip-types demos/draw.ts <imageUrl> [--headed] [--crop top,bottom] [--max N]");
  process.exit(1);
}
const headed = args.includes("--headed");
const cropArg = args[args.indexOf("--crop") + 1];
const crop = args.includes("--crop")
  ? { top: Number(cropArg.split(",")[0]), bottom: Number(cropArg.split(",")[1]) }
  : undefined;
const maxStrokes = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : 2400;

function findCanvas(node: FHNode): FHNode | null {
  if (node.role === "canvas") return node;
  for (const c of node.children ?? []) {
    const hit = findCanvas(c);
    if (hit) return hit;
  }
  return null;
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 780, height: 620 } });
await page.goto("http://localhost:4620/whiteboard?pen=fine", { waitUntil: "domcontentloaded" });

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);
const pixels = createPixelWatch(page);

const obs = await engine.observe(2000);
const canvas = findCanvas(obs.snapshot.tree);
if (!canvas) throw new Error("no canvas observed");
const [bw, bh] = (canvas.value ?? "600x400").split("x").map(Number);
console.log(`canvas ${canvas.ref} (${bw}x${bh}), observation ${obs.approxTokens} tokens`);

const plan = await planHumanStrokes(page, { imageUrl, board: { width: bw, height: bh }, crop, maxStrokes });
console.log(
  `plan: ${plan.strokes.length} strokes (${plan.stats.contours} contours, ${plan.stats.tone} tone${plan.stats.capped ? ", capped" : ""})`,
);

const start = Date.now();
let ok = 0;
const batches = planToBatches(plan, canvas.ref);
for (const [bi, batch] of batches.entries()) {
  const result = await executor.runBatch(batch);
  ok += result.steps.filter((s) => s.ok).length;
  if (!result.completed) console.log(`batch ${bi + 1} aborted:`, result.steps[result.abortedAt!]?.error);
  if ((bi + 1) % 4 === 0) console.log(`  ${ok}/${plan.strokes.length} strokes…`);
}
const wallMs = Date.now() - start;

const onBoard = await page.evaluate(() => (window as any).__strokes.length);
console.log(JSON.stringify({ planned: plan.strokes.length, ok, onBoard, batches: batches.length, wallMs }, null, 2));
console.log("pixel check:", (await pixels.summarize()).text.trim());

const el = await page.$(`[data-fh-ref="${canvas.ref}"]`);
const box = await el!.boundingBox();
await page.screenshot({ path: join(__dirname, "out-drawing.png"), clip: box! });
console.log("saved demos/out-drawing.png");

if (headed) await page.waitForTimeout(8000);
await browser.close();
