// La Gioconda, painted by the fasthands executor: DOM selects for pigment,
// guarded multi-point strokes for gesture, headed chromium so humans can
// watch. Layered like the real process: ground -> landscape -> figure mass ->
// flesh -> hair -> features -> sfumato glazes.

import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createObservationEngine } from "../observe/engine.ts";
import { createExecutor } from "../act/executor.ts";
import type { Action, FHNode } from "../types.ts";

const URL = "http://localhost:4620/atelier";
const OUT = process.env.MONA_OUT ?? "/tmp/monalisa-fasthands.png";

type Pt = { x: number; y: number };
type Group = { color: string; brush: string; opacity: string; strokes: Pt[][] };

const P = (x: number, y: number): Pt => ({ x, y });
const line = (x1: number, y1: number, x2: number, y2: number): Pt[] => [P(x1, y1), P(x2, y2)];
/** Horizontal chords filling an ellipse — the brush does the blending. */
function chords(cx: number, cy: number, rx: number, ry: number, step: number): Pt[][] {
  const out: Pt[][] = [];
  for (let y = cy - ry + step; y <= cy + ry - step / 2; y += step) {
    const w = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2));
    if (w > 4) out.push([P(cx - w, y), P(cx + w, y)]);
  }
  return out;
}
/** Gentle sine wave along x — sky, land, water. */
function wave(x1: number, x2: number, y: number, amp: number, periods = 2): Pt[] {
  const pts: Pt[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(P(x1 + (x2 - x1) * t, y + Math.sin(t * Math.PI * 2 * periods) * amp));
  }
  return pts;
}

const SCORE: Group[] = [
  // ---- ground: hazy sky ----
  { color: "#93A48D", brush: "32", opacity: "100",
    strokes: [20, 44, 68, 92, 116, 140].map((y) => wave(14, 466, y, 4)) },
  { color: "#7B8F7B", brush: "24", opacity: "60",
    strokes: [100, 128, 156, 184].map((y) => wave(14, 466, y, 6)) },
  { color: "#6C7F8A", brush: "16", opacity: "50",
    strokes: [ wave(20, 200, 175, 9, 1.5), wave(280, 462, 168, 10, 1.5), wave(60, 420, 205, 7) ] },
  // ---- lower landscape ----
  { color: "#8A6B44", brush: "24", opacity: "100",
    strokes: [252, 274, 296, 318, 338].map((y) => wave(14, 466, y, 5)) },
  { color: "#5C4023", brush: "12", opacity: "70",
    strokes: [ wave(20, 170, 268, 6, 1.5), wave(310, 462, 262, 6, 1.5), wave(20, 150, 310, 5, 1), wave(330, 462, 316, 5, 1) ] },
  { color: "#5E7268", brush: "10", opacity: "100",
    strokes: [
      [P(468, 252), P(432, 266), P(448, 286), P(412, 304), P(430, 326), P(405, 340)],
      [P(452, 258), P(424, 274), P(438, 294), P(408, 314)],
    ] },
  { color: "#A08050", brush: "10", opacity: "100",
    strokes: [
      [P(16, 262), P(58, 276), P(38, 296), P(80, 312), P(56, 332), P(96, 344)],
      [P(24, 286), P(64, 300), P(48, 318)],
    ] },
  { color: "#7E6A4E", brush: "6", opacity: "100",
    strokes: [ [P(402, 296), P(418, 288), P(438, 286), P(456, 292)], line(410, 296, 410, 310), line(448, 292, 448, 308) ] },
  // ---- figure mass: the dress ----
  { color: "#3A2A1C", brush: "32", opacity: "100",
    strokes: [
      [P(150, 372), P(122, 420), P(104, 490), P(96, 570), P(94, 632)],
      [P(330, 366), P(358, 416), P(376, 486), P(384, 566), P(386, 632)],
      ...[130, 156, 182, 208, 234, 260, 286, 312, 338, 358].map((x) =>
        [P(x, 388), P(x - 6, 470), P(x - 4, 550), P(x, 630)]),
      [P(150, 368), P(200, 352), P(240, 348), P(285, 352), P(332, 364)],
    ] },
  { color: "#241A12", brush: "24", opacity: "80",
    strokes: [
      [P(118, 420), P(104, 500), P(98, 600)],
      [P(362, 416), P(376, 496), P(382, 596)],
      wave(120, 360, 470, 6, 1.5), wave(116, 368, 540, 6, 1.5), wave(112, 372, 612, 5, 1),
    ] },
  { color: "#4A3A20", brush: "16", opacity: "100",
    strokes: [
      [P(338, 400), P(330, 452), P(338, 508), P(322, 552)],
      [P(352, 420), P(346, 478), P(352, 530)],
      [P(142, 404), P(150, 458), P(140, 510), P(158, 556)],
      [P(128, 428), P(136, 486), P(128, 534)],
    ] },
  // ---- flesh: face, neck, chest, hands ----
  { color: "#C8A164", brush: "16", opacity: "100",
    strokes: [
      ...chords(235, 208, 54, 70, 9),
      ...[284, 294, 304, 314].map((y) => line(216, y, 256, y)),
      [P(196, 330), P(236, 344), P(278, 328)],
      [P(206, 344), P(238, 356), P(270, 342)],
      ...chords(252, 584, 46, 26, 7),
      [P(300, 560), P(330, 540), P(346, 520)],
    ] },
  { color: "#8F6B3F", brush: "8", opacity: "60",
    strokes: [
      [P(185, 175), P(180, 210), P(186, 246), P(198, 268)],   // left face contour
      [P(285, 175), P(290, 210), P(284, 246), P(272, 268)],   // right face contour
      [P(212, 276), P(235, 284), P(258, 276)],                // under chin
      line(236, 200, 236, 232),                               // nose side
      [P(206, 188), P(222, 184)], [P(248, 184), P(264, 188)], // eye sockets
      [P(214, 296), P(238, 304), P(262, 296)],                // neck shadow
      [P(210, 336), P(238, 348), P(266, 336)],                // chest V
      line(230, 570, 224, 600), line(248, 568, 244, 602), line(266, 566, 262, 598),
    ] },
  { color: "#6E4E2C", brush: "4", opacity: "70",
    strokes: [
      line(231, 234, 233, 236), line(239, 234, 241, 236),     // nostrils
      [P(208, 192), P(216, 189), P(226, 191)],                // left upper lid
      [P(246, 191), P(256, 189), P(264, 192)],                // right upper lid
      [P(222, 270), P(238, 275), P(252, 270)],                // jaw accent
      line(236, 574, 232, 598), line(254, 572, 250, 600),
    ] },
  { color: "#B98A5C", brush: "12", opacity: "40",
    strokes: [ line(200, 226, 214, 232), line(258, 230, 272, 224), line(228, 160, 246, 160), line(230, 262, 244, 262) ] },
  { color: "#E8CFA0", brush: "10", opacity: "50",
    strokes: [
      line(222, 152, 250, 152), line(235, 200, 235, 226),
      line(204, 214, 214, 218), line(258, 216, 268, 212),
      line(226, 330, 252, 330), line(232, 576, 250, 572), line(260, 588, 276, 582),
    ] },
  // ---- hair and veil ----
  { color: "#2E2012", brush: "12", opacity: "100",
    strokes: [
      [P(233, 138), P(196, 148), P(178, 182), P(172, 228), P(178, 282), P(188, 330), P(202, 360)],
      [P(240, 138), P(276, 150), P(292, 184), P(298, 230), P(292, 284), P(282, 330), P(268, 358)],
      [P(226, 142), P(202, 158), P(190, 196), P(188, 244), P(196, 300)],
      [P(248, 142), P(270, 160), P(280, 198), P(282, 246), P(274, 302)],
      [P(196, 340), P(206, 368), P(214, 388)],
      [P(276, 338), P(266, 366), P(258, 386)],
    ] },
  { color: "#3B2A1A", brush: "6", opacity: "80",
    strokes: [
      [P(208, 160), P(198, 200), P(200, 250), P(208, 300)],
      [P(264, 162), P(274, 202), P(272, 252), P(264, 302)],
      [P(186, 250), P(192, 300), P(200, 344)],
      [P(288, 252), P(282, 302), P(272, 346)],
    ] },
  { color: "#6B6558", brush: "4", opacity: "50",
    strokes: [
      [P(190, 158), P(214, 140), P(240, 134), P(266, 140), P(288, 158)],
      [P(184, 172), P(212, 150), P(240, 144), P(268, 152), P(292, 172)],
      [P(296, 180), P(304, 240), P(300, 300), P(290, 352)],
    ] },
  // ---- features: brows, irises, the smile ----
  { color: "#3B2A1A", brush: "2", opacity: "60",
    strokes: [ [P(206, 180), P(216, 177), P(227, 179)], [P(245, 179), P(256, 177), P(266, 180)] ] },
  { color: "#241A12", brush: "4", opacity: "100",
    strokes: [ line(219, 193, 221, 195), line(253, 193, 255, 195) ] },
  { color: "#7A4A33", brush: "4", opacity: "90",
    strokes: [ [P(217, 246), P(228, 251), P(242, 251), P(254, 245)] ] },
  { color: "#7A4A33", brush: "2", opacity: "50",
    strokes: [ [P(222, 256), P(236, 259), P(250, 255)] ] },
  // ---- sfumato: wide, thin glazes to melt the edges ----
  { color: "#C8A164", brush: "32", opacity: "20",
    strokes: [ [P(190, 170), P(184, 230), P(196, 276)], [P(282, 172), P(288, 232), P(276, 278)] ] },
  { color: "#8A6B44", brush: "32", opacity: "20",
    strokes: [ wave(20, 160, 348, 5, 1), wave(320, 462, 350, 5, 1) ] },
  { color: "#3A2A1C", brush: "32", opacity: "20",
    strokes: [ [P(160, 372), P(240, 358), P(322, 370)] ] },
];

function findRef(node: FHNode, role: string, name: string): string | null {
  if (node.role === role && node.name.toLowerCase().includes(name.toLowerCase())) return node.ref;
  for (const c of node.children ?? []) {
    const r = findRef(c, role, name);
    if (r) return r;
  }
  return null;
}

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);
const obs = await engine.observe(4000);

const easel = findRef(obs.snapshot.tree, "canvas", "easel");
const colorSel = findRef(obs.snapshot.tree, "combobox", "color");
const brushSel = findRef(obs.snapshot.tree, "combobox", "brush");
const opacitySel = findRef(obs.snapshot.tree, "combobox", "opacity");
if (!easel || !colorSel || !brushSel || !opacitySel) {
  console.error("controls not found in observation", { easel, colorSel, brushSel, opacitySel });
  process.exit(1);
}

const t0 = Date.now();
let batches = 0, strokeCount = 0, failures = 0;

for (const group of SCORE) {
  const setup: Action[] = [
    { act: "select", ref: colorSel, value: group.color },
    { act: "select", ref: brushSel, value: group.brush },
    { act: "select", ref: opacitySel, value: group.opacity },
  ];
  const strokes: Action[] = group.strokes.map((path) => ({ act: "stroke", ref: easel, path }));
  const actions = [...setup, ...strokes];
  for (let i = 0; i < actions.length; i += 18) {
    const result = await executor.runBatch(actions.slice(i, i + 18));
    batches++;
    failures += result.steps.filter((s) => !s.ok).length;
    if (!result.completed) console.error("batch aborted:", result.steps[result.abortedAt!]?.error);
    // Re-observe between batches exactly like the real agent loop does — a
    // cheap diff that refreshes content hashes. The first run of this demo
    // skipped this and the drift guard rightly refused 25 of 27 batches:
    // changing the Color select's value changed its hash, and every later
    // select action was firing against a stale observation.
    await engine.observe(2000);
  }
  strokeCount += group.strokes.length;
  console.log(`layer ${group.color} x${group.strokes.length} done (${Date.now() - t0}ms)`);
}

const wallMs = Date.now() - t0;
const state = await page.evaluate(() => ({
  strokes: (window as any).__strokes.length,
  ops: (window as any).__ops,
}));
const dataUrl = await page.evaluate(
  () => (document.getElementById("easel") as HTMLCanvasElement).toDataURL("image/png"),
);
writeFileSync(OUT, Buffer.from(dataUrl.split(",")[1]!, "base64"));

console.log(JSON.stringify({
  strokesPlanned: strokeCount, strokesLanded: state.strokes, canvasOps: state.ops,
  batches, failures, wallMs, out: OUT,
}, null, 2));

// hold the window open so the human can admire the result
await new Promise((r) => setTimeout(r, 25_000));
await browser.close();
