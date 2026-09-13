// Da Vinci study: engrave the actual Mona Lisa onto the whiteboard fixture
// through the real fasthands pipeline. The page analyzes the public-domain
// scan in-browser (CORS-clean from Wikimedia): Sobel edges become contour
// strokes, luminance drives four cross-hatch passes whose density builds
// sfumato tone out of thousands of delicate 1px translucent strokes. Every
// stroke goes through the guarded executor as a real pointer gesture.
//   node --experimental-strip-types demos/davinci.ts [--headless]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Action, FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";
import { createPixelWatch } from "../src/canvas/pixels.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const headless = process.argv.includes("--headless");
const IMG =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/500px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg";

function findCanvasRef(node: FHNode): string | null {
  if (node.role === "canvas") return node.ref;
  for (const c of node.children ?? []) {
    const hit = findCanvasRef(c);
    if (hit) return hit;
  }
  return null;
}

const browser = await chromium.launch({ headless });
const page = await browser.newPage({ viewport: { width: 780, height: 620 } });
await page.goto("http://localhost:4620/whiteboard?pen=fine", { waitUntil: "domcontentloaded" });

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);
const pixels = createPixelWatch(page);

const obs = await engine.observe(2000);
const canvasRef = findCanvasRef(obs.snapshot.tree);
if (!canvasRef) throw new Error("no canvas in observation");
console.log(`observation: ${obs.approxTokens} tokens, canvas is ${canvasRef}`);

// ---- in-page analysis: painting -> stroke plan -------------------------------
const plan = await page.evaluate(async (imgUrl: string) => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("image load failed"));
    img.src = imgUrl;
  });

  // Crop to head and shoulders (top 62%) and scale to the board.
  const cropH = Math.round(img.naturalHeight * 0.62);
  const scale = 396 / cropH;
  const w = Math.round(img.naturalWidth * scale);
  const h = 396;
  const ox = Math.round((600 - w) / 2);
  const oy = 2;

  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  wctx.drawImage(img, 0, 0, img.naturalWidth, cropH, 0, 0, w, h);
  const data = wctx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  const L = (x: number, y: number) => lum[(y | 0) * w + (x | 0)];

  type Stroke = { x1: number; y1: number; x2: number; y2: number };
  const strokes: Stroke[] = [];

  // Cross-hatch passes: rotated scanlines, runs where tone is darker than
  // the pass threshold. Later (darker) passes stack on earlier ones, so
  // stroke density follows luminance — hatching as tone.
  const passes = [
    { deg: 28, gap: 3.4, thr: 195 },
    { deg: -22, gap: 3.4, thr: 150 },
    { deg: 78, gap: 3.2, thr: 105 },
    { deg: 0, gap: 2.8, thr: 60 },
  ];
  const cx = w / 2, cy = h / 2;
  const R = Math.sqrt(cx * cx + cy * cy);
  for (const p of passes) {
    const a = (p.deg * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const nx = -dy, ny = dx;
    for (let off = -R; off <= R; off += p.gap) {
      let run: { x: number; y: number }[] = [];
      const flush = () => {
        if (run.length >= 3) {
          const a0 = run[0], a1 = run[run.length - 1];
          strokes.push({ x1: a0.x, y1: a0.y, x2: a1.x, y2: a1.y });
        }
        run = [];
      };
      for (let t = -R; t <= R; t += 1) {
        const x = cx + nx * off + dx * t;
        const y = cy + ny * off + dy * t;
        if (x >= 0 && x < w && y >= 0 && y < h && L(x, y) < p.thr) {
          run.push({ x, y });
        } else {
          flush();
        }
      }
      flush();
    }
  }

  // Contour pass: Sobel edges, short strokes along the local tangent.
  let edges = 0;
  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const gx =
        L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) -
        L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1);
      const gy =
        L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) -
        L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1);
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > 110) {
        const inv = 1 / (mag || 1);
        const tx = -gy * inv, ty = gx * inv; // tangent = perpendicular to gradient
        strokes.push({ x1: x - tx * 2, y1: y - ty * 2, x2: x + tx * 2, y2: y + ty * 2 });
        edges++;
      }
    }
  }

  // Cap for sanity; uniform sampling keeps coverage even.
  const CAP = 4600;
  let final = strokes;
  if (strokes.length > CAP) {
    final = [];
    const step = strokes.length / CAP;
    for (let i = 0; i < strokes.length; i += step) final.push(strokes[Math.floor(i)]);
  }

  return {
    strokes: final.map((s) => ({
      x1: Math.round((s.x1 + ox) * 10) / 10, y1: Math.round((s.y1 + oy) * 10) / 10,
      x2: Math.round((s.x2 + ox) * 10) / 10, y2: Math.round((s.y2 + oy) * 10) / 10,
    })),
    generated: strokes.length,
    edges,
    region: { w, h, ox, oy },
  };
}, IMG);

console.log(
  `plan: ${plan.generated} strokes generated (${plan.edges} contour), ${plan.strokes.length} after cap, region ${plan.region.w}x${plan.region.h}`,
);

// ---- drive every stroke through the guarded executor -------------------------
const start = Date.now();
let ok = 0;
let batches = 0;
const BATCH = 150;
for (let i = 0; i < plan.strokes.length; i += BATCH) {
  const actions: Action[] = plan.strokes.slice(i, i + BATCH).map((s) => ({
    act: "stroke",
    ref: canvasRef!,
    path: [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }],
  }));
  const result = await executor.runBatch(actions);
  batches++;
  ok += result.steps.filter((st) => st.ok).length;
  if (!result.completed) {
    console.log(`batch ${batches} aborted:`, result.steps[result.abortedAt!]?.error);
  }
  if (batches % 5 === 0) console.log(`  ${ok}/${plan.strokes.length} strokes on board…`);
}
const wallMs = Date.now() - start;

const strokesOnBoard = await page.evaluate(() => (window as any).__strokes.length);
const ink = await pixels.summarize();
console.log(JSON.stringify({ strokesSent: plan.strokes.length, ok, strokesOnBoard, batches, wallMs }, null, 2));
console.log("pixel check:", ink.text.trim());

const el = await page.$(`[data-fh-ref="${canvasRef}"]`);
const box = await el!.boundingBox();
await page.screenshot({ path: join(__dirname, "out-davinci.png"), clip: box! });
console.log("saved demos/out-davinci.png");

if (!headless) await page.waitForTimeout(10000);
await browser.close();
