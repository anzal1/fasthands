// fasthands artist: turn ANY image into a human-like stroke plan for ANY
// canvas the engine can observe. Strokes are curved polylines traced along
// the image's gradient tangent field — the direction a pen artist shades in —
// with deterministic hand jitter, ordered the way people draw: contours
// first, then tone, light to dark. The plan is plain Actions, so it runs
// through the standard guarded executor on whatever canvas app is in front
// of it (the whiteboard fixture, Excalidraw, a signature pad — anything that
// listens to pointer events).

import type { Page } from "playwright";
import type { Action } from "../types.ts";

export interface ArtistPlan {
  strokes: { path: { x: number; y: number }[] }[];
  stats: { contours: number; tone: number; capped: boolean; region: { w: number; h: number; ox: number; oy: number } };
}

export interface ArtistOptions {
  imageUrl: string;
  /** Board size in canvas CSS pixels. */
  board: { width: number; height: number };
  /** Crop of the source image to use, as fractions (default: whole image). */
  crop?: { top?: number; bottom?: number };
  maxStrokes?: number;
}

/** Analyze the image inside the page (CORS-clean sources only) and return a
 *  human-like stroke plan in board coordinates. */
export async function planHumanStrokes(page: Page, opts: ArtistOptions): Promise<ArtistPlan> {
  const { imageUrl, board } = opts;
  const cropTop = opts.crop?.top ?? 0;
  const cropBottom = opts.crop?.bottom ?? 1;
  const maxStrokes = opts.maxStrokes ?? 2400;

  return page.evaluate(
    async (args: {
      imageUrl: string;
      bw: number;
      bh: number;
      cropTop: number;
      cropBottom: number;
      maxStrokes: number;
    }) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("artist: image load failed"));
        img.src = args.imageUrl;
      });

      const sy = Math.round(img.naturalHeight * args.cropTop);
      const sh = Math.round(img.naturalHeight * (args.cropBottom - args.cropTop));
      const scale = Math.min((args.bw - 8) / img.naturalWidth, (args.bh - 8) / sh);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(sh * scale);
      const ox = Math.round((args.bw - w) / 2);
      const oy = Math.round((args.bh - h) / 2);

      const work = document.createElement("canvas");
      work.width = w;
      work.height = h;
      const wctx = work.getContext("2d", { willReadFrequently: true })!;
      wctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, w, h);
      const data = wctx.getImageData(0, 0, w, h).data;

      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      }
      const L = (x: number, y: number) => {
        const xi = Math.max(0, Math.min(w - 1, x | 0));
        const yi = Math.max(0, Math.min(h - 1, y | 0));
        return lum[yi * w + xi];
      };

      // Sobel gradients, lightly box-blurred so the tangent field is smooth
      // enough to trace flowing strokes through.
      const gxA = new Float32Array(w * h);
      const gyA = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const gx =
            L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) -
            L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1);
          const gy =
            L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) -
            L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1);
          gxA[y * w + x] = gx;
          gyA[y * w + x] = gy;
        }
      }
      const G = (arr: Float32Array, x: number, y: number) => {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            s += arr[Math.max(0, Math.min(h - 1, (y | 0) + dy)) * w + Math.max(0, Math.min(w - 1, (x | 0) + dx))];
        return s / 9;
      };

      // Tangent (stroke direction): perpendicular to the gradient. In flat
      // regions fall back to the pass's hatch angle so shading stays coherent.
      const tangent = (x: number, y: number, fallback: number): [number, number] => {
        const gx = G(gxA, x, y);
        const gy = G(gyA, x, y);
        const mag = Math.hypot(gx, gy);
        if (mag < 14) return [Math.cos(fallback), Math.sin(fallback)];
        return [-gy / mag, gx / mag];
      };

      // Deterministic "hand" jitter, no Math.random.
      const jitter = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.7;

      type P = { x: number; y: number };
      const trace = (
        sx: number,
        sy2: number,
        fallback: number,
        stopL: number,
        maxSteps: number,
      ): P[] => {
        const pts: P[] = [{ x: sx, y: sy2 }];
        for (const dir of [1, -1]) {
          let px = sx, py = sy2;
          let [tx, ty] = tangent(px, py, fallback);
          for (let s = 0; s < maxSteps; s++) {
            const nx = px + tx * 2.1 * dir;
            const ny = py + ty * 2.1 * dir;
            if (nx < 1 || nx >= w - 1 || ny < 1 || ny >= h - 1) break;
            if (L(nx, ny) >= stopL) break;
            const [ntx, nty] = tangent(nx, ny, fallback);
            if (ntx * tx + nty * ty < 0.25) break; // sharp turn: a human lifts the pen
            px = nx; py = ny; tx = ntx; ty = nty;
            if (dir === 1) pts.push({ x: px, y: py });
            else pts.unshift({ x: px, y: py });
          }
        }
        return pts;
      };

      const contours: P[][] = [];
      const tone: P[][] = [];

      // 1. Contours first, like a human: seed at strong edges, follow them.
      const seen = new Uint8Array(w * h);
      for (let y = 2; y < h - 2; y += 3) {
        for (let x = 2; x < w - 2; x += 3) {
          const mag = Math.hypot(G(gxA, x, y), G(gyA, x, y));
          if (mag > 90 && !seen[(y | 0) * w + (x | 0)]) {
            const pts = trace(x, y, 0, 999, 22);
            if (pts.length >= 4) {
              contours.push(pts);
              for (const p of pts) seen[(p.y | 0) * w + (p.x | 0)] = 1;
            }
          }
        }
      }

      // 2. Tone passes, light to dark; strokes flow along form.
      const passes = [
        { thr: 190, gap: 6, angle: 0.5 },
        { thr: 145, gap: 5, angle: -0.4 },
        { thr: 100, gap: 4, angle: 1.2 },
        { thr: 58, gap: 3, angle: 0.1 },
      ];
      for (const pass of passes) {
        for (let y = 2; y < h - 2; y += pass.gap) {
          for (let x = 2 + ((y / pass.gap) | 0) % 2; x < w - 2; x += pass.gap) {
            if (L(x, y) < pass.thr) {
              const pts = trace(x, y, pass.angle, pass.thr + 12, 9);
              if (pts.length >= 3) tone.push(pts);
            }
          }
        }
      }

      let all = [...contours, ...tone];
      const capped = all.length > args.maxStrokes;
      if (capped) {
        const kept: P[][] = [...contours];
        const budget = Math.max(0, args.maxStrokes - contours.length);
        const step = tone.length / budget;
        for (let i = 0; i < tone.length && kept.length < args.maxStrokes; i += step) {
          kept.push(tone[Math.floor(i)]);
        }
        all = kept;
      }

      const strokes = all.map((pts, si) => ({
        path: pts
          .slice(0, 60)
          .map((p, pi) => ({
            x: Math.round((p.x + ox + jitter(si, pi)) * 10) / 10,
            y: Math.round((p.y + oy + jitter(pi, si)) * 10) / 10,
          })),
      }));

      return {
        strokes,
        stats: { contours: contours.length, tone: tone.length, capped, region: { w, h, ox, oy } },
      };
    },
    { imageUrl, bw: board.width, bh: board.height, cropTop, cropBottom, maxStrokes },
  );
}

/** Convert a plan into executor batches targeting the given canvas ref. */
export function planToBatches(plan: ArtistPlan, canvasRef: string, batchSize = 120): Action[][] {
  const batches: Action[][] = [];
  for (let i = 0; i < plan.strokes.length; i += batchSize) {
    batches.push(
      plan.strokes.slice(i, i + batchSize).map((s) => ({ act: "stroke", ref: canvasRef, path: s.path })),
    );
  }
  return batches;
}
