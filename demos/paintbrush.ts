// Paint ANY image in COLOR on the whiteboard, the way a person does: the
// agent reads the app's paint box out of its own observation (24 swatches,
// 3 brushes — real labeled buttons), quantizes the image to that palette,
// then paints in layers: broad washes, midtone form strokes, fine details.
// Every color change is a guarded click on the app's own UI; every stroke is
// a guarded pointer gesture.
//   node --experimental-strip-types demos/paintbrush.ts <imageUrl> [--headed] [--crop top,bottom] [--max N]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Action, FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";
import { createPixelWatch } from "../src/canvas/pixels.ts";
import { planPainting } from "../src/canvas/artist.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const imageUrl = args.find((a) => !a.startsWith("--"));
if (!imageUrl) {
  console.error("usage: node --experimental-strip-types demos/paintbrush.ts <imageUrl> [--headed] [--crop top,bottom] [--max N]");
  process.exit(1);
}
const headed = args.includes("--headed");
const crop = args.includes("--crop")
  ? (() => {
      const [top, bottom] = args[args.indexOf("--crop") + 1].split(",").map(Number);
      return { top, bottom };
    })()
  : undefined;
const maxStrokes = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : 3000;

function findAll(node: FHNode, pred: (n: FHNode) => boolean, acc: FHNode[] = []): FHNode[] {
  if (pred(node)) acc.push(node);
  for (const c of node.children ?? []) findAll(c, pred, acc);
  return acc;
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 780, height: 720 } });
await page.goto("http://localhost:4620/whiteboard", { waitUntil: "domcontentloaded" });

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);
const pixels = createPixelWatch(page);

// The agent's view of the app: canvas + the paint box it will operate.
const obs = await engine.observe(4000);
const canvas = findAll(obs.snapshot.tree, (n) => n.role === "canvas")[0];
const swatches = findAll(obs.snapshot.tree, (n) => n.role === "button" && n.name.startsWith("Color "));
const brushes = findAll(obs.snapshot.tree, (n) => n.role === "button" && n.name.startsWith("Brush "));
if (!canvas || swatches.length === 0 || brushes.length === 0) throw new Error("paint box not observed");
const [bw, bh] = (canvas.value ?? "600x400").split("x").map(Number);
console.log(
  `observed: canvas ${canvas.ref} (${bw}x${bh}), ${swatches.length} swatches, ${brushes.length} brushes — ${obs.approxTokens} tokens`,
);

// The palette the agent paints with IS the palette the app offers.
const palette = swatches.map((s) => ({ name: s.name.replace(/^Color /, ""), ref: s.ref }));
const PALETTE_HEX: Record<string, string> = {
  "near black": "#1a1410", umber: "#4a3b2a", taupe: "#7a6a52", sand: "#b3a489",
  cream: "#ded3bd", ivory: "#f5efe2", "light flesh": "#e8c39a", flesh: "#c99b6c",
  "tan shadow": "#9c6b42", ochre: "#8a5a2b", golden: "#b3742e", amber: "#d9a441",
  rust: "#7a2e1d", terracotta: "#a33b2a", "dark olive": "#37402a", olive: "#5a6b3b",
  sage: "#7d8f5c", "deep green": "#2f4a42", "slate blue": "#24384a",
  "steel blue": "#3d5a73", "haze blue": "#6b8ba3", "pale sky": "#a7bfc9",
  plum: "#5c2f3d", "lavender grey": "#8a7f96",
};

const plan = await planPainting(page, {
  imageUrl,
  board: { width: bw, height: bh },
  crop,
  maxStrokes,
  palette: palette.map((p) => ({ name: p.name, hex: PALETTE_HEX[p.name] ?? "#808080" })),
});
console.log(`plan: ${plan.stats.strokes} strokes across ${plan.stats.layers} color layers`);

const swatchRef = new Map(palette.map((p) => [p.name, p.ref]));
const brushRef = new Map(brushes.map((b) => [b.name.replace(/^Brush /, ""), b.ref]));

const start = Date.now();
let ok = 0, total = 0, clicks = 0;
let lastBrush = "";
for (const [li, layer] of plan.layers.entries()) {
  const actions: Action[] = [];
  if (layer.brush !== lastBrush) {
    actions.push({ act: "click", ref: brushRef.get(layer.brush)! });
    lastBrush = layer.brush;
    clicks++;
  }
  actions.push({ act: "click", ref: swatchRef.get(layer.colorName)! });
  clicks++;
  for (const s of layer.strokes) actions.push({ act: "stroke", ref: canvas.ref, path: s.path });
  total += layer.strokes.length;

  const result = await executor.runBatch(actions);
  ok += result.steps.filter((st) => st.ok && st.action.act === "stroke").length;
  if (!result.completed) console.log(`layer ${li} (${layer.brush} ${layer.colorName}) aborted:`, result.steps[result.abortedAt!]?.error);
  if (li % 8 === 0) console.log(`  layer ${li + 1}/${plan.layers.length}: ${layer.brush} ${layer.colorName} (${layer.strokes.length} strokes)`);
}
const wallMs = Date.now() - start;

const onBoard = await page.evaluate(() => (window as any).__strokes.length);
console.log(JSON.stringify({ planned: total, strokesOk: ok, onBoard, layers: plan.layers.length, uiClicks: clicks, wallMs }, null, 2));
console.log("pixel check:", (await pixels.summarize()).text.trim());

const el = await page.$(`[data-fh-ref="${canvas.ref}"]`);
const box = await el!.boundingBox();
await page.screenshot({ path: join(__dirname, "out-painting.png"), clip: box! });
console.log("saved demos/out-painting.png");

if (headed) await page.waitForTimeout(8000);
await browser.close();
