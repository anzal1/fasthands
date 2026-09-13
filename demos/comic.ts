// Stop-motion comic: deliberately SCRIBBLY drawing, as a controlled style.
// Sketchiness is synthesized, not suffered: multi-pass overdraw (pencil
// roughs), corner overshoot, smooth low-frequency waver, all seeded — and
// seeding per FRAME gives the classic "boiling line" of hand-drawn
// animation. Eight frames of a rocket launch, drawn stroke by stroke through
// the guarded executor, cleared between frames by clicking the app's own
// Clear button, assembled into a GIF + strip with ffmpeg.
//   node --experimental-strip-types demos/comic.ts

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Action, FHNode } from "../src/types.ts";
import { createObservationEngine } from "../src/observe/engine.ts";
import { createExecutor } from "../src/act/executor.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(__dirname, "frames");
mkdirSync(FRAMES_DIR, { recursive: true });

type Pt = { x: number; y: number };
const r1 = (v: number) => Math.round(v * 10) / 10;

// Deterministic smooth noise — no Math.random anywhere.
const noise = (seed: number, t: number) =>
  Math.sin(t * 2.3 + seed * 17.77) * 0.62 + Math.sin(t * 0.71 + seed * 5.31) * 0.38;

function resample(pts: Pt[], maxPts = 56): Pt[] {
  if (pts.length < 2) return pts;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const step = Math.max(3, len / Math.min(maxPts - 1, Math.max(4, len / 3)));
  const out: Pt[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, ay = pts[i - 1].y;
    const bx = pts[i].x, by = pts[i].y;
    let seg = Math.hypot(bx - ax, by - ay);
    while (acc + seg >= step) {
      const need = step - acc;
      const f = need / seg;
      ax += (bx - ax) * f; ay += (by - ay) * f;
      out.push({ x: ax, y: ay });
      seg = Math.hypot(bx - ax, by - ay);
      acc = 0;
    }
    acc += seg;
  }
  out.push(pts[pts.length - 1]);
  return out.slice(0, maxPts);
}

/** Turn a clean path into 1-2 scribbly passes: smooth waver along normals,
 *  overshoot at both ends. Different seed -> different scribble -> boiling. */
function sketchify(pts: Pt[], seed: number, amp = 2.4, passes = 2, overshoot = 7): Pt[][] {
  const base = resample(pts);
  if (base.length < 2) return [];
  const out: Pt[][] = [];
  for (let p = 0; p < passes; p++) {
    const s = seed * 13.7 + p * 41.3;
    const wob: Pt[] = base.map((pt, i) => {
      const prev = base[Math.max(0, i - 1)];
      const next = base[Math.min(base.length - 1, i + 1)];
      const dx = next.x - prev.x, dy = next.y - prev.y;
      const m = Math.hypot(dx, dy) || 1;
      const n = noise(s, i) * amp * (p === 0 ? 1 : 1.4);
      return { x: r1(pt.x + (-dy / m) * n), y: r1(pt.y + (dx / m) * n) };
    });
    // overshoot: a sketcher's line runs past the endpoints
    const o1 = wob[0], o2 = wob[1] ?? wob[0];
    const e1 = wob[wob.length - 1], e2 = wob[wob.length - 2] ?? e1;
    const ext = (a: Pt, b: Pt, d: number): Pt => {
      const m = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      return { x: r1(a.x + ((a.x - b.x) / m) * d), y: r1(a.y + ((a.y - b.y) / m) * d) };
    };
    const d1 = overshoot * (0.5 + Math.abs(noise(s, 99)));
    const d2 = overshoot * (0.5 + Math.abs(noise(s, 7)));
    out.push([ext(o1, o2, d1), ...wob, ext(e1, e2, d2)].slice(0, 60));
  }
  return out;
}

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
};
const line = (x1: number, y1: number, x2: number, y2: number): Pt[] => [
  { x: x1, y: y1 }, { x: x2, y: y2 },
];
const path = (...pts: [number, number][]): Pt[] => pts.map(([x, y]) => ({ x, y }));

/** All clean geometry for one frame; sketchify happens per shape. */
function frameShapes(f: number): Pt[][] {
  const shapes: Pt[][] = [];
  const wobble = f < 3 ? noise(f, 3) * 3 : 0;
  const rx = 300 + wobble;
  const ry = [252, 252, 252, 236, 196, 134, 48, -120][f];
  const flame = [0, 0, 12, 26, 34, 42, 50, 0][f];

  // ground + pad
  shapes.push(line(40, 360, 560, 360));
  shapes.push(line(270, 360, 262, 330));
  shapes.push(line(330, 360, 338, 330));
  // stars (boil every frame)
  for (const [sx, sy] of [[90, 70], [500, 50], [140, 160], [460, 150]] as [number, number][]) {
    shapes.push(line(sx - 6, sy, sx + 6, sy));
    shapes.push(line(sx, sy - 6, sx, sy + 6));
  }
  if (ry > -100) {
    // rocket: body, nose, fins, window
    shapes.push(path([rx - 28, ry], [rx - 28, ry + 84], [rx + 28, ry + 84], [rx + 28, ry], [rx - 28, ry]));
    shapes.push(path([rx - 28, ry], [rx, ry - 34], [rx + 28, ry]));
    shapes.push(path([rx - 28, ry + 62], [rx - 46, ry + 92], [rx - 28, ry + 84]));
    shapes.push(path([rx + 28, ry + 62], [rx + 46, ry + 92], [rx + 28, ry + 84]));
    shapes.push(arc(rx, ry + 28, 12, 0, Math.PI * 2, 20));
    if (flame > 0) {
      shapes.push(
        path([rx - 16, ry + 86], [rx - 8, ry + 86 + flame], [rx, ry + 88],
             [rx + 8, ry + 86 + flame], [rx + 16, ry + 86]),
      );
    }
    if (f >= 4) {
      // motion lines
      shapes.push(line(rx - 44, ry + 110, rx - 44, ry + 150));
      shapes.push(line(rx + 44, ry + 110, rx + 44, ry + 150));
    }
  }
  // smoke puffs bloom from launch onward
  if (f >= 3) {
    const grow = f - 2;
    shapes.push(arc(268 - grow * 9, 352, 8 + grow * 3.5, 0, Math.PI * 2, 16));
    shapes.push(arc(332 + grow * 9, 350, 7 + grow * 3, 0, Math.PI * 2, 16));
    if (f >= 5) shapes.push(arc(300, 344, 6 + grow * 2.5, 0, Math.PI * 2, 16));
  }
  if (f === 7) {
    // the empty sky afterward: drifting puffs + a wink of exhaust
    shapes.push(arc(300, 320, 26, 0, Math.PI * 2, 20));
    shapes.push(line(296, 40, 300, 90));
    shapes.push(line(306, 30, 308, 74));
  }
  return shapes;
}

function findAll(node: FHNode, pred: (n: FHNode) => boolean, acc: FHNode[] = []): FHNode[] {
  if (pred(node)) acc.push(node);
  for (const c of node.children ?? []) findAll(c, pred, acc);
  return acc;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 780, height: 720 } });
await page.goto("http://localhost:4620/whiteboard?pen=fine", { waitUntil: "domcontentloaded" });
const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);

let totalStrokes = 0;
const start = Date.now();
for (let f = 0; f < 8; f++) {
  const o = await engine.observe(3000);
  const canvas = findAll(o.snapshot.tree, (n) => n.role === "canvas")[0];
  const clearBtn = findAll(o.snapshot.tree, (n) => n.role === "button" && /clear/i.test(n.name))[0];
  const actions: Action[] = [{ act: "click", ref: clearBtn.ref }];
  for (const [si, shape] of frameShapes(f).entries()) {
    for (const pass of sketchify(shape, f * 31 + si)) {
      actions.push({ act: "stroke", ref: canvas.ref, path: pass });
    }
  }
  const r = await executor.runBatch(actions);
  const okStrokes = r.steps.filter((s) => s.ok && s.action.act === "stroke").length;
  totalStrokes += okStrokes;
  if (!r.completed) console.log(`frame ${f} aborted:`, r.steps[r.abortedAt!]?.error);

  const el = await page.$(`[data-fh-ref="${canvas.ref}"]`);
  const box = await el!.boundingBox();
  await page.screenshot({ path: join(FRAMES_DIR, `frame0${f}.png`), clip: box! });
  console.log(`frame ${f}: ${okStrokes} strokes`);
}
console.log(JSON.stringify({ frames: 8, totalStrokes, wallMs: Date.now() - start }));
await browser.close();

// Assemble: boiling-line GIF at 5 fps + a 4x2 comic strip.
execFileSync("ffmpeg", ["-y", "-framerate", "5", "-i", join(FRAMES_DIR, "frame0%d.png"),
  "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", join(__dirname, "out-comic.gif")]);
execFileSync("ffmpeg", ["-y", "-i", join(FRAMES_DIR, "frame0%d.png"),
  "-filter_complex", "tile=4x2:padding=6:color=white", join(__dirname, "out-comic-strip.png")]);
console.log("saved demos/out-comic.gif and demos/out-comic-strip.png");
