// fasthands — src/canvas/pixels.ts
//
// The raster-diff fallback. Per SPEC.md's thesis, rasterization is a
// one-way, information-destroying function — the command stream (see
// src/canvas/tap.ts) is always preferable when it's available. This module
// exists for the cases where it genuinely isn't: a canvas painted before
// tap.install() ran, a <canvas> whose ops the tap couldn't attribute (a
// separably-drawn OffscreenCanvas composited in), or content this repo
// simply doesn't instrument yet. Even then, we refuse to ship pixels or an
// OCR pass — we report only the CHANGED REGION, downsampled, honestly
// caveated when the read is unreliable.
//
// Cross-module convention: reads the `__fhCtxType` marker that
// src/canvas/tap.ts's getContext wrapper leaves on every canvas it sees
// (also read by src/canvas/gl.ts) to give a straight answer about
// GPU-backed canvases instead of misreporting a blank/garbage read.

import type { Page } from "playwright";

// ---------------------------------------------------------------------------
// Ambient shims — see src/observe/engine.ts for why: no "dom" lib entry in
// tsconfig.json (out of scope to change), and every identifier below only
// ever runs inside a page.evaluate() callback in the browser realm.
// ---------------------------------------------------------------------------
declare const document: any;
declare const Uint8ClampedArray: any;

export interface PixelWatch {
  /** Per tagged canvas: ink bounding box + changed-region-since-last-call.
   *  Uses in-page getImageData downsampled (sample every 4th px). */
  summarize(): Promise<{ text: string; approxTokens: number }>;
}

// ---------------------------------------------------------------------------
// In-page evaluate: for every tagged canvas, either report why pixels can't
// be read honestly (tainted / GPU-backed / zero-size), or downsample its
// current backing store, compare against the downsampled snapshot from the
// last call (kept on the element as __fhPix), and report an ink bbox (first
// call) or a changed region (later calls). Runs as ONE page.evaluate for all
// tagged canvases, same shape as tap.ts's read side.
//
// NOTE: page.evaluate(fn) serializes `fn` via toString() and re-executes it
// in the browser realm — it cannot close over this module's outer scope, so
// the downsample stride constant is declared INSIDE the function body (a
// module-level `const SAMPLE` above it would silently vanish at runtime).
// ---------------------------------------------------------------------------
function fhSummarizePixels(): { ref: string; line: string }[] {
  // Downsample stride: sample every 4th pixel in each dimension (16x fewer
  // samples than full resolution) — plenty to bound a changed region
  // without paying for a full-resolution pixel compare every call.
  const SAMPLE = 4;
  const canvases = Array.from(document.querySelectorAll("canvas[data-fh-ref]"));
  const out: { ref: string; line: string }[] = [];

  function pixelEq(a: any, ai: number, b: any, bi: number): boolean {
    return a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3];
  }

  for (const canvas of canvases as any[]) {
    const ref = canvas.getAttribute("data-fh-ref");
    if (!ref) continue;

    // HONESTY REQUIREMENT #1: a canvas that asked for a GPU (or WebGPU)
    // context never gets a pixel read here — its backing store isn't a 2D
    // bitmap we can safely getImageData() (and without
    // preserveDrawingBuffer, a fresh readback is often blank garbage even
    // when it "succeeds"). Point at the scene introspector instead.
    const ctxType = canvas.__fhCtxType;
    if (ctxType && ctxType !== "2d") {
      out.push({ ref, line: `${ref}: GPU-backed canvas (${ctxType}) — see scene introspection` });
      continue;
    }

    const w: number = canvas.width;
    const h: number = canvas.height;
    if (!w || !h) {
      out.push({ ref, line: `${ref}: pixels unreadable (zero-size canvas)` });
      continue;
    }

    // HONESTY REQUIREMENT #2: getImageData() throws on a tainted canvas
    // (cross-origin image/video drawn without CORS clearance). Catch it and
    // say so instead of propagating the exception up through annotate().
    let data: any;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        out.push({ ref, line: `${ref}: pixels unreadable (tainted or GPU-backed)` });
        continue;
      }
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      out.push({ ref, line: `${ref}: pixels unreadable (tainted or GPU-backed)` });
      continue;
    }

    const cols = Math.max(1, Math.ceil(w / SAMPLE));
    const rows = Math.max(1, Math.ceil(h / SAMPLE));
    const sampled = new Uint8ClampedArray(cols * rows * 4);
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const sx = Math.min(rx * SAMPLE, w - 1);
        const sy = Math.min(ry * SAMPLE, h - 1);
        const si = (sy * w + sx) * 4;
        const di = (ry * cols + rx) * 4;
        sampled[di] = data[si];
        sampled[di + 1] = data[si + 1];
        sampled[di + 2] = data[si + 2];
        sampled[di + 3] = data[si + 3];
      }
    }

    // Background = the modal color among the four corner samples (the
    // corner shared by the most other corners; falls back to top-left).
    const cornerIdx = [0, cols - 1, (rows - 1) * cols, (rows - 1) * cols + cols - 1];
    let bgIdx = cornerIdx[0];
    let bestCount = 0;
    for (const ci of cornerIdx) {
      let count = 0;
      for (const cj of cornerIdx) {
        if (pixelEq(sampled, ci * 4, sampled, cj * 4)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bgIdx = ci;
      }
    }
    const bgOff = bgIdx * 4;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let ink = 0;
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const di = (ry * cols + rx) * 4;
        if (!pixelEq(sampled, di, sampled, bgOff)) {
          ink++;
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx > maxX) maxX = rx;
          if (ry > maxY) maxY = ry;
        }
      }
    }

    const prev = canvas.__fhPix;
    const prevDims = canvas.__fhPixDims;
    const isFirstRead = !prev || !prevDims || prevDims.cols !== cols || prevDims.rows !== rows;

    let line: string;
    if (isFirstRead) {
      if (ink === 0) {
        line = `${ref}: ink bbox none, 0% inked`;
      } else {
        const bx = minX * SAMPLE;
        const by = minY * SAMPLE;
        const bw = (maxX - minX + 1) * SAMPLE;
        const bh = (maxY - minY + 1) * SAMPLE;
        const pct = Math.round((ink / (cols * rows)) * 100);
        line = `${ref}: ink bbox (${bx},${by} ${bw}x${bh}), ~${pct}% inked`;
      }
    } else {
      let cMinX = Infinity;
      let cMinY = Infinity;
      let cMaxX = -Infinity;
      let cMaxY = -Infinity;
      let changed = 0;
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const di = (ry * cols + rx) * 4;
          if (!pixelEq(sampled, di, prev, di)) {
            changed++;
            if (rx < cMinX) cMinX = rx;
            if (ry < cMinY) cMinY = ry;
            if (rx > cMaxX) cMaxX = rx;
            if (ry > cMaxY) cMaxY = ry;
          }
        }
      }
      if (changed === 0) {
        line = `${ref}: no visible change`;
      } else {
        const bx = cMinX * SAMPLE;
        const by = cMinY * SAMPLE;
        const bw = (cMaxX - cMinX + 1) * SAMPLE;
        const bh = (cMaxY - cMinY + 1) * SAMPLE;
        line = `${ref}: changed region (${bx},${by} ${bw}x${bh})`;
      }
    }

    canvas.__fhPix = sampled;
    canvas.__fhPixDims = { cols, rows };
    out.push({ ref, line });
  }

  return out;
}

export function createPixelWatch(page: Page): PixelWatch {
  return {
    async summarize() {
      const rows = await page.evaluate(fhSummarizePixels);
      const text = rows.map((r) => r.line).join("\n");
      return { text, approxTokens: Math.ceil(text.length / 4) };
    },
  };
}
