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
  renderer.present();
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

- `begin()` selects and clears the canvas target and resets frame counters.
- `present()` flushes ordered artwork batches and presents the visible scene. Call
  it after submitting every frame; `flush()` submits a batch without presenting.
- `rect(rect, transform, color, radius?, opacity?)` draws a rounded rectangle.
- `texture(sourceCanvas)` uploads a raster canvas; `image(texture, rect, transform,
opacity?)` draws it. Keep textures between frames, and call `deleteTexture` when
  replacing or removing them.
- `clip(rect, transform, radius, true)` pushes a rounded stencil clip. Pop it with
  the same geometry and `false`; nested clips intersect.
- `acquire(bounds?)` and `release(surface)` manage reusable offscreen surfaces.
  Optional bounds use scene coordinates and allocate only the covered physical
  pixels; omitted bounds cover the scene. Select
  one with `target(surface)`, then `clear()` before drawing into it. `getTarget()`
  returns the current surface and clip depth so the caller can restore both.
- `composite(surface, opacity)` draws an offscreen surface onto the current target.
- `filter(surface, filters, scale)` consumes the source surface and returns the
  filtered surface. Filters include blur, brightness, contrast, saturation,
  grayscale, sepia, inversion, and hue rotation. The caller releases the returned
  surface after compositing it.
- `mask(content, alpha)` consumes two distinct surfaces with matching bounds and
  returns their alpha-multiplied content. Release the result after compositing.
- `destroy()` removes listeners and releases all GPU resources. Calling it again
  is safe.

Adjacent rectangles and up to eight distinct image textures share ordered
instanced batches. Stencil clips, target changes, and effect passes flush batches,
so translucent artwork retains painter order. Textures stay separate, retaining
mipmap filtering without atlas seams.

`drawCalls`, `primitiveCount`, `clipCount`, `textureUploads`, and `textureBytes` expose rendering counters;
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
still flushes artwork. The Flies adapter derives padding from nested blur extents and calls
`present()` automatically. Texture counters include mip levels, but exclude
stencil buffers, browser bookkeeping, and CPU-side image caches.

## Profiling and memory

The optional third constructor argument accepts `{ profiling: true,
surfacePoolBudget: 64 * 1024 * 1024 }`. GPU timing uses asynchronous disjoint timer
queries when available: `profiler.milliseconds` is the latest completed frame
measurement, `samples` identifies new results, and `supported` reports support.
Unsupported or disjoint timings remain `null`; querying never waits for the GPU.

Effect surfaces retain at most eight reusable allocations within the configured
pool budget. `surfaceBytes` includes color plus logical 8-bit stencil storage;
`pooledSurfaceBytes` reports the retained subset. These counters exclude driver
alignment and bookkeeping. Active effects can exceed the retained pool budget.

The editor adapter exposes the same counters through `getStats()`, plus
`renderMs`, text-layout cache statistics, and raster pressure. Pass
`getStats({ rasters: false })` for cheap sampling without the per-node inventory.
Its optional `rasterBudgetBytes` defaults to 128 MiB. It evicts cold rasters first
and replaces excessive retained zoom density while preserving current artwork;
`cachePressure` remains true if currently visible artwork itself exceeds the
budget. Text geometry has a separate 512-layout / 2-million-character LRU, reused
across position, zoom and paint-color changes and invalidated when fonts load.

## Measured performance

Measured on an Apple M4 using Chromium's native ANGLE Metal backend, with a
1280 × 720 CSS-pixel viewport at 2× Retina density and a real 120 Hz display on
2026-09-22. Each phase used 150 warmup frames and 150 sampled frames. Both 1,000-
and 5,000-node mixed documents passed normal-zoom and fit-all panning, subtree
dragging, auto-layout resizing, and text-preview updates at the unchanged 120 Hz
acceptance thresholds (CPU p95 below 8.33 ms; displayed interval p95 below 10.33 ms).

| Document / view | Artwork primitives | Draw calls | CPU p95    | GPU p95    | Frame interval p95 | Peak textures |
| --------------- | ------------------ | ---------- | ---------- | ---------- | ------------------ | ------------- |
| 1,000 / normal  | 54                 | 5          | 0.7–0.9 ms | 1.9–2.2 ms | 8.9–9.3 ms         | 19.6 MiB      |
| 1,000 / fit-all | 900                | 75         | 1.7–2.2 ms | 1.8–2.8 ms | 8.5–9.3 ms         | 30.4 MiB      |
| 5,000 / normal  | 54                 | 5          | 1.2–1.5 ms | 2.5–3.8 ms | 8.5–9.3 ms         | 19.6 MiB      |
| 5,000 / fit-all | 4,500              | 375        | 3.9–4.2 ms | 5.9–7.1 ms | 8.8–9.0 ms         | 44.6 MiB      |

The 5,000-node fit-all case previously issued 6,500 draws and exceeded the 120 Hz
CPU budget at 9.1–9.7 ms p95 on the same machine. Ordered batches and proven clip
elision reduce its draw count by 94%. A separate forced-clipping regression also
passed 120 Hz with 4,500 artwork primitives, 1,000 stencil operations and 2,000
draw calls (CPU 3.8 ms, GPU 6.0 ms, displayed interval 9.3 ms p95). Streaming fresh
instance-buffer storage prevents native-driver stalls when clipping splits batches.

GPU values come from completed asynchronous timer queries; CPU values measure the
renderer, and displayed intervals also include document interaction and resource
work. These are measured workload limits, not a universal FPS guarantee. Panning
and dragging reused textures, and idle rendering stopped. Textures use zoom-aware
resolution and mipmaps; solid shapes use analytic antialiasing. Normal zoom culls
most nodes, while fit-all verifies the dense primitive counts shown above.

Reproduce the real-display native hardware benchmark on macOS:

```sh
FLIES_GPU_HARDWARE=1 FLIES_GPU_HEADED=1 FLIES_GPU_TARGET_FPS=120 FLIES_GPU_DPR=2 \
  bunx playwright test --config playwright.gpu.config.ts scripts/gpu-tests/performance.spec.ts
```

Set `FLIES_GPU_TARGET_FPS=60` for a 60 Hz target. Hardware tests reject software
GPU backends and preserve per-phase JSON reports. They exercise shared document
and renderer paths, excluding surrounding React editor panels. The DOM renderer
remains the default and the fallback after initialization failure or context loss.

The regular `bun run test:gpu` suite uses software rendering for reproducible
visual, interaction, MCP, and fallback checks; its timings are not hardware FPS
measurements.
