# Flies

A full-screen design canvas built with React 19, TypeScript, Vite+, and TanStack Router,
with a Tauri v2 desktop shell. The frontend uses Tailwind CSS v4 and shadcn/ui
(Base UI primitives, neutral dark theme).

This is a Bun workspace:

- `packages/canvas` — document model, geometry, GPU renderer, and canvas engine
- `apps/web` — Vite+ React app (browser and the desktop webview)
- `apps/desktop` — Tauri v2 native shell
- `apps/api` — Bun + Hono, WorkOS, Drizzle/Postgres, immutable S3 revisions

Right-click a selection and choose **Copy as → Tailwind, CSS, React Tailwind, or React CSS**
to copy its visible layers as HTML or a React component. Exports preserve the current
canvas geometry; CSS uses inline styles, while Tailwind uses utility classes.

MCP agents can use Tailwind CSS v4 classes directly in `write_html`. Utilities compile
locally into editable layers with no setup or CDN. See the [MCP guide](apps/desktop/src/mcp/README.md#tailwind-css)
for examples and supported styles.

## Commands

```bash
vp install           # install deps (or bun install)
bun run api:dev       # backend API on :3001 (start first)
vp -C apps/web dev   # frontend, Vite on :1420
bun run tauri:dev    # desktop app (starts apps/web on :1420)
bun run tauri:build  # bundled release build
vp check             # format + lint (Oxfmt / Oxlint via Vite+)
bun run typecheck    # tsc --noEmit in canvas and web
bun run check        # vp check + typecheck, for CI
bun run test         # Vitest in packages/canvas and apps/web
bun run test:gpu     # headless WebGPU pixel, interaction, and fallback checks
bun run build        # production frontend build
docker build -t flies-web .                  # production image for apps/web
docker run --rm -p 8080:8080 flies-web       # http://localhost:8080
```

## Canvas

Open `/` for the canvas, a compact layers sidebar on the left, a vertical toolbar beside it,
and a properties panel on the right.
On macOS, the desktop window uses an overlay title bar with native traffic lights. Drag the
slim top strip to move the window; double-click it to maximize or restore. The strip only
appears in the desktop app, and editor controls sit below it.
Layers follow frame/group nesting and stacking order, with selection, expand/collapse,
inline renaming, lock controls, and eye buttons to hide/show nodes. Drag rows to reorder them;
drop in the middle of a frame/group to nest them, or below the list to move them to the root.
Dragging left of a nested row moves the drop to its parent's level. Hover over a collapsed
container for 600 ms while dragging to expand it; a destination label identifies the drop.
These edits support undo,
and hidden states persist with the document. Ctrl/Cmd + Shift + H toggles the selected nodes.
Shift-click selects a range; Cmd/Ctrl-click toggles a layer.
The properties panel and its reopen button are hidden when no layer is selected.
Both panels can be collapsed to give the canvas more space. At narrow widths properties start
collapsed, and opening one panel closes the other. There is no
navigation bar, footer, or router devtools. Artwork uses an explicit PixiJS WebGPU renderer when
the browser or desktop webview provides a working adapter. The renderer retains shapes, text,
images, and pen strokes, updates the camera transform during navigation, and draws only when
something changes. Labels, selection controls, and the active text editor remain HTML overlays.
Pointer picking uses the document's spatial index, including rounded frame clipping.

To inspect individual artwork elements in DevTools, enable **Project menu (…) → Inspect HTML**.
This switches to real HTML/CSS elements while preserving the document, selection, and viewport.
The preference is remembered locally. Disable it to return to WebGPU when supported.

WebGPU is loaded separately from the editor. Unsupported devices, initialization failures, and
device loss fall back to the existing HTML/CSS renderer without changing the document. Custom
`FrameContent` extensions also use that renderer. Text and shadows use cached raster textures;
PNG export still uses the HTML renderer, so small typography differences are possible. The
WebGPU tests use Chromium's software adapter to verify drawing and editing; they do not measure
native GPU performance. Editing runs entirely in the frontend, without native IPC.

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
Escape discards the draft. Drag a numeric label horizontally to scrub its value live; Shift
adjusts faster, Alt (Option) adjusts more finely. Each drag is one undoable edit, and Escape
cancels it. Click a fill swatch for live saturation, brightness, hue, alpha, and hex controls;
Done or clicking outside commits the color, while Cancel or Escape restores it. Invalid values
revert, and locked layers can be inspected and unlocked without enabling canvas manipulation.

Frame properties offer **Auto layout** with horizontal or vertical flow, gap, uniform padding,
cross-axis alignment, and start/center/end/space-between justification. Direct children follow
their layer order; changing child sizes or the frame bounds reflows them. Their X/Y fields are
read-only while layout manages their positions. Choose **Free layout** to keep the current
positions and return to manual placement.

Objects dropped into a frame become its children and move with it. Drawing a frame around
existing objects wraps them without moving them. Frames clip their contents by default;
right-click the selected frame to toggle **Clip contents**. Resizing a frame crops or reveals
its children. Groups have transparent backgrounds, and resizing a group scales its contents.
Selection borders and handles respect clipping ancestors; fully clipped children remain
accessible in Layers and Properties without leaving controls on the canvas.
Enter or double-click a group to edit inside it; Cmd-click selects a nested object directly.

Alignment guides appear while moving or resizing objects near the edges or centers of other
visible objects. Snapping uses a six-pixel screen distance at every zoom level; hold Alt (Option)
while dragging to bypass it. Hidden nodes and fully clipped children are excluded; partially
clipped nodes snap only to their visible bounds. Guides disappear when the gesture ends or is
cancelled. Moving, resizing, or marquee-selecting near a canvas edge pans the view automatically
without releasing the pointer; returning inward or ending the gesture stops the pan.

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

The font picker lists installed system fonts in the desktop app and a starter collection of Google
Fonts on the web. Type any Google Fonts family name to load it on demand; desktop also uses Google
Fonts when a family is not installed. Imports preserve named families and weights, loading fonts
before measuring text. Reopened documents, canvas rendering, and PNG export use the same loader.
Google Fonts requires a network connection on first use; fonts unavailable locally or from Google
produce an error instead of being silently renamed. Restart the desktop app after installing fonts.

Copy, cut, paste, and duplicate preserve complete selected subtrees and give copies new IDs.
Paste also accepts plain text and local images; copying or pasting while editing text keeps
normal text-editing behavior. **Paper Snapshot** captures can be pasted with Ctrl/Cmd + V or
the canvas context menu. Flies reads their `text/html` clipboard representation (`x-paper-html`)
and imports the captured layout as a selected group of editable layers, with one-step undo.
Keyboard paste centers the capture in the viewport; context-menu paste places it at the click.
Inline SVG icons become SVG nodes with their vector source preserved. Backgrounds with uneven corner radii become embedded images; supported text,
colors, and geometry remain editable. Captured image URLs are downloaded once and embedded in the
document. The desktop app can also load images from servers that block browser CORS requests;
unavailable images use placeholders. Unsupported effects produce an import notice. This uses the
canvas's supported fonts and layer types, so it is not a full browser rendering of every CSS feature.
On macOS, desktop menu paste and Cmd + V read the native pasteboard through Rust, preserving
capture HTML without WebKit's clipboard prompt or filtering. Ordinary image and text paste
remain supported. Browsers that deny rich clipboard reads from the context menu can still paste
with Ctrl/Cmd + V.

Moving, resizing, grouping, or deleting a selection and its
descendants each undo as one operation. The context menu also provides rename, locking, stacking
order, alignment, and distribution. Locked objects remain visible and can be inspected from
Layers; their geometry and styling cannot be edited until unlocked. **Unlock all** restores access.

| Key                                 | Action                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Ctrl/Cmd + A                        | Select all objects in the current group or canvas                       |
| Ctrl/Cmd + C / X / V                | Copy / cut / paste                                                      |
| Ctrl/Cmd + Shift + V                | Paste in place                                                          |
| Ctrl/Cmd + D                        | Duplicate the selection                                                 |
| Ctrl/Cmd + S                        | Save the current file to your workspace                                 |
| Ctrl/Cmd + O                        | Import a ZIP, JSON, or legacy `.lra` project                            |
| Ctrl/Cmd + Shift + E                | Export the selected frame or layers as a PNG                            |
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

The browser and desktop app require WorkOS sign-in and open the same API-backed file library.
Each user receives a default workspace on first login, linked to a WorkOS organization with the user as a member. Files belong to that workspace; the API
checks ownership for every list, read, write, archive, and revision request.
Edits autosave after 500 ms. Each save adds a gzip-compressed immutable revision in private S3
storage, with metadata and the current revision pointer in Postgres. Saves finish before tab
closure or native window closure; failed saves remain in memory for retry. Concurrent writers
receive a revision conflict rather than overwriting another session's work.

See [API setup](apps/api/README.md) for environment variables, the Neon test branch, Railway bucket,
authentication, migrations, endpoints, and deployment with the root `Dockerfile.api`.
Old local libraries are no longer read or written; their existing files on disk are left intact.
Import a portable ZIP or JSON project to create a cloud copy.

Use the toolbar's **Project menu** to save/open a portable ZIP (`document.json` plus images)
or export a selection as PNG. Project files include the complete hierarchy, styling, and
embedded images. Opening a project replaces the current canvas as one undoable action; an
invalid file leaves it intact.
PNG exports use the selected subtree(s) at 1× size, including visible content, opacity, and
frame clipping, without editor controls.

Design documents are no longer stored in browser localStorage. Tab IDs, appearance, and other UI
preferences can still be remembered locally. Up to 100 undo edits remain in memory per session.
Web navigation uses `/recents`, `/files`, `/files/:id`, and `/settings` (plus `/archive`). File links survive refresh and sign-in. Only desktop shows an in-app tab strip; desktop sign-in opens the system browser and securely hands the session back to the app. New workspace, file, and revision IDs are ULIDs.

The `/about` and component preview routes remain accessible by direct URL.

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
packages/canvas/src/    canvas engine (`@flies/canvas`): document, camera, GPU, tests
apps/web/src/
  main.tsx              creates the router, registers its type, mounts RouterProvider
  styles.css            Tailwind entry + dark theme tokens, typography, motion, reduced-motion rules
  routeTree.gen.ts      generated by @tanstack/router-plugin — do not edit
  routes/
    __root.tsx          chrome-free <Outlet /> and 404; fixed dark theme
    index.tsx           "/" — redirect to recents (desktop restores active file)
    _workspace.tsx      authenticated workspace layout
    _workspace.*.tsx    recents, files, file editor, settings, and archive
    about.tsx           "/about"
    components.tsx      "/components" — interactive OUI preview
  components/canvas/    toolbar, object rendering/text editing, visible scene, and benchmark harness
  components/ui/        all 61 shadcn components
  hooks/use-mobile.ts   breakpoint hook used by sidebar/drawer
  lib/                  MCP, API files, Paper snapshot import, `cn`
apps/desktop/          Tauri v2 crate, MCP server, clipboard, snapshot fetch
vite.config.ts          workspace lint (`vp lint`) and format (`vp fmt`)
scripts/benchmark-canvas.ts  document/index algorithm benchmark
docs/canvas-performance.md  benchmark methodology, results, and limits
apps/web/components.json     shadcn config (style base-nova, baseColor zinc, alias @/*)
```

## Lint & format

Vite+ owns format and lint from the root `vite.config.ts` (`fmt` and `lint` blocks). Run
`bun run format` to format code and insert blank lines around functions, multiline declarations,
blocks, and class methods, and before returns. The command applies only spacing fixes from Oxlint.
Use `bun run format:check` to verify formatting, or `bun run check` for formatting, lint, and
typechecks. Nested `oxlint.config.ts` / `oxfmt.config.ts` files are not used.

Oxfmt sorts Tailwind classes and import statements. It reads the theme from
`apps/web/src/styles.css`, since Tailwind v4 has no JS config.

The root `lint.overrides` block relaxes style/a11y rules for
`apps/web/src/components/ui/**` — that code is vendored from the shadcn registry, and fixing its lint
findings would only create diffs against upstream on the next `shadcn add`. Correctness rules
still apply everywhere.

## Adding a route

Drop a file in `apps/web/src/routes/`; the Vite plugin regenerates `apps/web/src/routeTree.gen.ts`
on save.
`$param.tsx` for dynamic segments, `_layout.tsx` for pathless layouts, `$.tsx` for catch-alls.

## UI components

The full shadcn registry is already installed in `apps/web/src/components/ui` — 61 components. They are
yours to edit. Unused ones are tree-shaken out of the JS bundle, but Tailwind still scans them
for class names, so deleting components you never use will shrink the CSS.

Re-sync or add later with `bun x shadcn@latest add <name>`. They are built on
[Base UI](https://base-ui.com) (`@base-ui/react`), not Radix — check Base UI's docs when a
component's props differ from shadcn examples you find online. Icons are `lucide-react`;
the editor uses native system typography with monospaced numeric fields. Canvas text retains its own font settings.
No proprietary font files or remote font requests are required.

Theme tokens live in `apps/web/src/styles.css`. The neutral theme is dark-only: `apps/web/index.html` sets the
`dark` class before rendering, and CSS declares `color-scheme: dark` independently of OS settings.

## Dark theme

The original component foundation was adapted from [OpenAI Platform — UI Kit in Paper](https://app.paper.design/file/01M25GA8KKM41CKAZ2FHEP016Y/1-0),
Default page. The editor now uses its own palette and control treatment rather than reproducing that kit.

- Canvas `#181818`, panels `#222222`, recessed fields `#1A1A1A`, menus `#292929`.
- Text `#E8E8E8`, muted text `#A3A3A3`, neutral focus and guide lines `#BCBCBC`.
- Compact toolbar and selected layers use simple gray active states.
- System UI typography for the editor and SF Mono/Consolas numeric fields, with no remote font requests.
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

Registry regeneration can overwrite the custom theme adjustments. Review generated changes rather
than blindly replacing customized components.

## Adding a Rust command

Define it in `apps/desktop/src/lib.rs` and register it in `tauri::generate_handler![...]` —
commands missing from that macro fail silently when invoked. Call it with
`invoke<T>("name", args)` from `@tauri-apps/api/core`.

SVG files can be imported through the Image tool, dropped on the canvas, or pasted as SVG markup.
SVG nodes support normal layer operations, resizing, project save/reopen, PNG export, and all Copy as
formats (which retain the embedded SVG source). Paths, groups, gradients, clipping, masks, and local
references are preserved; scripts, external resources, and unsupported SVG elements are removed on
import. SVG nodes are whole vector assets, not individual editable paths.
