# Canvas performance

The current mixed-document benchmark keeps local editing near the display cadence at 10,000
nodes, but zooming out to a dense overview has substantial frame stalls. The overview is the
next rendering bottleneck; these results do not establish smooth rendering at every zoom or
for every document.

The renderer uses actual HTML/CSS nodes above a plain native `<canvas>` background. It does
not rasterize HTML or use a separate graphics renderer.

## Current browser measurement

Recorded September 19, 2026 at 19:40 UTC in Chromium 153 on macOS, using the compiled
benchmark build. The window was 1280 × 720, the canvas viewport was 780 × 720 with both
Layers and Properties open, and the device pixel ratio was 2. The
[raw mixed-node report](benchmarks/browser-mixed-chromium-2026-09-19.json) contains all phases,
node types, DOM counts, and optional heap readings. This is one local run, not a supported
size guarantee or a comparison with an earlier renderer.

Counts are actual editable document nodes. Each ten-node board contains two frames, three
text nodes, one embedded PNG image, one group, two rectangles, and one pen path. Half the
nested frames use auto layout. Thus the 10,000-node scene has 1,000 root boards and 500
auto-layout frames. The normal production renderer handles all content; the benchmark does
not inject synthetic HTML through a replacement frame component.

| Nodes  | Phase                       | Mean interval |     p95 |  Maximum |
| ------ | --------------------------- | ------------: | ------: | -------: |
| 1,000  | Pan, 100%, text selected    |       8.33 ms |  9.8 ms |  10.2 ms |
| 5,000  | Pan, 100%, text selected    |       8.33 ms |  9.8 ms |  10.3 ms |
| 10,000 | Pan, 100%, text selected    |       8.33 ms |    9 ms |   9.3 ms |
| 10,000 | Drag a ten-node subtree     |       8.33 ms |  9.1 ms |   9.2 ms |
| 10,000 | Resize an auto-layout frame |       8.33 ms |  8.7 ms |   9.3 ms |
| 10,000 | Preview text font size      |       8.33 ms |  8.5 ms |   9.3 ms |
| 1,000  | Zoom from 100% to 10%       |      16.17 ms | 41.7 ms | 133.3 ms |
| 5,000  | Zoom from 100% to 10%       |      22.49 ms |   83 ms | 191.7 ms |
| 10,000 | Zoom from 100% to 10%       |      25.25 ms | 99.6 ms | 208.3 ms |

All four local-interaction phases at 10,000 nodes averaged 8.33 ms, with p95 at or below
9.1 ms and no sampled interval above 34 ms. The zoom-to-overview phase exceeded 34 ms in
18 of its 100 sampled intervals. Its p95 of 99.6 ms and maximum of 208.3 ms show visible
stalls. These zoom measurements include mounting content during the transition; they do
not measure a stationary overview or sustained overview panning separately.

| Nodes  | Mounted at 10% | Visible at 10% | Canvas DOM | Editor DOM, including panels | Scene ready |
| ------ | -------------: | -------------: | ---------: | ---------------------------: | ----------: |
| 1,000  |          1,000 |          1,000 |      3,415 |                        4,165 |    139.4 ms |
| 5,000  |          4,559 |          2,992 |     15,503 |                       16,253 |    864.1 ms |
| 10,000 |          5,016 |          2,992 |     17,055 |                       17,805 |  1,536.8 ms |

Mounted counts include the culling buffer, selected nodes, and required ancestors. Visible
counts intersect node bounds with the viewport and rounded ancestor clips. They describe
geometric visibility, not pixel coverage or occlusion by other nodes. DOM counts are element
counts at phase end, not peaks. The raw report also includes the full document DOM including
benchmark controls: 17,826 elements at the end of the 10,000-node overview.

At the end of the 10,000-node 100% pan, only 110 nodes were mounted and 44 intersected the
viewport; the editor had 1,146 elements including both panels. Panning changed the camera
style 120 times and individual node-position styles zero times. The Layers tree kept 31
rows mounted throughout this run. The completed ten-node drag retained 20 before/after
node-reference slots in its undoable history entry.

## Architecture

- One camera transform moves the scene. Nested nodes use parent-relative rendering, so
  panning and moving a container do not rewrite every descendant's DOM transform.
- A spatial hash queries the viewport with a 200-screen-pixel buffer. Required ancestors
  and selected roots stay mounted, while selected descendants and derived layout changes
  are culled using their current preview bounds. Hidden nodes are omitted and document
  stacking order is preserved.
- The indexed document has individual node subscriptions. Gesture previews notify changed
  nodes and relevant selection/properties controls without publishing a document-wide
  commit. Auto layout can also change siblings and descendants of affected containers.
- Pointer previews and camera changes are coalesced with `requestAnimationFrame`. Release
  flushes the final input; cancellation restores the gesture's original geometry. Edge
  auto-pan retains the world-space drag origin and queries nearby snapping targets.
- Up to 100 history entries retain before/after references for affected nodes, including
  moved subtrees and derived layout changes. Cost follows the changed nodes, rather than
  making a full-document copy. A ten-node drag can retain 20 references; there is no general
  two-reference-per-edit bound.
- Layers use a virtualized tree. Properties subscribe to the selected nodes, allowing live
  geometry and style previews without remounting the entire editor.
- Autosave waits 300 ms after committed changes and flushes on hide/unload. Uncommitted
  gesture geometry is excluded. Serialization and `localStorage` remain synchronous when
  a save occurs; portable project saving and PNG export are separate operations.

## Reproduce

Use Bun and the installed dependencies from `bun install`.

```bash
bun run benchmark:canvas > /tmp/canvas-engine.json
bun run benchmark:build
bun run benchmark:preview
```

Open `http://127.0.0.1:4174/benchmark`, keep the window visible, select **All sizes** or a
single node count, then select **Run benchmarks**. Keep the window wide enough for both
panels. Download the report or expand **JSON report**. The compiled benchmark has no
development hot reload. `dist/benchmark` is generated output; an ordinary `bun run build`
replaces `dist`, so rebuild the benchmark before previewing it again.

Each scene is an independent 1,000-, 5,000-, or 10,000-node document with persistence
disabled. No saved user document is loaded or overwritten. Both panels stay open, with a
text node selected during pan and zoom. The five phases exercise 100% panning, zooming from
100% to 10% at full detail, moving an entire ten-node subtree, resizing an auto-layout
frame, and previewing text font-size changes with text measurement.

Each phase has 20 warmup and 100 sampled animation-frame intervals. Pan and subtree drag
submit four samples per display tick to exercise coalescing. The three-scene run takes
roughly 30 seconds at 60 Hz before loading and settling overhead; faster display scheduling
reduces that time. Mutation counts include all 120 ticks, including warmup.

Intervals include browser rendering work and display scheduling. They are not end-to-end
hardware input latency, CPU time, or direct measurements of physical pointer events.
`sceneReadyMs` includes fixture creation, initial fit-to-view, panel opening, camera reset,
six settling frames, and mounted-image decoding. Optional Chromium heap readings are
coarse snapshots, not total process or peak memory, and depend on garbage collection.

## Historical measurements

The [Safari 27 report](benchmarks/browser-safari-2026-09-19.json), recorded earlier on
September 19, 2026, used synthetic rich HTML inside each frame, a 1512 × 859 viewport,
and different phases. Its frame count is not the current benchmark's editable-node count.
Browser, viewport, display cadence, fixtures, and editing workload differ, so its timings
are historical context and must not be used to calculate a speedup or regression against
the current Chromium run.

The [historical engine report](benchmarks/engine-bun-2026-09-19.json) used Bun 1.4.2 on
darwin/arm64 with flat frames. It excludes React, DOM, layout, paint, and persistence. The
algorithm script still uses `createBenchmarkFrames` for continuity with that comparator;
it does not exercise the current mixed browser workload. These recorded figures have not
been refreshed by the mixed browser run.

| Frames | Construct document + index, median | 1,000 targeted previews, total | Previous full-array previews, total |
| ------ | ---------------------------------: | -----------------------------: | ----------------------------------: |
| 1,000  |                           0.342 ms |                       0.108 ms |                            7.829 ms |
| 5,000  |                           2.559 ms |                       0.088 ms |                           34.846 ms |
| 10,000 |                           3.103 ms |                       0.104 ms |                           45.217 ms |

In that flat-frame run, 1,000 previews notified the edited frame 1,000 times and unrelated
frames and document subscribers zero times. At 10,000 frames, viewport-query p95 was
0.002584 ms at 100% and 0.102333 ms at 10%, using a 1440 × 900 screen. One hundred
single-frame edits retained 200 reference slots. The reproduced full-snapshot algorithm
retained 100,000 / 500,000 / 1,000,000 cloned objects across the three sizes. These are
reference/object counts, not bytes, and the old algorithm is not a browser baseline.

## Limits and next measurements

Culling helps local editing when most nodes are offscreen. The current overview still
mounts thousands of nodes at full detail and stalls during zoom. Profile mounting, layout,
and paint in that transition before choosing level of detail, raster caching, or another
renderer. Also measure stationary overview panning separately.

The fixture reuses one small embedded PNG and a limited set of text styles. Large or
unique images, long text, font loading/shaping, dense overlapping objects, deeper nesting,
and effects need separate representative documents. The browser benchmark drives editor
stores and operations; native pointer routing, guideline lookup, edge auto-pan, file I/O,
PNG export, and autosave are outside its measured phases.

Creation/removal, initial indexing, fit-to-view, and serialization can require work
proportional to document size. The spatial index bounds cell allocation for oversized
nodes and can scan entries for very large queries. Synchronous storage, long-session
history, peak memory, and operating-system scheduling remain separate concerns.

Repeat measurements on target hardware and the Tauri webview. This report does not establish
native-runtime performance or a supported maximum document size.
