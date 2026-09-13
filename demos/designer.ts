// Designer mode v2 on excalidraw.com (real, unmodified third-party app).
// The v1 critique was fair: outlines only, doodle geometry. A designer uses
// FILLED native shapes and the style panel. v2 discovers the panel from its
// own observation (fill-style + background swatches are labeled buttons),
// sets solid fill, and composes a z-ordered scene: sky, sun, mountains,
// ground, house, birds, caption. Every interaction is a guarded action.
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
await page.waitForTimeout(2500);
await page.keyboard.press("Escape");

const engine = createObservationEngine(page);
const executor = createExecutor(page, engine);

// Excalidraw re-renders its DOM as panels open and close, which changes
// stability keys — cached refs die and the drift guard rightly refuses them
// (it refused OUR first version). So we behave like the real agent loop:
// re-observe before every layer and resolve the canvas and swatches by NAME
// from the fresh tree. Names are stable; refs are per-observation.
interface View {
  canvasRef: string;
  swatch: (hexIncludes: string) => string | null;
  solid: string | null;
}
async function look(): Promise<View> {
  const o = await engine.observe(6000);
  const canvasNodes = findAll(o.snapshot.tree, (n) => n.role === "canvas");
  if (canvasNodes.length === 0) throw new Error("canvas vanished from observation");
  const buttons = findAll(o.snapshot.tree, (n) => n.role === "button");
  const swatches = buttons.filter((b) => /^#|transparent/i.test(b.name.trim()));
  // Stroke presets come first, background presets second.
  const bgGroup = swatches.length >= 10 ? swatches.slice(5, 10) : swatches;
  return {
    canvasRef: canvasNodes[canvasNodes.length - 1].ref,
    swatch: (hex) => bgGroup.find((b) => b.name.toLowerCase().includes(hex))?.ref ?? null,
    solid: buttons.find((b) => /solid/i.test(b.name))?.ref ?? null,
  };
}

const tool = (key: string): Action => ({ act: "press", key });

let ok = 0, planned = 0;
async function run(actions: Action[]): Promise<void> {
  planned += actions.length;
  const r = await executor.runBatch(actions);
  ok += r.steps.filter((s) => s.ok).length;
  if (!r.completed) console.log("batch aborted:", r.steps[r.abortedAt!]?.error);
}

/** One design layer: fresh look, set background color, optionally set solid
 *  fill, pick the tool, drag the shape. */
async function shape(toolKey: string, bgHex: string | null, rect: [number, number, number, number]): Promise<void> {
  const v = await look();
  const acts: Action[] = [];
  if (bgHex) {
    const sw = v.swatch(bgHex);
    if (sw) {
      // Clicking a swatch opens Excalidraw's color popup, which eats the
      // next keypress/drag — close it before touching the canvas.
      acts.push({ act: "click", ref: sw }, tool("Escape"));
    } else {
      console.log(`swatch ${bgHex} not visible this turn; keeping current color`);
    }
  }
  if (v.solid) acts.push({ act: "click", ref: v.solid }, tool("Escape"));
  acts.push(tool(toolKey), {
    act: "stroke",
    ref: v.canvasRef,
    path: [{ x: rect[0], y: rect[1] }, { x: rect[2], y: rect[3] }],
  });
  await run(acts);
}

async function freehand(pts: [number, number][]): Promise<void> {
  const v = await look();
  await run([tool("7"), { act: "stroke", ref: v.canvasRef, path: pts.map(([x, y]) => ({ x, y })) }]);
}

// Activate a shape tool once so the style panel exists, and report discovery.
await run([tool("2")]);
const first = await look();
console.log(`style panel: solid=${first.solid ?? "not labeled"}, blue swatch=${first.swatch("a5d8ff")}`);

// ---- the composition: "DAWN" — z-ordered, filled, proportioned ------------
await shape("2", "a5d8ff", [80, 130, 1200, 650]);    // sky
await shape("4", "ffec99", [950, 165, 1085, 300]);   // sun
await shape("3", "b2f2bb", [130, 330, 700, 660]);    // mountain 1
await shape("3", null, [510, 390, 1130, 660]);       // mountain 2
await shape("2", null, [80, 555, 1200, 660]);        // ground band
await shape("2", "ffc9c9", [860, 470, 985, 585]);    // house
await shape("3", null, [830, 415, 1015, 505]);       // roof
await shape("2", "ffec99", [903, 528, 942, 585]);    // door
await freehand([[300, 200], [320, 188], [340, 200]]); // birds
await freehand([[365, 232], [383, 221], [401, 232]]);
await freehand([[250, 260], [264, 251], [278, 260]]);

const vt = await look();
await run([
  tool("8"),
  { act: "pointer", ref: vt.canvasRef, x: 598, y: 700 },
  ...[..."DAWN"].map((ch): Action => ({ act: "press", key: ch })),
  tool("Escape"),
]);
console.log(JSON.stringify({ planned, ok }, null, 2));

// Verify through the app's own persisted scene, whatever key it lives under.
const sceneState = await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    try {
      const parsed = JSON.parse(localStorage.getItem(key)!);
      if (Array.isArray(parsed) && parsed.length && parsed[0]?.type) {
        const byType: Record<string, number> = {};
        for (const e of parsed) byType[e.type] = (byType[e.type] ?? 0) + 1;
        return { key, count: parsed.length, byType, text: parsed.find((e: any) => e.type === "text")?.text ?? null };
      }
    } catch { /* not this key */ }
  }
  return null;
});
console.log("scene state:", JSON.stringify(sceneState));

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.screenshot({ path: join(__dirname, "out-excalidraw.png") });
console.log("saved demos/out-excalidraw.png");

if (headed) await page.waitForTimeout(8000);
await browser.close();
