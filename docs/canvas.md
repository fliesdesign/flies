# Canvas reference

Open `/` for the canvas: a compact layers sidebar on the left, a vertical toolbar beside it, and
a properties panel on the right. Both panels collapse to give the canvas more space. At narrow
widths properties start collapsed, and opening one panel closes the other. The properties panel
and its reopen button are hidden when nothing is selected. There is no navigation bar, footer, or
router devtools.

On macOS the desktop window uses an overlay title bar with native traffic lights. Drag the slim
top strip to move the window; double-click it to maximize or restore. The strip only appears in
the desktop app, and editor controls sit below it.

## Tools

| Tool      | Key | Behavior                                                                                |
| --------- | --- | --------------------------------------------------------------------------------------- |
| Select    | V   | Select and drag objects; hover shows an outline, selection adds eight resize handles.   |
| Frame     | F   | Drag a white frame, or click to create one at 400 × 300.                                |
| Rectangle | R   | Drag a rectangle, or click to create one at 160 × 120.                                  |
| Text      | T   | Click to place and edit multiline text in 24 px Arial.                                  |
| Image     | I   | Open the local image picker; image files can also be pasted or dropped onto the canvas. |
| Pen       | P   | Draw freehand strokes; the pen stays active for subsequent strokes.                     |
| Hand      | H   | Drag to pan; hold Space for temporary hand mode with another tool selected.             |

Frame and rectangle tools return to Select after creation; hold Shift while drawing to make a
square. Right-click **New frame** still creates a 400 × 300 frame immediately at the pointer. All
object types support moving, resizing, duplication, deletion, and undo/redo. Frames have a 40 × 40
minimum size; other objects have a 1 × 1 minimum. Hold Shift while resizing to preserve the
selection's aspect ratio. Resizing a text box changes its wrapping; images and pen strokes scale
with their bounds.

## Layers and hierarchy

Layers follow frame/group nesting and stacking order, with selection, expand/collapse, inline
renaming, lock controls, and eye buttons to hide/show nodes. Drag rows to reorder them; drop in the
middle of a frame/group to nest them, or below the list to move them to the root. Dragging left of
a nested row moves the drop to its parent's level. Hover over a collapsed container for 600 ms
while dragging to expand it; a destination label identifies the drop. These edits support undo, and
hidden states persist with the document. Ctrl/Cmd + Shift + H toggles the selected nodes.
Shift-click selects a range; Cmd/Ctrl-click toggles a layer.

Objects dropped into a frame become its children and move with it. Drawing a frame around existing
objects wraps them without moving them. Frames clip their contents by default; right-click the
selected frame to toggle **Clip contents**. Resizing a frame crops or reveals its children. Groups
have transparent backgrounds, and resizing a group scales its contents. Selection borders and
handles respect clipping ancestors; fully clipped children remain accessible in Layers and
Properties without leaving controls on the canvas. Enter or double-click a group to edit inside it;
Cmd-click selects a nested object directly.

Moving, resizing, grouping, or deleting a selection and its descendants each undo as one operation.
The context menu also provides rename, locking, stacking order, alignment, and distribution. Locked
objects remain visible and can be inspected from Layers; their geometry and styling cannot be
edited until unlocked. **Unlock all** restores access.

## Properties and appearance

The properties panel edits position, dimensions, proportions, opacity, fill, corner radius,
visibility, and locking. It also exposes frame clipping, pen stroke width, and multi-selection
alignment. A single child's position is relative to its parent; multi-selection coordinates
describe the combined world bounds. Enter or blur commits a field as one undoable edit; Escape
discards the draft. Drag a numeric label horizontally to scrub its value live; Shift adjusts
faster, Alt (Option) adjusts more finely. Each drag is one undoable edit, and Escape cancels it.
Click a fill swatch for live saturation, brightness, hue, alpha, and hex controls; Done or clicking
outside commits the color, while Cancel or Escape restores it. Invalid values revert, and locked
layers can be inspected and unlocked without enabling canvas manipulation.

Appearance controls include rotation, solid/linear/radial fills with editable color stops, 16 blend
modes, borders, inner/outer shadow stacks, and blur, brightness, contrast, saturation, grayscale,
sepia, invert, and hue filters. Rotation follows nested frames and groups through selection,
dragging, resizing, clipping, grouping, clipboard, and export. Multiple rotated layers resize
proportionally to preserve their shape. Gradients support alpha and 2–16 stops. All appearance
edits use the same preview, undo, project persistence, and MCP document state.

**Auto layout.** Frame properties offer horizontal or vertical flow, gap, uniform padding,
cross-axis alignment, and start/center/end/space-between justification. Direct children follow
their layer order; changing child sizes or the frame bounds reflows them. Their X/Y fields are
read-only while layout manages their positions. Choose **Free layout** to keep the current
positions and return to manual placement.

## Text and fonts

Double-click text, or press Enter with a text object selected, to edit it. Enter inserts a line
break; Ctrl/Cmd + Enter or clicking outside commits. Escape cancels the current text draft. Text
entry keeps ordinary editing shortcuts separate from canvas shortcuts. Text properties include font
family, weight, size, line height, letter spacing, alignment, and color. Typography changes and
direct width edits fit the text's height to its new wrapping; an explicit height or
proportion-locked resize keeps the requested bounds. **Fit text height** fits an existing box
without changing its width. Rendering and editing use the same typography.

The font picker lists installed system fonts in the desktop app and a starter collection of Google
Fonts on the web. Type any Google Fonts family name to load it on demand; desktop also uses Google
Fonts when a family is not installed. Imports preserve named families and weights, loading fonts
before measuring text. Reopened documents, canvas rendering, and PNG export use the same loader.
Google Fonts requires a network connection on first use; fonts unavailable locally or from Google
produce an error instead of being silently renamed. Restart the desktop app after installing fonts.

## Navigating and snapping

Drag blank space with Select to marquee-select objects. Shift-click adds or removes an object;
Shift-drag adds to the selection. Use Hand, middle-drag, or hold Space to pan. Wheel scrolling
pans; Ctrl/Cmd + wheel or trackpad pinch zooms around the pointer from 10% to 400%. The toolbar
supports Up/Down and Home/End navigation, with Enter or Space to activate a tool.

Alignment guides appear while moving or resizing objects near the edges or centers of other visible
objects. Snapping uses a six-pixel screen distance at every zoom level; hold Alt (Option) while
dragging to bypass it. Hidden nodes and fully clipped children are excluded; partially clipped nodes
snap only to their visible bounds. Guides disappear when the gesture ends or is cancelled. Moving,
resizing, or marquee-selecting near a canvas edge pans the view automatically without releasing the
pointer; returning inward or ending the gesture stops the pan.

## Clipboard and Paper snapshots

Copy, cut, paste, and duplicate preserve complete selected subtrees and give copies new IDs. Paste
also accepts plain text and local images; copying or pasting while editing text keeps normal
text-editing behavior.

**Paper Snapshot** captures can be pasted with Ctrl/Cmd + V or the canvas context menu. Flies reads
their `text/html` clipboard representation (`x-paper-html`) and imports the captured layout as a
selected group of editable layers, with one-step undo. Keyboard paste centers the capture in the
viewport; context-menu paste places it at the click. Inline SVG icons become SVG nodes with their
vector source preserved. Backgrounds with uneven corner radii become embedded images; supported
text, colors, and geometry remain editable. Captured image URLs are downloaded once and embedded in
the document. The desktop app can also load images from servers that block browser CORS requests;
unavailable images use placeholders. Unsupported effects produce an import notice. This uses the
canvas's supported fonts and layer types, so it is not a full browser rendering of every CSS
feature.

On macOS, desktop menu paste and Cmd + V read the native pasteboard through Rust, preserving
capture HTML without WebKit's clipboard prompt or filtering. Ordinary image and text paste remain
supported. Browsers that deny rich clipboard reads from the context menu can still paste with
Ctrl/Cmd + V.

## Images and SVG

Images decode locally with a 20 MiB input limit and a maximum stored dimension of 2048 px. Small
raster originals are preserved; larger images are compressed, and SVGs are rasterized. Imported
images are stored as embedded data URLs. Public HTTP and HTTPS raster URLs are downloaded at import
and saved with the file; private hosts are refused. Tauri's window sets `dragDropEnabled: false` so
HTML5 file dropping can reach the frontend on Windows.

SVG files can be imported through the Image tool, dropped on the canvas, or pasted as SVG markup.
SVG nodes support normal layer operations, resizing, project save/reopen, PNG export, and all
Copy as formats (which retain the embedded SVG source). Paths, groups, gradients, clipping, masks,
and local references are preserved; scripts, external resources, and unsupported SVG elements are
removed on import. SVG nodes are whole vector assets, not individual editable paths.

## Code export and import

Right-click a selection and choose **Copy as → Tailwind, CSS, React Tailwind, or React CSS** to
copy its visible layers as HTML or a React component. Exports preserve the current canvas geometry;
CSS uses inline styles, while Tailwind uses utility classes. Code export and PNG export both
preserve native appearance properties.

Canvas paste accepts HTML, JSX, and self-contained React/TSX components, including fenced code
blocks; the shared `@flies/html` package converts them into measured, editable native layers. HTML
import also supports linear/centered radial gradients, 2D rotation/translation, blend modes, and
ordered filters, including Tailwind utilities. Unsupported effects fail before modifying the
document. See the [native paint guide](../apps/desktop/src/mcp/README.md#native-rotation-and-paint)
for supported gradient geometry and filter limits.

## Projects and export

Use the toolbar's **Project menu** to save/open a portable ZIP (`document.json` plus images) or
export a selection as PNG. Project files include the complete hierarchy, styling, and embedded
images. Opening a project replaces the current canvas as one undoable action; an invalid file
leaves it intact. PNG exports use the selected subtree(s) at 1× size, including visible content,
opacity, and frame clipping, without editor controls.

## Keyboard shortcuts

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
| Ctrl/Cmd + Shift + H                | Hide / show the selection                                               |
| Ctrl/Cmd + Shift + L                | Lock the selection; unlock all when nothing is selected                 |
| Ctrl/Cmd + [ / ]                    | Send backward / bring forward; add Shift for back / front               |
| Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z | Undo / redo                                                             |
| Arrow keys                          | Move the selection; resize when a handle has keyboard focus             |
| Shift + arrow keys                  | Move or resize by 10 instead of 1                                       |
| Shift + 1 / Shift + 2               | Fit all objects / fit the selection                                     |
| 0 / + / −                           | Reset zoom to 100% / zoom in / zoom out                                 |
| Escape                              | Cancel a gesture or text draft; otherwise deselect and return to Select |
| Shift + F10                         | Open the context menu                                                   |
