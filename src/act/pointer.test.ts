// Plain smoke script (no test framework) for the new "pointer"/"stroke"
// executor actions plus the /whiteboard and /chart fixtures. Launches real
// headless chromium via playwright and page.setContent()s the fixture HTML
// read straight from disk (no fixtures server needed for this test — script
// tags in the fixture execute fine under setContent). Builds a real
// ObservationEngine + Executor, same as production wiring.
//
// Run with:
//   export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
//   cd /Users/anzalhussainabidi/personal/fasthands
//   node --experimental-strip-types src/act/pointer.test.ts
//
// Exits 0 on all pass, 1 on any failure.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FHNode } from "../types.ts";
import { createObservationEngine } from "../observe/engine.ts";
import { createExecutor } from "../act/executor.ts";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok:   ${message}`);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");

/** Depth-first search for the first node whose role the engine surfaced as
 *  "canvas". Returns its ref, or null if the tree doesn't have one (e.g. the
 *  parallel canvas-surfacing work hasn't landed yet). */
function findCanvasRef(node: FHNode): string | null {
  if (node.role === "canvas") return node.ref;
  for (const child of node.children ?? []) {
    const found = findCanvasRef(child);
    if (found) return found;
  }
  return null;
}

/** Resolve the canvas element's fasthands ref two ways: prefer the
 *  observation tree (role "canvas"); if the engine doesn't surface it (e.g.
 *  canvas surfacing lands in a different order than this test runs), fall
 *  back to reading the data-fh-ref attribute the engine already stamped onto
 *  the live DOM element during observe(). Either way the ref is one the
 *  engine's resolve() can look up, since observe() indexes every node it
 *  returns regardless of which path found it here. */
async function findCanvasRefEitherWay(
  page: import("playwright").Page,
  tree: FHNode,
  selector: string,
): Promise<{ ref: string; via: string }> {
  const fromTree = findCanvasRef(tree);
  if (fromTree) {
    return { ref: fromTree, via: "observation tree (role=canvas)" };
  }
  const attr = await page.$eval(selector, (el) => el.getAttribute("data-fh-ref"));
  if (!attr) {
    throw new Error(
      `could not find a fasthands ref for ${selector} via the tree or data-fh-ref fallback`,
    );
  }
  return { ref: attr, via: "data-fh-ref DOM attribute fallback" };
}

function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

async function testWhiteboard(browser: import("playwright").Browser): Promise<void> {
  const page = await browser.newPage();
  const html = readFileSync(join(FIXTURES_DIR, "whiteboard.html"), "utf8");
  await page.setContent(html);

  const engine = createObservationEngine(page);
  const executor = createExecutor(page, engine);

  const obs = await engine.observe();
  const { ref: canvasRef, via } = await findCanvasRefEitherWay(page, obs.snapshot.tree, "#board");
  console.log(`whiteboard: found canvas ref ${canvasRef} via ${via}`);

  // ---------- two strokes drawing an X ----------

  const stroke1 = await executor.runBatch([
    {
      act: "stroke",
      ref: canvasRef,
      path: [
        { x: 50, y: 50 },
        { x: 550, y: 350 },
      ],
    },
  ]);
  assert(stroke1.completed === true, "whiteboard: first stroke completes");
  assert(stroke1.steps[0]?.ok === true, "whiteboard: first stroke step ok");

  const stroke2 = await executor.runBatch([
    {
      act: "stroke",
      ref: canvasRef,
      path: [
        { x: 550, y: 50 },
        { x: 50, y: 350 },
      ],
    },
  ]);
  assert(stroke2.completed === true, "whiteboard: second stroke completes");
  assert(stroke2.steps[0]?.ok === true, "whiteboard: second stroke step ok");

  const strokes = await page.evaluate(() => (window as any).__strokes as { x: number; y: number }[][]);
  assert(strokes.length === 2, `whiteboard: __strokes has 2 entries, got ${strokes.length}`);

  const firstStrokeLast = strokes[0]?.[strokes[0].length - 1];
  assert(
    firstStrokeLast !== undefined &&
      approxEqual(firstStrokeLast.x, 550, 5) &&
      approxEqual(firstStrokeLast.y, 350, 5),
    `whiteboard: stroke 1's last point ~(550,350), got ${JSON.stringify(firstStrokeLast)}`,
  );

  // ---------- out-of-bounds pointer: rejected, nothing drawn ----------

  const badPointer = await executor.runBatch([{ act: "pointer", ref: canvasRef, x: 9999, y: 9999 }]);
  assert(badPointer.completed === false, "whiteboard: out-of-bounds pointer batch does not complete");
  assert(badPointer.steps[0]?.ok === false, "whiteboard: out-of-bounds pointer step fails");
  // The box in the error is the element's real layout box (border included,
  // per getBoundingClientRect/boundingBox semantics) — the fixture's 1px
  // border means that's 602x402, not the bare canvas attribute 600x400.
  const boardBox = await page.evaluate(() => {
    const r = document.getElementById("board")!.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  });
  assert(
    (badPointer.steps[0]?.error ?? "").includes("outside") &&
      (badPointer.steps[0]?.error ?? "").includes(`${boardBox.width}x${boardBox.height}`),
    `whiteboard: out-of-bounds pointer error names the ${boardBox.width}x${boardBox.height} box, got "${badPointer.steps[0]?.error}"`,
  );

  const strokesAfterBadPointer = await page.evaluate(
    () => (window as any).__strokes as unknown[],
  );
  assert(
    strokesAfterBadPointer.length === 2,
    `whiteboard: rejected pointer drew nothing (still 2 strokes), got ${strokesAfterBadPointer.length}`,
  );

  // ---------- stroke over the 64-point cap ----------

  const longPath = Array.from({ length: 100 }, (_, i) => ({
    x: 10 + (i % 50) * 5,
    y: 10 + Math.floor(i / 50) * 100,
  }));
  const badStroke = await executor.runBatch([{ act: "stroke", ref: canvasRef, path: longPath }]);
  assert(badStroke.completed === false, "whiteboard: over-cap stroke batch does not complete");
  assert(badStroke.steps[0]?.ok === false, "whiteboard: over-cap stroke step fails");
  assert(
    (badStroke.steps[0]?.error ?? "").includes("64"),
    `whiteboard: over-cap stroke error mentions the 64-point cap, got "${badStroke.steps[0]?.error}"`,
  );

  await page.close();
}

async function testChart(browser: import("playwright").Browser): Promise<void> {
  const page = await browser.newPage();
  const html = readFileSync(join(FIXTURES_DIR, "chart.html"), "utf8");
  await page.setContent(html);

  const engine = createObservationEngine(page);
  const executor = createExecutor(page, engine);

  const obs = await engine.observe();
  const { ref: canvasRef, via } = await findCanvasRefEitherWay(page, obs.snapshot.tree, "#chart");
  console.log(`chart: found canvas ref ${canvasRef} via ${via}`);

  // Read the bar geometry from the page's own array instead of hardcoding
  // fixture coordinates here.
  const bars = await page.evaluate(
    () =>
      (window as any).__bars as { quarter: string; x: number; y: number; width: number; height: number }[],
  );
  const q3 = bars.find((b) => b.quarter === "Q3");
  assert(q3 !== undefined, "chart: __bars exposes a Q3 entry");
  if (!q3) return;

  const centerX = q3.x + q3.width / 2;
  const centerY = q3.y + q3.height / 2;

  const pointerResult = await executor.runBatch([
    { act: "pointer", ref: canvasRef, x: centerX, y: centerY },
  ]);
  assert(pointerResult.completed === true, "chart: pointer at Q3's center completes");
  assert(pointerResult.steps[0]?.ok === true, "chart: pointer step ok");

  const picked = await page.evaluate(() => document.getElementById("picked")?.textContent);
  assert(picked === "Q3", `chart: #picked reads "Q3", got "${picked}"`);

  await page.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await testWhiteboard(browser);
    await testChart(browser);
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} pointer/stroke check(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nall pointer/stroke checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("pointer test threw:", err);
  process.exit(1);
});
