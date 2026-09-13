// Icon mode: draw a clean icon on excalidraw.com with the BRUSH only.
// The standard: laser precision on geometry — we know the surface and the
// coordinates exactly, so circles are parametric, polygons are exact, and
// there is zero artificial jitter. The "human" quality comes from
// Excalidraw's own freedraw pen rendering, not from wobble we add.
//   node --experimental-strip-types demos/icon.ts [--headed]

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
await page.waitForTimeout(2500);
await page.keyboard.press("Escape");

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);

async function canvasRef(): Promise<string> {
  const o = await engine.observe(6000);
  const cs = findAll(o.snapshot.tree, (n) => n.role === "canvas");
  if (cs.length === 0) throw new Error("canvas vanished");
  return cs[cs.length - 1].ref;
}

type Pt = { x: number; y: number };
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Parametric arc, sampled finely — laser-precise input; Excalidraw's pen
 *  makes it read as hand-drawn. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: r1(cx + r * Math.cos(a)), y: r1(cy + r * Math.sin(a)) });
  }
  return pts;
}

/** Exact polygon with densified edges so freedraw keeps corners crisp. */
function poly(points: [number, number][], close = true, per = 6): Pt[] {
  const src = close ? [...points, points[0]] : points;
  const out: Pt[] = [];
  for (let i = 0; i < src.length - 1; i++) {
    const [x1, y1] = src[i];
    const [x2, y2] = src[i + 1];
    for (let s = 0; s < per; s++) {
      out.push({ x: r1(x1 + ((x2 - x1) * s) / per), y: r1(y1 + ((y2 - y1) * s) / per) });
    }
  }
  out.push({ x: src[src.length - 1][0], y: src[src.length - 1][1] });
  return out;
}

/** Cap at the executor's 64-point limit by uniform resampling, never by
 *  chopping the tail (that would deform the shape). */
function cap64(pts: Pt[]): Pt[] {
  if (pts.length <= 64) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < 63; i++) out.push(pts[Math.round((i * (pts.length - 1)) / 63)]);
  out.push(pts[pts.length - 1]);
  return out;
}

const CX = 640, CY = 390;

// The fasthands mark: a double-ring badge, an exact lightning bolt, three
// speed ticks. All brush ("7"), all parametric.
const BOLT: [number, number][] = [
  [0.47, 0.06], [0.22, 0.56], [0.43, 0.56], [0.36, 0.94],
  [0.74, 0.38], [0.52, 0.38], [0.64, 0.06],
];
const boltPts = poly(
  BOLT.map(([u, v]) => [r1(CX - 130 + u * 260), r1(CY - 155 + v * 310)] as [number, number]),
  true,
  5,
);

const shapes: Pt[][] = [
  cap64(arc(CX, CY, 195, -Math.PI / 2, (3 * Math.PI) / 2, 60)),        // outer ring
  cap64(arc(CX, CY, 172, -Math.PI / 2, (3 * Math.PI) / 2, 56)),        // inner ring
  cap64(boltPts),                                                       // the bolt
  poly([[CX - 320, CY - 40], [CX - 245, CY - 40]], false, 8),           // speed ticks
  poly([[CX - 345, CY], [CX - 250, CY]], false, 8),
  poly([[CX - 320, CY + 40], [CX - 245, CY + 40]], false, 8),
];

let ok = 0, planned = 0;
for (const pts of shapes) {
  const ref = await canvasRef(); // fresh look each stroke: refs are per-observation
  const batch: Action[] = [{ act: "press", key: "7" }, { act: "stroke", ref, path: pts }];
  planned += batch.length;
  const r = await executor.runBatch(batch);
  ok += r.steps.filter((s) => s.ok).length;
  if (!r.completed) console.log("aborted:", r.steps[r.abortedAt!]?.error);
}

// Wordmark under the badge, via the text tool.
const ref = await canvasRef();
const title: Action[] = [
  { act: "press", key: "8" },
  { act: "pointer", ref, x: CX - 62, y: CY + 245 },
  ...[..."fasthands"].map((ch): Action => ({ act: "press", key: ch })),
  { act: "press", key: "Escape" },
];
planned += title.length;
const tr = await executor.runBatch(title);
ok += tr.steps.filter((s) => s.ok).length;

console.log(JSON.stringify({ planned, ok }, null, 2));

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.screenshot({ path: join(__dirname, "out-icon.png") });
console.log("saved demos/out-icon.png");

if (headed) await page.waitForTimeout(8000);
await browser.close();
