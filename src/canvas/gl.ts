// Scene introspector: reads a live WebGL scene graph (Three.js, or anything
// exposing .isScene/.isMesh/.isCamera on real objects) directly out of page
// globals and projects each named mesh to on-screen CSS pixel coordinates —
// no screenshot, no OCR. See SPEC.md "the thesis" and types.ts fixture
// contract for /scene3d.
//
// Deliberately does NOT import three: all matrix math is inlined into the
// page.evaluate closure so it runs against whatever THREE build the page
// itself loaded, with zero coupling to a version living in this repo.

import type { Page } from "playwright";

interface AnnotateResult {
  text: string;
  approxTokens: number;
  count: number;
}

// ---------- shape of what comes back out of page.evaluate ----------

interface MeshProjection {
  name: string;
  geometryLabel: string;
  colorHex: string | null;
  x: number;
  y: number;
  onScreen: boolean;
  behindCamera: boolean;
}

type EvalOutcome =
  | { kind: "none" }
  | { kind: "no-camera"; sceneCount: number }
  | { kind: "canvas-ambiguous"; canvasCount: number; webglCount: number }
  | { kind: "ok"; ref: string; sceneCount: number; meshes: MeshProjection[] };

export function createSceneIntrospector(page: Page): {
  annotate(): Promise<AnnotateResult>;
} {
  async function annotate(): Promise<AnnotateResult> {
    let outcome: EvalOutcome;
    try {
      outcome = await page.evaluate((): EvalOutcome => {
        const w = window as any;

        // ---------- 1. locate candidate (scene, camera) pairs ----------

        const seenScenes = new Set<any>();
        const entries: Array<{ scene: any; camera: any }> = [];

        function addEntry(scene: any, camera: any): void {
          if (!scene || typeof scene !== "object") return;
          const existing = entries.find((e) => e.scene === scene);
          if (existing) {
            if (!existing.camera && camera) existing.camera = camera;
            return;
          }
          if (seenScenes.has(scene)) return;
          seenScenes.add(scene);
          entries.push({ scene, camera: camera || null });
        }

        // known globals, in order of likelihood
        addEntry(w.__scene, w.__camera);
        addEntry(w.scene, w.camera || w.__camera);
        addEntry(w.__THREE_SCENE__, w.__camera || w.camera);

        // generic sweep: shallow, guarded, capped
        let keys: string[] = [];
        try {
          keys = Object.keys(w);
        } catch {
          keys = [];
        }

        const sweepCameras: any[] = [];
        const sweepScenes: any[] = [];
        let scanned = 0;
        for (const k of keys) {
          if (scanned >= 200) break;
          scanned++;
          let v: any;
          try {
            v = w[k];
          } catch {
            continue;
          }
          if (!v || typeof v !== "object") continue;
          try {
            if (v.isScene === true) sweepScenes.push(v);
            else if (v.isCamera === true) sweepCameras.push(v);
          } catch {
            continue;
          }
        }

        for (const s of sweepScenes) {
          addEntry(s, sweepCameras[0] || null);
        }

        // backfill cameras for any entry that still has none, from whatever
        // camera-shaped object we've seen anywhere
        const anyCamera = w.__camera || w.camera || sweepCameras[0] || null;
        for (const e of entries) {
          if (!e.camera && anyCamera) e.camera = anyCamera;
        }

        if (entries.length === 0) {
          return { kind: "none" };
        }

        const withCamera = entries.filter((e) => e.camera);
        if (withCamera.length === 0) {
          return { kind: "no-camera", sceneCount: entries.length };
        }

        // ---------- 2. locate the target canvas ----------

        const canvases = Array.from(document.querySelectorAll("canvas"));

        function detectCtxType(el: any): string | null {
          if (el.__fhCtxType) return el.__fhCtxType;
          try {
            if (el.getContext("webgl2")) return "webgl2";
          } catch {
            /* ignore */
          }
          try {
            if (el.getContext("webgl")) return "webgl";
          } catch {
            /* ignore */
          }
          return null;
        }

        let targetCanvas: any = null;
        if (canvases.length === 1) {
          targetCanvas = canvases[0];
        } else if (canvases.length > 1) {
          const webglCanvases = canvases.filter((c) => detectCtxType(c));
          if (webglCanvases.length === 1) {
            targetCanvas = webglCanvases[0];
          } else {
            return {
              kind: "canvas-ambiguous",
              canvasCount: canvases.length,
              webglCount: webglCanvases.length,
            };
          }
        } else {
          return { kind: "canvas-ambiguous", canvasCount: 0, webglCount: 0 };
        }

        const rect = targetCanvas.getBoundingClientRect();
        const cssWidth = rect.width || targetCanvas.clientWidth || targetCanvas.width;
        const cssHeight = rect.height || targetCanvas.clientHeight || targetCanvas.height;
        const ref = targetCanvas.getAttribute("data-fh-ref") || "(untagged canvas)";

        // ---------- 3. manual 4x4 matrix math (no THREE import) ----------
        // THREE stores Matrix4.elements column-major:
        //   elements = [n11,n21,n31,n41, n12,n22,n32,n42, n13,n23,n33,n43, n14,n24,n34,n44]

        function multiplyMat4(a: number[], b: number[]): number[] {
          const out = new Array(16).fill(0);
          for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
              let sum = 0;
              for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
              }
              out[col * 4 + row] = sum;
            }
          }
          return out;
        }

        function transformPoint(
          m: number[],
          x: number,
          y: number,
          z: number,
        ): { x: number; y: number; z: number; w: number } {
          const rx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const ry = m[1] * x + m[5] * y + m[9] * z + m[13];
          const rz = m[2] * x + m[6] * y + m[10] * z + m[14];
          const rw = m[3] * x + m[7] * y + m[11] * z + m[15];
          return { x: rx, y: ry, z: rz, w: rw };
        }

        // ---------- 4. traverse scenes, project qualifying meshes ----------

        const meshes: MeshProjection[] = [];
        let sceneCount = 0;

        for (const { scene, camera } of withCamera) {
          try {
            scene.updateMatrixWorld?.(true);
            camera.updateMatrixWorld?.(true);
          } catch {
            /* best effort */
          }

          const projMatrix: number[] | undefined = camera.projectionMatrix?.elements;
          const viewMatrix: number[] | undefined = camera.matrixWorldInverse?.elements;
          if (!projMatrix || !viewMatrix) continue;

          const viewProjection = multiplyMat4(projMatrix as number[], viewMatrix as number[]);

          let contributedAny = false;

          function visit(obj: any): void {
            if (!obj) return;
            if (obj.isMesh === true) {
              const name: string = typeof obj.name === "string" ? obj.name : "";
              let material = obj.material;
              if (Array.isArray(material)) material = material[0];
              let colorHex: string | null = null;
              try {
                if (material && material.color && typeof material.color.getHexString === "function") {
                  colorHex = "#" + material.color.getHexString();
                }
              } catch {
                colorHex = null;
              }

              if (name || colorHex) {
                let matrixWorld: number[] | undefined = obj.matrixWorld?.elements;
                if (matrixWorld) {
                  const wx = matrixWorld[12];
                  const wy = matrixWorld[13];
                  const wz = matrixWorld[14];

                  const clip = transformPoint(viewProjection, wx, wy, wz);
                  const behindCamera = clip.w <= 0;
                  let x = NaN;
                  let y = NaN;
                  let onScreen = false;
                  if (!behindCamera) {
                    const ndcX = clip.x / clip.w;
                    const ndcY = clip.y / clip.w;
                    x = ((ndcX + 1) / 2) * cssWidth;
                    y = ((1 - ndcY) / 2) * cssHeight;
                    onScreen = x >= 0 && x <= cssWidth && y >= 0 && y <= cssHeight;
                  }

                  let geometryLabel = "mesh";
                  try {
                    const gType: string | undefined = obj.geometry?.type;
                    if (gType) geometryLabel = gType.replace(/Geometry$/, "").toLowerCase() || "mesh";
                  } catch {
                    geometryLabel = "mesh";
                  }

                  meshes.push({
                    name: name || "(unnamed)",
                    geometryLabel,
                    colorHex,
                    x: Math.round(x),
                    y: Math.round(y),
                    onScreen,
                    behindCamera,
                  });
                  contributedAny = true;
                }
              }
            }
            const children = obj.children;
            if (Array.isArray(children)) {
              for (const c of children) visit(c);
            }
          }

          try {
            visit(scene);
          } catch {
            /* best effort per-scene */
          }

          if (contributedAny) sceneCount++;
        }

        return { kind: "ok", ref, sceneCount, meshes };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const text = `scene introspection failed: ${msg}`;
      return { text, approxTokens: Math.ceil(text.length / 4), count: 0 };
    }

    return formatOutcome(outcome);
  }

  return { annotate };
}

function formatOutcome(outcome: EvalOutcome): AnnotateResult {
  if (outcome.kind === "none") {
    return { text: "", approxTokens: 0, count: 0 };
  }

  if (outcome.kind === "no-camera") {
    const text = `scene3d: ${outcome.sceneCount} scene(s) found but no camera detected`;
    return { text, approxTokens: Math.ceil(text.length / 4), count: 0 };
  }

  if (outcome.kind === "canvas-ambiguous") {
    const text =
      outcome.canvasCount === 0
        ? "scene3d: no canvas elements found"
        : `scene3d: ${outcome.canvasCount} canvases found (${outcome.webglCount} webgl) - ambiguous, cannot determine target canvas`;
    return { text, approxTokens: Math.ceil(text.length / 4), count: 0 };
  }

  // kind === "ok"
  const { ref, sceneCount, meshes } = outcome;
  if (meshes.length === 0) {
    const text = `scene3d on canvas ${ref} (${sceneCount} scene${sceneCount === 1 ? "" : "s"}, 0 meshes): no named/colored meshes found`;
    return { text, approxTokens: Math.ceil(text.length / 4), count: 0 };
  }

  const lines: string[] = [];
  lines.push(
    `scene3d on canvas ${ref} (${sceneCount} scene${sceneCount === 1 ? "" : "s"}, ${meshes.length} mesh${meshes.length === 1 ? "" : "es"}):`,
  );
  for (const m of meshes) {
    const colorPart = m.colorHex ? ` ${m.colorHex}` : "";
    const status = m.behindCamera ? "off-screen (behind camera)" : m.onScreen ? "on-screen" : "off-screen";
    lines.push(`  "${m.name}" ${m.geometryLabel}${colorPart} @ (${m.x},${m.y}) ${status}`);
  }
  const text = lines.join("\n");
  return { text, approxTokens: Math.ceil(text.length / 4), count: meshes.length };
}
