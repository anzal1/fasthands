# Below the DOM: rasterization, WebGL, and what agents refuse to read

The core fasthands bet is that agents keep reading the *output* of a pipeline
when the *input* is sitting right there, machine-readable and token-cheap.
Above the DOM that meant HTML contracts (xray). Below the DOM the same bet
applies three more times.

## 1. Canvas 2D: tap the command stream, not the pixels

Rasterization is a one-way, information-destroying function. A chart exists
twice:

- as `ctx.fillText("Q3 $518k", 312, 40)` — exact string, exact position,
  ~10 tokens
- as ~300k pixels that a vision model OCRs back for ~1,366 image tokens,
  with errors

Every framework reads the second form. fasthands instruments
`CanvasRenderingContext2D` before the app draws (Playwright `addInitScript`,
so the wrapper exists before any page script runs) and records the display
list per canvas: text ops verbatim, rects, path bounding boxes, transforms
applied at call time. The observation then contains what the canvas *means*,
not what it looks like. No OCR anywhere in the pipeline, so text recovery is
lossless by construction.

## 2. Stateless pixels: diff the raster like we diff the DOM

Some canvases really are just pixels (signature pads, games, image editors).
The fallback is not "send a screenshot" — it is the raster analog of our DOM
diff: an in-page downsampled snapshot per canvas, compared between
observations, reported as "changed region (x,y WxH)" or "no visible change"
for ~20 tokens. This also closes the drawing loop: after a `stroke` action the
agent can *verify its own ink landed* without any vision model.

Honesty: `getImageData` throws on tainted (cross-origin) canvases and lies for
GPU-backed contexts without `preserveDrawingBuffer`. We detect both (the tap
records which context type each canvas requested) and say "pixels unreadable"
rather than reporting garbage.

## 3. WebGL / 3D: the scene graph is the ground truth

A Three.js/Babylon scene is not pixels; it is a tree of named objects with
world transforms and a camera. Project any object's world position through the
camera's matrices and you get its exact screen coordinate. fasthands' scene
introspector finds scenes (deliberate `window.__scene` exposure, or a guarded
sweep for `.isScene` objects), does the 4x4 projection math inline (no
framework import needed), and reports:

    "red crate" box #ff4444 @ (142,208) on-screen

A guarded `pointer` action then clicks a 3D object with zero vision. Known
limits, stated plainly: occlusion is not modeled (the projected center can be
behind another mesh); Babylon/Pixi share the pattern but only Three.js is
tested; animated scenes move between observation and click — the drift guard
protects the canvas element, not the scene state.

## 4. WebGPU: where the honesty line sits

Raw WebGPU compute/render pipelines have no semantic layer to tap — buffers
and shaders don't carry names or text. Framework scenes running on WebGPU
renderers (Three's WebGPURenderer, Babylon) still expose scene graphs, so
introspection covers them. Everything else is legitimately vision territory:
the right tool is a screenshot cropped to the canvas region, on demand, not a
tap. We say so rather than pretend.

## 5. Motion: the browser announces when it's done

`document.getAnimations()` reports every running CSS/Web animation and each
one's `finished` promise. Agents everywhere sleep fixed milliseconds and
either wait too long or observe mid-transition. The fasthands executor awaits
finite animations (infinite spinners excluded, 800ms cap) after each click —
settling exactly as long as the page needs, no longer.

## New actions

- `{"act":"pointer","ref":"e14","x":312,"y":180}` — click at CSS-pixel
  coordinates relative to the ref's box. Out-of-bounds coordinates are
  rejected before firing, and the ref is drift-guarded like any click.
- `{"act":"stroke","ref":"e14","path":[{"x":50,"y":50},…]}` — pointerdown →
  interpolated moves → pointerup. Drawing, sliders, orbit. Max 64 points.

Everything above regenerates from `src/canvas/*.test.ts` and the
whiteboard / chart / scene3d benchmark tasks.
