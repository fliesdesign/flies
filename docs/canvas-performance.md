# Canvas performance

The renderer keeps frames as HTML/CSS above a plain native `<canvas>` background. The
performance work changes which DOM nodes update and remain mounted; it does not rasterize
HTML or introduce a graphics renderer.

## Architecture

- A single camera transform moves the visible scene. Frame components receive world-space
  coordinates, so panning does not rewrite every frame's transform.
- A spatial hash queries the viewport with a 200-screen-pixel buffer. Only those frames and
  the selected frame are mounted. Visibility changes preserve document stacking order.
- Frame state uses an indexed document with individual subscriptions. A drag preview updates
  the edited frame and selection overlay, without publishing a whole-document change.
- Pointer samples and camera changes are coalesced through `requestAnimationFrame`; release
  flushes the final input before committing. Cancel restores the original frame.
- Up to 100 history entries store before/after references for the affected frame. A
  100-edit history retains at most 200 frame-reference slots, independent of scene size.
- Saving waits 300 ms after committed changes and flushes on hide/unload. An active drag's
  uncommitted geometry is excluded. This reduces save frequency; serialization and
  `localStorage` remain synchronous when a save occurs.

## Reproduce

Use Bun and the installed dependencies from `bun install`.

```bash
bun run benchmark:canvas > /tmp/canvas-engine.json
bun run benchmark:build
bun run benchmark:preview
```

Open `http://127.0.0.1:4174/benchmark`, keep the window visible, select **Run benchmarks**,
and download the JSON report. The benchmark build uses compiled assets without development
hot reload. `dist/benchmark` is generated output, not source. A later ordinary `bun run
build` replaces `dist`, so rebuild the benchmark before previewing it again.

The harness creates independent 1,000, 5,000, and 10,000-frame documents with persistence
disabled. Each 400 × 280 frame contains text, a local SVG image, and nested flex/grid layouts
(about 30 HTML elements). Regular canvas frames remain empty white frames. No saved user
document is loaded or overwritten.

Each phase runs 20 warmup and 100 sampled animation-frame intervals. Pan and drag submit
four input samples per tick to exercise coalescing. Phases cover panning at 100%, zooming
between 35% and 100%, dragging at 100%, and panning at 10% with full detail retained. Counts
describe the end of each phase, not the maximum during it. Mutation counts cover all 120
ticks, including warmup.

Intervals include rendering work and display scheduling; they are not end-to-end hardware
input latency or CPU usage. `sceneReadyMs` includes fixture creation, initial fit-to-view,
camera reset, and six settling frames. It is not a pure mount measurement. The optional
Chromium heap field is coarse, browser-specific, and neither total process nor peak memory.

## Browser measurement

Recorded September 19, 2026 at 17:11 UTC in Safari 27 on macOS, viewport 1512 × 859,
device pixel ratio 2, compiled benchmark build. The [raw report](benchmarks/browser-safari-2026-09-19.json)
contains every phase. These are one local run, not a supported document-size guarantee.

| Frames | Phase                 | Mean interval |   p95 | Maximum | Mounted at end |
| ------ | --------------------- | ------------: | ----: | ------: | -------------: |
| 1,000  | Pan, 100%             |      16.66 ms | 18 ms |   25 ms |             20 |
| 5,000  | Pan, 100%             |      16.66 ms | 18 ms |   23 ms |             20 |
| 10,000 | Pan, 100%             |      16.66 ms | 18 ms |   23 ms |             20 |
| 10,000 | Drag, 100%            |      16.67 ms | 18 ms |   18 ms |             20 |
| 10,000 | Zoom, 35–100%         |      19.16 ms | 32 ms |   33 ms |             20 |
| 1,000  | Pan, 10%, full detail |      18.67 ms | 18 ms |  136 ms |            968 |
| 5,000  | Pan, 10%, full detail |      20.00 ms | 43 ms |  181 ms |          1,312 |
| 10,000 | Pan, 10%, full detail |      16.67 ms | 19 ms |   24 ms |          1,312 |

The 10,000-frame overview mounted 38,052 DOM elements. No sampled interval in that scene
exceeded 34 ms, but the 1,000- and 5,000-frame overviews had four and eight such intervals,
including the 136 ms and 181 ms spikes above. At 100%, panning changed the camera style 120
times and frame styles zero times; dragging changed frame styles 120 times and the camera
zero times. Scene-ready times were 707 / 882 / 815 ms for 1,000 / 5,000 / 10,000 frames.
CPU and heap measurements were unavailable.

No browser run of the previous renderer was captured, so these results do not establish a
browser speedup factor. The overview spikes and run variability still warrant profiling;
the fastest phase alone does not establish smooth rendering for every document.

Validation also passed 68 canvas tests, lint, TypeScript checks, and the production build.
Browser smoke checks covered hover outlines without handles, dragging/resizing, undo/redo,
context-menu creation, saved-state reload, and offscreen culling followed by fit-to-view
remounting. The native Tauri runtime was not tested.

## Pure document/index measurement

The [engine report](benchmarks/engine-bun-2026-09-19.json) was recorded with Bun 1.4.2 on
darwin/arm64. It excludes React, DOM, layout, paint, and persistence. Timings are local
microbenchmarks and may vary with JIT warmup, garbage collection, and other system work.

| Frames | Construct document + index, median | 1,000 targeted previews, total | Previous full-array previews, total |
| ------ | ---------------------------------: | -----------------------------: | ----------------------------------: |
| 1,000  |                           0.342 ms |                       0.108 ms |                            7.829 ms |
| 5,000  |                           2.559 ms |                       0.088 ms |                           34.846 ms |
| 10,000 |                           3.103 ms |                       0.104 ms |                           45.217 ms |

At every scene size, 1,000 previews notified the edited frame 1,000 times and unrelated
frames and document subscribers zero times. At 10,000 frames, viewport-query p95 was
0.002584 ms at 100% and 0.102333 ms at 10%; 100% queries returned 20–25 candidates, and 10%
queries returned 1,184–1,400 with the tested camera sweep and 1440 × 900 viewport.

After 100 edits, the new history retained 200 frame-reference slots. The script's reproduction
of the former full-document snapshot algorithm retained 100,000 / 500,000 / 1,000,000 cloned
frame objects for the three scene sizes. These are object/reference counts, not measured
bytes or total heap. The comparator reproduces the old array mapping and snapshot operations
only; it is not a browser-renderer baseline.

## Limits and next measurements

Culling is most effective when much of a document lies off-screen. Dense overlap, many
visible nodes, or 10% zoom can still produce large DOM trees. Large images, effects, complex
CSS, deeply nested layouts, and font shaping were not covered beyond the sample cards.
No level-of-detail substitution is used, so overview measurements retain actual content.

Creating/removing frames, initial indexing, fit-to-view, and saving still require work
proportional to document size. The spatial index bounds cell allocation for oversized
frames and falls back to scanning entries for very large queries. Persistence remains
subject to synchronous serialization, storage limits, and browser behavior.

Repeat browser measurements on target hardware and the Tauri webview as editing features
grow. Profile representative real documents, dense overlap, resize-heavy interaction, long
sessions, peak memory, and saving separately before choosing a raster cache or another
renderer.
