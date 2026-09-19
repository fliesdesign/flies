# lra-dsgn

A full-screen design canvas built with React 19, TypeScript, Vite, and TanStack Router,
with a Tauri v2 desktop shell. The frontend uses Tailwind CSS v4 and shadcn/ui
(Base UI primitives, OUI dark theme).

## Commands

```bash
bun install          # install deps
bun run tauri:dev    # run the desktop app (starts Vite on :1420)
bun run tauri:build  # produce a bundled release build
bun run dev          # frontend only, in the browser
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint            (--fix to autofix)
bun run format       # oxfmt             (--check to verify only)
bun run check        # format + lint + typecheck, for CI
bun run build        # production frontend build + typecheck
bun test src         # canvas geometry, document, rendering, interaction, and history tests
```

## Canvas

Open `/` for the canvas, a compact layers sidebar on the left, a vertical toolbar beside it,
and a properties panel on the right.
Layers follow frame/group nesting and stacking order, with selection, expand/collapse,
inline renaming, lock controls, and eye buttons to hide/show nodes. Drag rows to reorder them;
drop in the middle of a frame/group to nest them, or below the list to move them to the root.
Dragging left of a nested row moves the drop to its parent's level. Hover over a collapsed
container for 600 ms while dragging to expand it; a destination label identifies the drop.
These edits support undo,
and hidden states persist with the document. Ctrl/Cmd + Shift + H toggles the selected nodes.
Shift-click selects a range; Cmd/Ctrl-click toggles a layer.
Both panels can be collapsed to give the canvas more space. At narrow widths properties start
collapsed, and opening one panel closes the other. There is no
navigation bar, footer, or router devtools. A native
`<canvas>` provides the plain background; objects and selection controls use HTML/CSS and
SVG above it, without particles. Editing runs entirely in the frontend, without native IPC.

| Tool      | Key | Behavior                                                                                |
| --------- | --- | --------------------------------------------------------------------------------------- |
| Select    | V   | Select and drag objects; hover shows an outline, selection adds eight resize handles.   |
| Frame     | F   | Drag a white frame, or click to create one at 400 × 300.                                |
| Rectangle | R   | Drag a rectangle, or click to create one at 160 × 120.                                  |
| Text      | T   | Click to place and edit multiline text in 24 px Arial.                                  |
| Image     | I   | Open the local image picker; image files can also be pasted or dropped onto the canvas. |
| Pen       | P   | Draw freehand strokes; the pen stays active for subsequent strokes.                     |
| Hand      | H   | Drag to pan; hold Space for temporary hand mode with another tool selected.             |

Frame and rectangle tools return to Select after creation; hold Shift while drawing to
make a square. Right-click **New frame** still creates a 400 × 300 frame immediately at
the pointer. All object types support moving, resizing, duplication, deletion, and undo/redo.
Frames have a 40 × 40 minimum size; other objects have a 1 × 1 minimum. Hold Shift while
resizing to preserve the selection's aspect ratio. Resizing a text box changes its wrapping;
images and pen strokes scale with their bounds.

The properties panel edits position, dimensions, proportions, opacity, fill, corner radius,
visibility, and locking. It also exposes frame clipping, pen stroke width, and multi-selection
alignment. A single child's position is relative to its parent; multi-selection coordinates
describe the combined world bounds. Enter or blur commits a field as one undoable edit;
Escape discards the draft. Invalid values revert, and locked layers can be inspected and
unlocked in the panel without enabling canvas manipulation.

Objects dropped into a frame become its children and move with it. Drawing a frame around
existing objects wraps them without moving them. Frames clip their contents by default;
right-click the selected frame to toggle **Clip contents**. Resizing a frame crops or reveals
its children. Groups have transparent backgrounds, and resizing a group scales its contents.
Selection borders and handles respect clipping ancestors; fully clipped children remain
accessible in Layers and Properties without leaving controls on the canvas.
Enter or double-click a group to edit inside it; Cmd-click selects a nested object directly.

Alignment guides appear while moving or resizing objects near the edges or centers of other
visible objects. Snapping uses a six-pixel screen distance at every zoom level; hold Alt (Option)
while dragging to bypass it. Guides disappear when the gesture ends or is cancelled.

Double-click text, or press Enter with a text object selected, to edit it. Enter inserts a
line break; Ctrl/Cmd + Enter or clicking outside commits. Escape cancels the current text
draft. Text entry keeps ordinary editing shortcuts separate from canvas shortcuts.
Text properties include font family, weight, size, line height, letter spacing, alignment,
and color. Typography changes and direct width edits fit the text's height to its new wrapping;
an explicit height or proportion-locked resize keeps the requested bounds. **Fit text height**
fits an existing box without changing its width. Rendering and editing use the same typography.

Drag blank space with Select to marquee-select objects. Shift-click adds or removes an object;
Shift-drag adds to the selection. Use Hand, middle-drag, or hold Space to pan. Wheel scrolling
pans; Ctrl/Cmd + wheel or trackpad pinch zooms around the pointer from 10% to 400%. The toolbar
supports Up/Down and Home/End navigation, with Enter or Space to activate a tool.

Copy, cut, paste, and duplicate preserve complete selected subtrees and give copies new IDs.
Paste also accepts plain text and local images; copying or pasting while editing text keeps
normal text-editing behavior. Moving, resizing, grouping, or deleting a selection and its
descendants each undo as one operation. The context menu also provides rename, locking, stacking
order, alignment, and distribution. Locked objects remain visible and can be inspected from
Layers; their geometry and styling cannot be edited until unlocked. **Unlock all** restores access.

| Key                                 | Action                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Ctrl/Cmd + A                        | Select all objects in the current group or canvas                       |
| Ctrl/Cmd + C / X / V                | Copy / cut / paste                                                      |
| Ctrl/Cmd + Shift + V                | Paste in place                                                          |
| Ctrl/Cmd + D                        | Duplicate the selection                                                 |
| Delete / Backspace                  | Delete the selection and its descendants                                |
| Ctrl/Cmd + G / Ctrl/Cmd + Shift + G | Group / ungroup                                                         |
| Ctrl/Cmd + Alt + G                  | Frame the selection                                                     |
| F2                                  | Rename the selected object                                              |
| Ctrl/Cmd + Shift + L                | Lock the selection; unlock all when nothing is selected                 |
| Ctrl/Cmd + [ / ]                    | Send backward / bring forward; add Shift for back / front               |
| Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z | Undo / redo                                                             |
| Arrow keys                          | Move the selection; resize when a handle has keyboard focus             |
| Shift + arrow keys                  | Move or resize by 10 instead of 1                                       |
| Shift + 1 / Shift + 2               | Fit all objects / fit the selection                                     |
| 0 / + / −                           | Reset zoom to 100% / zoom in / zoom out                                 |
| Escape                              | Cancel a gesture or text draft; otherwise deselect and return to Select |
| Shift + F10                         | Open the context menu                                                   |

Images decode locally with a 20 MiB input limit and a maximum stored dimension of 2048 px.
Small raster originals are preserved; larger images are compressed, and SVGs are rasterized.
Imported images use embedded data URLs without uploads or remote image requests. Tauri's
window sets `dragDropEnabled: false` so HTML5 file dropping can reach the frontend on Windows.

Objects are saved in browser `localStorage` under `lra-dsgn.canvas.v1`, using a version 2
`{ version: 2, nodes }` document. Older flat arrays still load, with frame membership inferred
from containment during migration. Clipboard imports use their explicit hierarchy instead.
Up to 100 undo edits remain in memory per session. A failed
save displays a notice, and editing continues in memory; image-heavy documents can exceed
browser storage capacity. There is no backend or cross-device sync. `/about` and the OUI
preview at `/components` remain accessible by direct URL.

## Canvas performance

Objects remain DOM-rendered. One shared camera transform pans and zooms the scene; a spatial
index mounts visible objects plus a 200-pixel buffer and the ancestor paths needed to render
them. Selected roots stay mounted; descendants of a moving container are culled using their
live positions. Input is coalesced to animation frames, with per-object subscriptions for
changed geometry and selection overlays. Undo/redo stores object patches; structural edits
also retain ordering arrays, so their history costs more memory than geometry-only edits.
Local saving runs after a 300 ms pause between committed edits.

```bash
bun run benchmark:canvas   # document/index algorithms, JSON to stdout
bun run benchmark:build    # compiled browser harness in dist/benchmark
bun run benchmark:preview  # http://127.0.0.1:4174/benchmark
```

The browser harness uses isolated 1,000 / 5,000 / 10,000-frame scenes with text, embedded
images, and nested layouts. It leaves the saved canvas untouched. It is also available at
`/benchmark` in development; the ordinary production build excludes the harness.

See [measurements, reproduction steps, and limits](docs/canvas-performance.md). The recorded
September 19 measurements predate the drawing tools, hierarchy, and multi-object editing and
are historical results for the benchmark fixtures. Culling helps sparse documents; dense overlap and very distant zoom still expose real DOM rendering
costs, so the benchmark includes a full-detail 10% overview.

## Layout

```
src/
  main.tsx              creates the router, registers its type, mounts RouterProvider
  styles.css            Tailwind entry + OUI theme tokens, typography, motion, reduced-motion rules
  routeTree.gen.ts      generated by @tanstack/router-plugin — do not edit
  routes/
    __root.tsx          chrome-free <Outlet /> and 404; fixed dark theme
    index.tsx           "/" — full-screen frontend canvas
    about.tsx           "/about"
    components.tsx      "/components" — interactive OUI preview
  components/canvas/    toolbar, object rendering/text editing, visible scene, and benchmark harness
  components/ui/        all 61 shadcn components
  hooks/use-canvas-document.ts  per-frame subscriptions and debounced local persistence
  hooks/use-mobile.ts   breakpoint hook used by sidebar/drawer
  lib/canvas-geometry.ts  viewport transforms, zoom, resize, and fit calculations
  lib/canvas-document.ts  typed hierarchy, versioned persistence, and bounded operation history
  lib/canvas-camera.ts    camera state and animation-frame input coalescing
  lib/canvas-scene.ts     hierarchy-aware visibility and live selected-subtree culling
  lib/canvas-spatial-index.ts  world-space viewport queries
  lib/canvas-operations.ts  subtree transforms, grouping, parenting, and clipboard plans
  lib/canvas-arrange.ts   alignment and distribution
  lib/canvas-properties.ts  atomic property edits and text reflow
  lib/canvas-outline.ts   clipping-aware selection visibility and controls
  lib/canvas-tools.ts     tool types, drawing bounds, and local pen coordinates
  lib/canvas-image.ts     local image decoding, size limits, and raster conversion
  lib/canvas-*.test.ts    canvas regression tests
  lib/utils.ts          re-exports `cn`
scripts/benchmark-canvas.ts  document/index algorithm benchmark
docs/canvas-performance.md  benchmark methodology, results, and limits
src-tauri/
  src/lib.rs            native builder and starter greet command; canvas does not invoke it
  capabilities/         permissions — Tauri v2 denies everything not listed here
  tauri.conf.json
components.json         shadcn config (style base-nova, baseColor zinc, alias @/*)
oxlint.config.ts        lint rules
oxfmt.config.ts         formatting, import sorting, Tailwind class sorting
```

## Lint & format

`oxlint` and `oxfmt` are both configured in TypeScript via each tool's `defineConfig`. Both work
under Bun despite oxlint documenting TS configs as Node-only.

`oxfmt` sorts Tailwind classes (replacing `prettier-plugin-tailwindcss`) and import statements,
so no separate plugins are needed. It reads the theme from `src/styles.css`, since Tailwind v4
has no JS config.

`oxlint.config.ts` carries an `overrides` block that relaxes style/a11y rules for
`src/components/ui/**` — that code is vendored from the shadcn registry, and fixing its lint
findings would only create diffs against upstream on the next `shadcn add`. Correctness rules
still apply everywhere.

## Adding a route

Drop a file in `src/routes/`; the Vite plugin regenerates `src/routeTree.gen.ts` on save.
`$param.tsx` for dynamic segments, `_layout.tsx` for pathless layouts, `$.tsx` for catch-alls.

## UI components

The full shadcn registry is already installed in `src/components/ui` — 61 components. They are
yours to edit. Unused ones are tree-shaken out of the JS bundle, but Tailwind still scans them
for class names, so deleting components you never use will shrink the CSS.

Re-sync or add later with `bun x shadcn@latest add <name>`. They are built on
[Base UI](https://base-ui.com) (`@base-ui/react`), not Radix — check Base UI's docs when a
component's props differ from shadcn examples you find online. Icons are `lucide-react`;
the font is Arial with Helvetica/sans-serif fallbacks, matching the kit’s explicit fallback for OpenAI Sans.
No proprietary font files or remote font requests are required.

Theme tokens live in `src/styles.css`. The supplied kit is dark-only: `index.html` sets the
`dark` class before rendering, and CSS declares `color-scheme: dark` independently of OS settings.

## OUI design source

Adapted from [OpenAI Platform — UI Kit in Paper](https://app.paper.design/file/01M25GA8KKM41CKAZ2FHEP016Y/1-0),
Default page, foundation/control boards and extended component specimens.

- Shell `#121212`, canvas `#212121`, raised surfaces `#303030`, text `#EDEDED`, secondary text `#AFAFAF`.
- 14/20 px controls, 16/20 px card titles, 20/32 px section headings, 36/44 px page titles.
- 6–8 px control radii, 12 px menus, 16 px cards; cards/dialogs use 20 px insets.
- Controls use 150 ms transitions, navigation 200 ms, tooltips 250 ms. Search uses
  `cubic-bezier(0.19, 1, 0.22, 1)`. Menus open directly, as observed in the kit.
- Card action layers reveal from opacity 0 / scale .98 on hover or keyboard focus; touch devices
  keep the actions visible. Use the `oui-card-reveal*` classes shown in the component preview.
- Spinner: thin rounded arc, 1.2 s rotation / 1.5 s arc cycle. These timings are reconstructed
  in the source kit. Dialog/toast/drawer motion and chart colors are companion adaptations,
  not measured reproductions. Reduced motion removes movement and keeps loading indicators visible.
- `Badge` adds `new` and `subtle` variants; `Alert` adds `warning`. Existing component APIs remain.

All 61 component modules inherit the shared color, type, radius, and motion tokens. Controls,
menus, overlays, selection, feedback, navigation, and message components also have explicit
style adjustments; layout-only primitives keep their behavior. Open `/components` to inspect
representative controls and interactive states. The preview uses local in-memory sample data.

Registry regeneration can overwrite the OUI adjustments. Review generated changes rather
than blindly replacing customized components.

## Adding a Rust command

Define it in `src-tauri/src/lib.rs` and register it in `tauri::generate_handler![...]` —
commands missing from that macro fail silently when invoked. Call it with
`invoke<T>("name", args)` from `@tauri-apps/api/core`.
