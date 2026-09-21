# Firefly

Firefly (`@flies/firefly`) is Flies' custom TypeScript drawing library for a WebGL 2
`<canvas>`. It uses browser WebGL directly, with no third-party graphics engine or
animation ticker. The editor integration lives in `packages/canvas/src/webgl`;
Firefly itself does not depend on the editor's document model, React, or Tauri.

In Flies, open the project menu and enable **Use Firefly renderer**. The choice
persists across sessions; switching renderers keeps the current document and history.

## Draw a frame

```ts
import { Firefly, parseColor, type Matrix } from "@flies/firefly";

const canvas = document.querySelector<HTMLCanvasElement>("#artwork")!;
const renderer = new Firefly(canvas, (error) => {
  // The application owns recovery or switching to its fallback renderer.
  console.error(error);
});
const camera: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function draw() {
  renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
  renderer.begin();
  renderer.rect({ x: 32, y: 32, width: 240, height: 160 }, camera, parseColor("#ffbd45"), 16);
}

requestAnimationFrame(draw);
// Call renderer.destroy() when disposing the canvas.
```

The host gives the canvas a CSS size and schedules frames when its content or
camera changes. Coordinates use logical pixels with the origin at the top left;
`resize` scales the drawing buffer for the supplied pixel ratio. `Matrix` uses the
same six affine values as a CSS 2D transform. `parseColor` accepts hexadecimal RGB
or RGBA strings and returns normalized RGBA components.

## Drawing and ownership

- `begin()` selects and clears the canvas target and resets `drawCalls`.
- `rect(rect, transform, color, radius?, opacity?)` draws a rounded rectangle.
- `texture(sourceCanvas)` uploads a raster canvas; `image(texture, rect, transform,
opacity?)` draws it. Keep textures between frames, and call `deleteTexture` when
  replacing or removing them.
- `clip(rect, transform, radius, true)` pushes a rounded stencil clip. Pop it with
  the same geometry and `false`; nested clips intersect.
- `acquire()` and `release(surface)` manage reusable offscreen surfaces. Select
  one with `target(surface)`, then `clear()` before drawing into it. `getTarget()`
  returns the current surface and clip depth so the caller can restore both.
- `composite(surface, opacity)` draws an offscreen surface onto the current target.
- `filter(surface, filters, scale)` consumes the source surface and returns the
  filtered surface. Filters include blur, brightness, contrast, saturation,
  grayscale, sepia, inversion, and hue rotation. The caller releases the returned
  surface after compositing it.
- `destroy()` removes listeners and releases all GPU resources. Calling it again
  is safe.

`drawCalls`, `textureUploads`, and `textureBytes` expose rendering counters;
`maxTextureSize` exposes the device's texture limit. Allocation and initialization
errors throw. WebGL context loss invokes the constructor's error callback. The
editor adapter handles these failures by retaining the live document and
switching to HTML artwork.

Text, imported SVG, gradients, images, and shadows are prepared by the editor
adapter as cached textures. Firefly performs the canvas compositing, transforms,
clipping, and filter passes. Hardware and document complexity determine frame
rates; software browser rendering tests verify behavior rather than hardware
performance.

## Effects outside the viewport

Pass optional logical padding to `resize(width, height, pixelRatio, padding)` when
an effect can bring offscreen content into view. Add `effectPadding` to the
camera translation. `begin()` then draws into a persistent expanded scene;
`present()` copies its visible center to the canvas. With no padding, `present()`
is a no-op. The Flies adapter derives padding from nested blur extents and calls
`present()` automatically. Texture counters include mip levels, but exclude
stencil buffers, browser bookkeeping, and CPU-side image caches.

## Measured performance

Measured on an Apple M4 using Chromium's native ANGLE Metal backend, at a
1280 × 720 CSS-pixel viewport on 2026-09-22. Each phase used 150 warmup frames and
150 sampled frames. Both 1,000- and 5,000-node mixed documents passed normal-zoom
and fit-all panning, subtree dragging, auto-layout resizing, and text-preview
updates. The fit-all 5,000-node case issued 6,500 draw calls per frame.

| Density   | 5,000-node fit-all frame p95 | Renderer CPU p95 | Texture allocation |
| --------- | ---------------------------- | ---------------- | ------------------ |
| 2× Retina | 16.7–16.8 ms                 | 6.0–6.2 ms       | Peak 44.6 MiB      |

A headed 2× Retina run on the same machine's real 120 Hz display also passed all
phases for 1,000 nodes at fit-all and 5,000 nodes at normal zoom (frame p95
8.4–9.2 ms; renderer CPU p95 1.7–2.0 ms and 0.9–1.5 ms, respectively).
The 5,000-node fit-all case exceeded the 120 Hz budget (CPU p95 9.1–9.7 ms,
frame p95 16.6–16.7 ms); use its verified 60 Hz result above. These are measured
workload limits, not a universal FPS guarantee. Panning and dragging reused textures;
idle rendering stopped. Textures use zoom-aware resolution and mipmaps; solid
shapes use analytic antialiasing in shaders. The DOM renderer remains the default
and is also the fallback if WebGL2 initialization fails or the context is lost.

Reproduce the native hardware benchmark on macOS:

```sh
FLIES_GPU_HARDWARE=1 FLIES_GPU_TARGET_FPS=60 FLIES_GPU_DPR=2 \
  bunx playwright test --config playwright.gpu.config.ts scripts/gpu-tests/performance.spec.ts
```

Set `FLIES_GPU_HEADED=1 FLIES_GPU_TARGET_FPS=120` for the real-display 120 Hz
check. Its 5,000-node fit-all phase currently fails the unchanged frame budget;
the JSON attachment records each phase independently. These benchmarks exercise
the shared document and renderer paths, excluding surrounding React editor panels.

The hardware tests reject software GPU backends. The regular `bun run test:gpu`
suite uses software rendering for reproducible visual, interaction, MCP, and
fallback checks; its timings are not hardware FPS measurements.
