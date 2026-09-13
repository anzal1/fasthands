// fasthands — src/canvas/tap.test.ts
//
// Plain script (no test framework), headless chromium. Exercises:
//
//   Page 1 (command-stream tap, via engine + CanvasTap):
//   - two canvases, A and B. Canvas A draws fillText/fillRect/a stroked
//     path AFTER ctx.translate(10,10) — asserts recorded coordinates
//     reflect the transform (text "hello world" at (30,40), not (20,30)).
//   - engine.observe() surfaces BOTH canvases as role "canvas" nodes with
//     "WxH" values, before either has been drawn on.
//   - the 500-op ring buffer: 600 extra fillRects on canvas A, asserts a
//     drop note appears in tap.annotate()'s output.
//
//   Page 2 (raster-diff fallback, src/canvas/pixels.ts used directly and
//   independently of tap — no CanvasTap involved at all):
//   - a single canvas, tagged with a data-fh-ref by hand (pixels.ts only
//     requires the tag to exist, not that it came from the real engine).
//   - draws a rect, summarize() reports an ink bbox roughly matching it.
//   - draws a second rect elsewhere, a second summarize() call reports a
//     changed region roughly matching the NEW rect, not the first one.
//   (Page 1 also exercises the zero-ops -> pixel-fallback path inside
//   tap.annotate() itself for canvas B, which is why the dedicated
//   PixelWatch-precision assertions live on their own untouched page 2 —
//   tap.annotate() calling pixels.summarize() as its fallback would
//   otherwise silently consume page 1's "first call" baseline.)
//
// Run:
//   export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
//   cd /Users/anzalhussainabidi/personal/fasthands
//   node --experimental-strip-types src/canvas/tap.test.ts
//
// Exit 0 on pass, 1 (with messages) on fail.

import { chromium } from "playwright";
import { createObservationEngine } from "../observe/engine.ts";
import { createCanvasTap } from "./tap.ts";
import { createPixelWatch } from "./pixels.ts";

let failures = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}

function findByRole(node: any, role: string): any[] {
  const out: any[] = [];
  if (node.role === role) out.push(node);
  for (const c of node.children || []) out.push(...findByRole(c, role));
  return out;
}

const PAGE1_HTML = `<!doctype html><html><head><title>Canvas Tap Test</title></head><body>
  <h1>Two Canvases</h1>
  <canvas id="a" width="300" height="200" aria-label="Canvas A"></canvas>
  <canvas id="b" width="300" height="200" aria-label="Canvas B"></canvas>
</body></html>`;

const PAGE2_HTML = `<!doctype html><html><head><title>Pixel Watch Test</title></head><body>
  <canvas id="c" width="300" height="200" aria-label="Canvas C"></canvas>
</body></html>`;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  // =====================================================================
  // Page 1: command-stream tap (engine surfacing + tap.annotate())
  // =====================================================================
  const page1 = await browser.newPage();
  const tap = createCanvasTap(page1);
  // install() must run before page.goto so the getContext patch is in
  // place before any page script requests a context. NOTE: page.setContent()
  // does NOT replay addInitScript in this Playwright version (verified: only
  // a real navigation does), so the test page is loaded via goto(data:) here
  // rather than setContent — this mirrors how install() is meant to be used
  // in practice (before a real page.goto), not an artifact of the test.
  await tap.install();
  await page1.goto("data:text/html," + encodeURIComponent(PAGE1_HTML));

  const engine = createObservationEngine(page1);

  // ---- engine.observe() surfaces both canvases as canvas-role nodes,
  // WxH values, before anything has been drawn ----
  const obs = await engine.observe();
  const canvasNodes = findByRole(obs.snapshot.tree, "canvas");
  assert(canvasNodes.length === 2, `expected 2 canvas nodes in snapshot, got ${canvasNodes.length}`);
  const namesAndValues = canvasNodes
    .map((n) => `${n.name}=${n.value}`)
    .sort()
    .join(", ");
  assert(
    namesAndValues === "Canvas A=300x200, Canvas B=300x200",
    `expected both canvases tagged "WxH"=300x200, got: ${namesAndValues}`,
  );
  assert(obs.text.includes('canvas "Canvas A" ="300x200"'), `serialized text missing canvas A line:\n${obs.text}`);
  assert(obs.text.includes('canvas "Canvas B" ="300x200"'), `serialized text missing canvas B line:\n${obs.text}`);

  // ---- draw on canvas A: translate, then text/rect/path ----
  await page1.evaluate(() => {
    const canvas = (document as any).getElementById("a");
    const ctx = canvas.getContext("2d");
    ctx.translate(10, 10);
    ctx.fillText("hello world", 20, 30); // -> recorded at (30,40), post-transform
    ctx.fillRect(5, 5, 40, 20); // -> recorded at (15,15 40x20)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.lineTo(10, 10);
    ctx.stroke();
  });

  // ---- tap.annotate(): verbatim text + transformed coords ----
  const annotated = await tap.annotate();
  assert(annotated.count === 2, `expected annotate() to cover 2 tagged canvases, got ${annotated.count}`);
  assert(
    annotated.text.includes('text "hello world" @ (30,40)'),
    `expected transformed text op "hello world" @ (30,40):\n${annotated.text}`,
  );
  assert(
    annotated.text.includes("rect (15,15 40x20)"),
    `expected transformed rect op (15,15 40x20):\n${annotated.text}`,
  );
  // moveTo(0,0)/lineTo(10,0)/lineTo(10,10) are ALSO drawn under the same
  // translate(10,10) as the text/rect above, so the recorded (transformed)
  // bbox is (10,10 10x10), not the raw (0,0 10x10) passed to the path calls.
  assert(
    /path 3pts bbox \(10,10 10x10\)/.test(annotated.text),
    `expected a 3-point path op with transformed bbox (10,10 10x10):\n${annotated.text}`,
  );
  // canvas B never had any 2D op recorded -> falls through to the pixel
  // summary (a blank canvas -> "ink bbox none, 0% inked" on this, its first
  // ever pixel read).
  assert(
    /canvas e\d+ "Canvas B" \(300x200\):\n\s+ink bbox none, 0% inked/.test(annotated.text),
    `expected canvas B (zero ops) to fall through to a pixel summary:\n${annotated.text}`,
  );

  // ---- 500-op ring buffer: loop 600 fillRects, assert a drop note ----
  await page1.evaluate(() => {
    const canvas = (document as any).getElementById("a");
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 600; i++) {
      ctx.fillRect(0, 0, 1, 1);
    }
  });
  const afterFlood = await tap.annotate();
  assert(
    /ops dropped by the 500-op ring buffer cap/.test(afterFlood.text),
    `expected a ring-buffer drop note after 600 extra ops:\n${afterFlood.text}`,
  );

  await page1.close();

  // =====================================================================
  // Page 2: PixelWatch (src/canvas/pixels.ts) used directly, with no
  // CanvasTap involved at all — its own canvas, its own fresh __fhPix state.
  // =====================================================================
  const page2 = await browser.newPage();
  await page2.goto("data:text/html," + encodeURIComponent(PAGE2_HTML));
  // Tag the canvas by hand — pixels.ts only requires the data-fh-ref
  // attribute to exist, it doesn't care how it got there.
  await page2.evaluate(() => {
    (document as any).getElementById("c").setAttribute("data-fh-ref", "e1");
  });

  await page2.evaluate(() => {
    const canvas = (document as any).getElementById("c");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(20, 30, 50, 40); // first rect: x[20,70) y[30,70)
  });
  const pixelWatch = createPixelWatch(page2);
  const firstRead = await pixelWatch.summarize();
  const firstLineMatch = firstRead.text.split("\n").find((l) => l.startsWith("e1:"));
  assert(!!firstLineMatch, `expected a pixel line for e1 on first read:\n${firstRead.text}`);
  assert(
    !!firstLineMatch && /ink bbox \(\d+,\d+ \d+x\d+\)/.test(firstLineMatch),
    `expected first read to report an ink bbox for the first rect: ${firstLineMatch}`,
  );
  if (firstLineMatch) {
    const m = firstLineMatch.match(/ink bbox \((\d+),(\d+) (\d+)x(\d+)\)/);
    if (m) {
      const [bx, by, bw, bh] = m.slice(1).map(Number);
      // downsampled at stride 4, so allow slack around the true 20,30 50x40 rect
      assert(bx >= 12 && bx <= 28, `first ink bbox x ~20, got ${bx}`);
      assert(by >= 22 && by <= 38, `first ink bbox y ~30, got ${by}`);
      assert(bw >= 40 && bw <= 60, `first ink bbox w ~50, got ${bw}`);
      assert(bh >= 30 && bh <= 50, `first ink bbox h ~40, got ${bh}`);
    }
  }

  await page2.evaluate(() => {
    const canvas = (document as any).getElementById("c");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(200, 140, 30, 30); // second rect, well away from the first
  });
  const secondRead = await pixelWatch.summarize();
  const secondLineMatch = secondRead.text.split("\n").find((l) => l.startsWith("e1:"));
  assert(!!secondLineMatch, `expected a pixel line for e1 on second read:\n${secondRead.text}`);
  assert(
    !!secondLineMatch && /changed region \(\d+,\d+ \d+x\d+\)/.test(secondLineMatch),
    `expected second read to report a changed region: ${secondLineMatch}`,
  );
  if (secondLineMatch) {
    const m = secondLineMatch.match(/changed region \((\d+),(\d+) (\d+)x(\d+)\)/);
    if (m) {
      const [cx, cy] = m.slice(1).map(Number);
      // changed region should be near the SECOND rect (200,140), not the first (20,30)
      assert(cx >= 190 && cx <= 210, `changed region x ~200, got ${cx}`);
      assert(cy >= 130 && cy <= 150, `changed region y ~140, got ${cy}`);
    }
  }

  await page2.close();
  await browser.close();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nALL TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: unexpected error");
  console.error(err);
  process.exit(1);
});
