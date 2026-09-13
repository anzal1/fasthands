// fasthands — src/canvas/tap.ts
//
// THE THESIS (see SPEC.md): a canvas chart exists as ctx.fillText("Q3 $518k",
// 312, 40) — exact, token-cheap — before it ever exists as pixels. This
// module taps the 2D command stream at the call site, before rasterization
// throws that information away, instead of reading it back out of pixels
// (vision/OCR) after the fact.
//
// install() patches HTMLCanvasElement.prototype.getContext via
// page.addInitScript BEFORE any page script runs, so every 2D context ever
// handed out is instrumented from its first draw call. Recording is a pure
// push onto a per-canvas array (el.__fhOps) — no serialization, no
// allocation beyond the pushed object — so the draw-time cost stays flat.
// annotate() does the (comparatively expensive) formatting work later, in
// Node, off the hot path.
//
// Cross-module convention: canvases get a `__fhCtxType` marker recording
// whatever context type was first requested from them ("2d", "webgl",
// "webgl2", "webgpu", "bitmaprenderer", ...). src/canvas/gl.ts's scene
// introspector already reads this same property to skip a probing
// getContext() call. src/canvas/pixels.ts reads it to give an honest
// "GPU-backed, can't read pixels" answer instead of pretending to summarize
// a WebGL canvas's backing store.

import type { Page } from "playwright";
import { createPixelWatch } from "./pixels.ts";

// ---------------------------------------------------------------------------
// Ambient shims: this file is type-checked under a tsconfig with no "dom"
// lib entry (see src/observe/engine.ts for the established precedent — we
// can't touch tsconfig.json). Every identifier below only ever exists
// inside a page.addInitScript()/page.evaluate() callback, i.e. the browser
// realm, never the Node realm this file is stripped-and-run in.
// ---------------------------------------------------------------------------
declare const document: any;
declare const HTMLCanvasElement: any;
declare const OffscreenCanvas: any;
declare const DOMPoint: any;

export interface CanvasTap {
  /** Must be called BEFORE page.goto — installs via page.addInitScript.
   *  NOTE: page.addInitScript only replays on an actual navigation (goto, or
   *  a link click) — page.setContent() does NOT trigger it in current
   *  Playwright, so a page whose HTML is injected via setContent() will
   *  never see the getContext() patch applied. Use page.goto() (a real URL,
   *  or a data: URL) for any page you intend to tap. */
  install(): Promise<void>;
  /** Summarize the display list per canvas, keyed by data-fh-ref (call after
   *  an observe so canvases are tagged). Includes a pixel-diff line from
   *  src/canvas/pixels.ts for any tagged canvas with zero recorded ops. */
  annotate(): Promise<{ text: string; approxTokens: number; count: number }>;
}

// ---------- shape of what comes back out of the annotate() evaluate ----------

interface RawOp {
  type: "text" | "rect" | "path" | "arc" | "image" | "cleared";
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: number;
}

interface RawCanvas {
  ref: string;
  name: string;
  cssW: number;
  cssH: number;
  scaleX: number;
  scaleY: number;
  ops: RawOp[];
  dropped: number;
  sinceLast: number;
  ctxType: string | null;
}

const MAX_LINES_PER_CANVAS = 40;

// ---------------------------------------------------------------------------
// The in-page instrumentation installed via addInitScript. Must be a single
// self-contained function: addInitScript serializes it via toString() and
// re-executes it in the browser realm, so it cannot close over anything
// from this module's Node-side scope.
// ---------------------------------------------------------------------------
function fhInstallCanvasTap(): void {
  const w = window as any;
  if (w.__fhCanvasTapInstalled) return;
  w.__fhCanvasTapInstalled = true;

  const MAX_OPS = 500;

  function pushOp(canvas: any, op: any): void {
    if (!canvas.__fhOps) {
      canvas.__fhOps = [];
      canvas.__fhDropped = 0;
      canvas.__fhOpCounter = 0;
    }
    canvas.__fhOpCounter++;
    if (canvas.__fhOps.length >= MAX_OPS) {
      canvas.__fhOps.shift();
      canvas.__fhDropped++;
    }
    canvas.__fhOps.push(op);
  }

  function markCleared(canvas: any): void {
    canvas.__fhOps = [{ type: "cleared" }];
    canvas.__fhDropped = 0;
    canvas.__fhOpCounter = (canvas.__fhOpCounter || 0) + 1;
  }

  // Apply the CURRENT transform (ctx.getTransform()) to a user-space point,
  // so recorded coordinates are canvas-buffer coordinates regardless of any
  // translate/scale/rotate the page applied before drawing.
  function xf(ctx: any, x: number, y: number): { x: number; y: number } {
    const m = ctx.getTransform();
    const p = m.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }

  function wrap2D(canvas: any, ctx: any): any {
    if (ctx.__fhWrapped) return ctx;
    ctx.__fhWrapped = true;
    canvas.__fhCtxType = "2d";

    // Path points accumulate from moveTo/lineTo/bezierCurveTo/
    // quadraticCurveTo since the last beginPath(), matching how the browser
    // itself tracks the "current path" — stroke()/fill() consume whatever
    // has accumulated so far without requiring a fresh beginPath() first.
    let pathPoints: { x: number; y: number }[] = [];

    const origBeginPath = ctx.beginPath.bind(ctx);
    ctx.beginPath = (...args: any[]) => {
      pathPoints = [];
      return origBeginPath(...args);
    };

    function wrapPointMethod(name: string): void {
      const orig = ctx[name] && ctx[name].bind(ctx);
      if (!orig) return;
      ctx[name] = (...args: any[]) => {
        for (let i = 0; i + 1 < args.length; i += 2) {
          pathPoints.push(xf(ctx, args[i], args[i + 1]));
        }
        return orig(...args);
      };
    }
    wrapPointMethod("moveTo");
    wrapPointMethod("lineTo");
    wrapPointMethod("bezierCurveTo");
    wrapPointMethod("quadraticCurveTo");

    function recordPath(): void {
      if (pathPoints.length === 0) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pathPoints) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      pushOp(canvas, {
        type: "path",
        points: pathPoints.length,
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      });
    }

    const origStroke = ctx.stroke.bind(ctx);
    ctx.stroke = (...args: any[]) => {
      recordPath();
      return origStroke(...args);
    };
    const origFill = ctx.fill.bind(ctx);
    ctx.fill = (...args: any[]) => {
      recordPath();
      return origFill(...args);
    };

    function wrapTextMethod(name: string): void {
      const orig = ctx[name] && ctx[name].bind(ctx);
      if (!orig) return;
      ctx[name] = (text: any, x: number, y: number, ...rest: any[]) => {
        const p = xf(ctx, x, y);
        pushOp(canvas, { type: "text", text: String(text), x: p.x, y: p.y });
        return orig(text, x, y, ...rest);
      };
    }
    wrapTextMethod("fillText");
    wrapTextMethod("strokeText");

    function wrapRectMethod(name: string): void {
      const orig = ctx[name] && ctx[name].bind(ctx);
      if (!orig) return;
      ctx[name] = (x: number, y: number, rw: number, rh: number, ...rest: any[]) => {
        const p1 = xf(ctx, x, y);
        const p2 = xf(ctx, x + rw, y + rh);
        const rx = Math.min(p1.x, p2.x);
        const ry = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);
        if (
          name === "clearRect" &&
          rx <= 0 &&
          ry <= 0 &&
          rx + w >= canvas.width &&
          ry + h >= canvas.height
        ) {
          markCleared(canvas);
          return orig(x, y, rw, rh, ...rest);
        }
        pushOp(canvas, { type: "rect", x: rx, y: ry, w, h });
        return orig(x, y, rw, rh, ...rest);
      };
    }
    wrapRectMethod("fillRect");
    wrapRectMethod("strokeRect");
    wrapRectMethod("clearRect");

    function wrapCenterMethod(name: string): void {
      const orig = ctx[name] && ctx[name].bind(ctx);
      if (!orig) return;
      ctx[name] = (x: number, y: number, ...rest: any[]) => {
        const p = xf(ctx, x, y);
        pushOp(canvas, { type: "arc", x: p.x, y: p.y });
        return orig(x, y, ...rest);
      };
    }
    wrapCenterMethod("arc");
    wrapCenterMethod("ellipse");

    const origDrawImage = ctx.drawImage && ctx.drawImage.bind(ctx);
    if (origDrawImage) {
      ctx.drawImage = (...args: any[]) => {
        let dx: number, dy: number, dw: number, dh: number;
        if (args.length >= 9) {
          dx = args[5];
          dy = args[6];
          dw = args[7];
          dh = args[8];
        } else if (args.length >= 5) {
          dx = args[1];
          dy = args[2];
          dw = args[3];
          dh = args[4];
        } else {
          dx = args[1];
          dy = args[2];
          const img = args[0];
          dw = (img && (img.width || img.videoWidth)) || 0;
          dh = (img && (img.height || img.videoHeight)) || 0;
        }
        const p1 = xf(ctx, dx, dy);
        const p2 = xf(ctx, dx + dw, dy + dh);
        pushOp(canvas, {
          type: "image",
          x: Math.min(p1.x, p2.x),
          y: Math.min(p1.y, p2.y),
          w: Math.abs(p2.x - p1.x),
          h: Math.abs(p2.y - p1.y),
        });
        return origDrawImage(...args);
      };
    }

    // putImageData writes raw pixels directly into the backing store — the
    // one 2D call that genuinely bypasses the "command stream, not pixels"
    // story, since the payload IS pixels. We still record its destination
    // rect (cheap, no pixel data touched) so annotate() can at least say
    // *where* a raster blob landed instead of staying silent about it.
    // Per spec, putImageData ignores the current transformation matrix
    // entirely — coordinates are always raw canvas-buffer pixels — so we
    // deliberately do NOT run these through xf().
    const origPutImageData = ctx.putImageData && ctx.putImageData.bind(ctx);
    if (origPutImageData) {
      ctx.putImageData = (imageData: any, dx: number, dy: number, ...rest: any[]) => {
        const dirtyW = rest.length >= 3 ? rest[2] : imageData && imageData.width;
        const dirtyH = rest.length >= 4 ? rest[3] : imageData && imageData.height;
        pushOp(canvas, { type: "image", x: dx, y: dy, w: dirtyW || 0, h: dirtyH || 0 });
        return origPutImageData(imageData, dx, dy, ...rest);
      };
    }

    return ctx;
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: any, contextType: string, ...rest: any[]) {
    const ctx = origGetContext.call(this, contextType, ...rest);
    if (ctx && contextType === "2d") {
      wrap2D(this, ctx);
    } else if (ctx && !this.__fhCtxType) {
      this.__fhCtxType = contextType;
    }
    return ctx;
  };

  // OffscreenCanvas gets the same instrumentation IF straightforward — it
  // exposes the identical getContext("2d") surface, so wrap2D works
  // unmodified. LIMITATION: an OffscreenCanvas has no DOM presence (it's
  // never an element the walker can tag with data-fh-ref), so ops recorded
  // here are only reachable if the page later transfers/draws the
  // OffscreenCanvas onto a tagged <canvas> via drawImage/transferToImageBitmap
  // — annotate() has no way to discover an untagged OffscreenCanvas on its
  // own. We wrap it anyway so ops aren't silently lost for that composited
  // path, but a bare, never-composited OffscreenCanvas is invisible to
  // annotate() by construction.
  if (typeof OffscreenCanvas !== "undefined" && OffscreenCanvas.prototype && OffscreenCanvas.prototype.getContext) {
    const origOffscreenGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (this: any, contextType: string, ...rest: any[]) {
      const ctx = origOffscreenGetContext.call(this, contextType, ...rest);
      if (ctx && contextType === "2d") {
        wrap2D(this, ctx);
      } else if (ctx && !this.__fhCtxType) {
        this.__fhCtxType = contextType;
      }
      return ctx;
    };
  }
}

// ---------------------------------------------------------------------------
// The in-page read side for annotate(): pulls __fhOps off every tagged
// canvas, converts buffer-space coordinates to CSS-pixel space, and bumps
// each canvas's "last annotated" counter so the next call's "N ops since
// last annotate" is accurate. No formatting here — that happens in Node,
// see formatCanvas() below — this evaluate only reads/normalizes data.
// ---------------------------------------------------------------------------
function fhReadCanvasOps(): RawCanvas[] {
  const canvases = Array.from(document.querySelectorAll("canvas[data-fh-ref]"));
  const out: RawCanvas[] = [];
  for (const canvas of canvases as any[]) {
    const ref = canvas.getAttribute("data-fh-ref");
    if (!ref) continue;
    const name = canvas.getAttribute("aria-label") || canvas.getAttribute("title") || "";
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width) || canvas.width || 0;
    const cssH = Math.round(rect.height) || canvas.height || 0;
    const bufW = canvas.width || cssW || 1;
    const bufH = canvas.height || cssH || 1;
    const scaleX = cssW > 0 ? bufW / cssW : 1;
    const scaleY = cssH > 0 ? bufH / cssH : 1;

    const ops: any[] = canvas.__fhOps || [];
    const dropped = canvas.__fhDropped || 0;
    const opCounter = canvas.__fhOpCounter || 0;
    const sinceLast = opCounter - (canvas.__fhLastAnnotatedCounter || 0);
    canvas.__fhLastAnnotatedCounter = opCounter;

    out.push({
      ref,
      name,
      cssW,
      cssH,
      scaleX,
      scaleY,
      ops,
      dropped,
      sinceLast,
      ctxType: canvas.__fhCtxType || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Node-side formatting.
// ---------------------------------------------------------------------------

function fmtNum(n: number, scale: number): number {
  return Math.round(n / scale);
}

// Never cuts a verbatim string below 60 chars — the crown jewel here is the
// exact text a chart/label drew, so we only trim absurdly long strings, and
// always leave a generous prefix.
function fmtText(s: string): string {
  const MAX = 300;
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + "…";
}

function formatOp(op: RawOp, scaleX: number, scaleY: number): string {
  switch (op.type) {
    case "text":
      return `text "${fmtText(op.text || "")}" @ (${fmtNum(op.x!, scaleX)},${fmtNum(op.y!, scaleY)})`;
    case "rect":
      return `rect (${fmtNum(op.x!, scaleX)},${fmtNum(op.y!, scaleY)} ${fmtNum(op.w!, scaleX)}x${fmtNum(op.h!, scaleY)})`;
    case "path":
      return `path ${op.points}pts bbox (${fmtNum(op.x!, scaleX)},${fmtNum(op.y!, scaleY)} ${fmtNum(op.w!, scaleX)}x${fmtNum(op.h!, scaleY)})`;
    case "arc":
      return `arc @ (${fmtNum(op.x!, scaleX)},${fmtNum(op.y!, scaleY)})`;
    case "image":
      return `image (${fmtNum(op.x!, scaleX)},${fmtNum(op.y!, scaleY)} ${fmtNum(op.w!, scaleX)}x${fmtNum(op.h!, scaleY)})`;
    case "cleared":
      return "cleared";
    default:
      return op.type;
  }
}

function formatCanvasBlock(c: RawCanvas, pixelLine: string | undefined): string {
  const header = `canvas ${c.ref} "${c.name}" (${c.cssW}x${c.cssH}):`;
  if (c.ops.length === 0) {
    const line = pixelLine || "no recorded ops, no pixel data";
    return `${header}\n  ${line}`;
  }
  const lines: string[] = [];
  const shown = c.ops.slice(-MAX_LINES_PER_CANVAS);
  const omitted = c.ops.length - shown.length;
  if (omitted > 0) lines.push(`… ${omitted} earlier ops omitted (showing most recent ${MAX_LINES_PER_CANVAS})`);
  for (const op of shown) lines.push(formatOp(op, c.scaleX, c.scaleY));
  if (c.dropped > 0) lines.push(`… ${c.dropped} ops dropped by the 500-op ring buffer cap`);
  lines.push(`${c.sinceLast} ops since last annotate`);
  return `${header}\n  ${lines.join("\n  ")}`;
}

export function createCanvasTap(page: Page): CanvasTap {
  const pixelWatch = createPixelWatch(page);

  return {
    async install(): Promise<void> {
      await page.addInitScript(fhInstallCanvasTap);
    },

    async annotate() {
      const canvases = await page.evaluate(fhReadCanvasOps);

      const needsPixelFallback = canvases.some((c) => c.ops.length === 0);
      const pixelLines = new Map<string, string>();
      if (needsPixelFallback) {
        const pixelResult = await pixelWatch.summarize();
        for (const line of pixelResult.text.split("\n")) {
          const m = line.match(/^(e\d+):\s?(.*)$/);
          if (m) pixelLines.set(m[1], m[2]);
        }
      }

      const blocks = canvases.map((c) => formatCanvasBlock(c, pixelLines.get(c.ref)));
      const text = blocks.join("\n\n");
      return { text, approxTokens: Math.ceil(text.length / 4), count: canvases.length };
    },
  };
}
