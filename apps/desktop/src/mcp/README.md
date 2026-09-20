# Flies MCP

Flies starts an embedded Rust MCP server alongside its desktop process. It uses the official `rmcp` SDK and Streamable HTTP, bound to `127.0.0.1:43123/mcp`. Quitting Flies ends the server; there is no separate daemon or installation step. Browser-only Flies does not start a server.

## Connect a client

Launch the rebuilt desktop app once. Flies writes an MCP client configuration containing its URL to the app data directory:

- macOS: `~/Library/Application Support/com.flies.app/mcp/client.json`
- Other systems: `<Tauri app data directory>/mcp/client.json`

Use the `flies` entry in a client that supports Streamable HTTP. No authentication or authorization headers are required:

```json
{
  "mcpServers": {
    "flies": { "url": "http://127.0.0.1:43123/mcp" }
  }
}
```

The server is only reachable on loopback. Previously generated tokens are no longer read or used; the client configuration is rewritten without headers on launch.

Set `FLIES_MCP_PORT` before launching Flies to change the port. The generated config reflects the actual port. A port conflict logs a startup error and leaves the editor usable; it never connects to another process's server. MCP accepts native clients, rejects browser Origin headers, validates Host and limits request bodies to 2MB.

## Tools

| Tool                                         | Purpose                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| `get_guide`                                  | Usage and supported HTML/CSS                                |
| `list_files`, `create_file`, `open_file`     | Discover or open local documents                            |
| `get_basic_info`                             | Active document, root nodes and camera                      |
| `get_tree`, `get_node_info`, `get_selection` | Inspect layers and selection                                |
| `create_artboard`                            | Create an editable frame                                    |
| `write_html`                                 | Convert Tailwind or inline-styled HTML into editable layers |
| `update_node`, `delete_nodes`                | Modify existing nodes                                       |
| `set_selection`                              | Select a node or clear selection                            |
| `set_styles`                                 | Save inherited CSS defaults on a frame/artboard             |
| `get_theme`, `set_theme`, `apply_tokens`     | Define theme tokens and link layer properties               |
| `fit_node`                                   | Fit a frame/group to content, with explicit clipping        |
| `preview_html`, `close_preview`              | Open/close an interactive HTML prototype                    |
| `get_screenshot`                             | PNG of a node subtree or the whole document                 |
| `undo`, `redo`, `save_file`                  | Document history and persistence                            |

Start with `get_guide`, then `create_file` or `open_file`. Subsequent editor tools target the active file. Mutation responses wait for the existing autosave queue to flush to compressed JSON. They use the same CanvasDocument transactions and undo history as manual edits. All documents remain local.

### Theme tokens

The left sidebar has **Design** and **Theme** tabs. Theme supports colors, font families,
spacing, radii, and font sizes. The property controls offer matching tokens; changing a
token updates every linked layer, including text measurement and layout. Manual literal
edits detach that property. Deleting a token preserves the layer's current value. Theme
changes support undo/redo, local autosave, browser storage, and portable ZIP projects.

Agents edit the same theme through these tools:

```json
{
  "tokens": [
    { "id": "brand", "name": "Brand", "type": "color", "value": "#6366f1" },
    { "id": "body-font", "name": "Body", "type": "fontFamily", "value": "Inter" },
    { "id": "space-md", "name": "Medium", "type": "spacing", "value": 24 }
  ]
}
```

Pass this object to `set_theme`. Tokens merge by ID; `replace:true` replaces the entire
theme, while `deleteTokenIds` removes selected tokens. Color values use 6- or 8-digit
hex; numeric tokens use pixels. IDs are stable lowercase names with hyphens. `get_theme`
returns the tokens, CSS variable names, and layer usage counts.

Use `apply_tokens({"nodeIds":["TEXT_ID"],"bindings":{"fill":"brand","fontFamily":"body-font"}})`
to link native layers. Use `null` to detach an individual property. `fill` also handles
text color and pen stroke. Layout uses `layoutGap` and `layoutPadding` spacing bindings.
Tokens are available as `var(--brand)`, `var(--body-font)`, and `var(--space-md)` in
`write_html` and `preview_html`. HTML import resolves CSS to literal values; call
`apply_tokens` on imported nodes to retain live links.

### Build a page across calls

Create the page shell first, then build one semantic section per `write_html` call. Every successful call appears in the editor and saves independently. Use `data-name` and explicit dimensions for section placeholders; named or semantic containers at least 40px wide and high remain frames even when empty.

For example, call `create_artboard` with `{"name":"Home","width":960,"height":600}`. Use its returned ID as `PAGE_ID` in a shell call:

```json
{
  "parentId": "PAGE_ID",
  "html": "<header data-name='Header' style='width:960px;height:64px'></header><main data-name='Search' style='width:960px;height:480px'></main><footer data-name='Footer' style='width:960px;height:56px'></footer>"
}
```

Read the returned `containers` to get the real IDs for Header, Search and Footer. Populate Header in another `write_html` call:

```json
{
  "parentId": "HEADER_ID",
  "html": "<div style='width:100%;height:100%;display:flex;justify-content:flex-end;align-items:center;padding:20px'>Gmail</div>"
}
```

Inspect it with `get_screenshot({"nodeId":"PAGE_ID"})`, then populate Search separately:

```json
{
  "parentId": "SEARCH_ID",
  "html": "<div style='width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:64px'>Google</div>"
}
```

Continue with the footer and finer details. Inspect each section with `get_tree`, `get_node_info` or `get_screenshot`; use returned IDs instead of inventing them. A local revision should replace just that section, for example:

```json
{
  "targetId": "HEADER_ID",
  "html": "<header data-name='Header' style='width:100%;height:100%;padding:20px'>Gmail · Images</header>"
}
```

This replaces the Header subtree while preserving its root ID, parent and sibling position. Search and Footer stay intact. For edits inside a container, `parentId` appends children and `parentId` with `replace:true` replaces its children. Use `update_node` for small property changes. Never resend a whole page for a local edit.

Screenshots render all descendants, including offscreen nodes, with the same rendering components used in the editor. They exclude editor chrome, selection outlines and hidden nodes. Limits match PNG export: 8192px per side and 32 megapixels.

### HTML scope

The webview measures block, flex and grid layouts and converts them to editable native nodes. Plain text and shapes become single layers; unnecessary unnamed single-child wrappers collapse. Named and semantic containers at least 40px per side remain frames that later calls can target. Semantic tags, text, `data-name`, and accessible labels provide useful layer names. Only root containers show canvas labels and default artboard shadows, including in existing documents.

### Tailwind CSS

`write_html` automatically compiles Tailwind CSS v4 classes using the bundled compiler and
standard theme. It works offline with no CDN, configuration, installation or extra tool call.
Inline CSS can be mixed with utilities using normal CSS precedence.

```json
{
  "parentId": "RETURNED_SECTION_ID",
  "width": 800,
  "html": "<section data-name='Cards' class='grid grid-cols-1 gap-6 bg-slate-100 p-6 sm:grid-cols-2'><article class='rounded-xl border border-slate-200 bg-white p-6 shadow-md'><h2 class='text-2xl font-bold text-blue-600'>Hello</h2><p class='mt-3 text-sm leading-6 text-slate-600'>Editable Tailwind content</p></article></section>"
}
```

Flex/grid layout, spacing, theme colors, typography, borders, shadows, arbitrary values
(`w-[420px]`) and responsive utilities become regular editable canvas properties.
Responsive breakpoints use the import `width`, not the editor window. Viewport height is
`height` or 900px when omitted, and `rem` is 16px. Tailwind Preflight applies to fragments
containing classes, isolated from editor styles. No CSS or class state leaks between calls.
Use `font-thin`, `font-light`, `font-normal`, `font-medium`, `font-semibold`, `font-bold`, `font-black` and `font-sans`/`serif`/`mono`
to match the canvas's supported typography. `rounded-full` works for pills.

The output is a static snapshot: hover/focus states are not activated, unknown custom
classes have no styling, and application-specific themes/plugins are not loaded.
The native appearance limits below still apply; gradients, transforms, filters, masks,
animations, blend modes and generated pseudo-element content are rejected rather than
silently lost. Classes cannot load external resources. `validateOnly`, incremental edits,
replacement, saving and undo work exactly as with inline CSS.

Supported styles include solid backgrounds, opacity, solid borders (including individual sides), multiple box shadows, uniform corner radii, inline colored text, bold/italic, underline/strike, and explicit line breaks. Text-like inputs become editable value/placeholder text. Generic/system fonts resolve to supported fonts before measurement. Raster images must use data URLs. Native appearance fields survive save/reopen, undo/redo, and PNG export.

Sizes and positions remain a measured snapshot. Use `set_styles` to retain CSS rules, typography and variables for future imports under an artboard; rules from ancestor frames cascade into descendant `write_html` calls. Native `layout` controls automatic reflow; previous HTML flex/grid rules do not become persistent native layout. Unsupported canvas input fails before committing: scripts/events, stylesheets, custom elements, external resources, CSS gradients/transforms, dashed/dotted borders, non-uniform corner radii, non-square percentage radii, cropped images, or clipping on containers smaller than 40px. Inline SVG is preserved as SVG nodes. Use `preview_html` for live CSS and script behavior. Limits: 200KB HTML, 500 elements, 30 nesting levels, and 3000 generated layers per insertion.

### Reuse CSS and fit content

```js
set_styles({
  nodeId: PAGE_ID,
  css: ":root { --space:24px; font-family:Inter; color:#172033; } .section { padding:var(--space); }",
});
write_html({
  parentId: SECTION_ID,
  html: "<section class='section'><h2>Shared typography</h2></section>",
});
fit_node({ nodeId: PAGE_ID, axis: "height", padding: 24, clipContent: true });
```

Styles are stored with the frame and survive undo, copying and save/reopen. They affect future imports and previews; existing measured native layers are unchanged. Set empty CSS to clear a frame's defaults. Nested frame styles override ancestor defaults. Shared CSS must be self-contained; fonts load by family name.

`update_node.properties` now lists supported fields, types and bounds. Numeric width/height are fixed sizes, independent of `clipContent`. Use `fit_node` for one-time content sizing without replacing children; it keeps the origin and child IDs and defaults frame clipping to true. Native auto layout may reposition children during fitting. Partial `layout` patches merge with existing layout/defaults; `layout:null` disables it. Optional properties accept null to restore defaults.

### Interactive prototypes

`preview_html({nodeId: PAGE_ID, html: "...", css: "...", width: 1280, height: 800})` opens an opaque-origin sandbox with gradients, hover/focus, CSS animations, Tailwind and inline JavaScript. `nodeId` inherits saved CSS; extra CSS is preview-only. Scripts cannot access the editor, Tauri or editor storage. Fetch, external scripts/assets and form submissions are blocked, with Google Fonts allowed. The preview is transient and does not create native layers. Download HTML keeps a standalone copy; `close_preview` returns to canvas editing. `get_screenshot` continues to capture native canvas layers, not this interactive preview.

`write_html` supports three scopes, each applied in one undoable transaction:

- Without `parentId` or `targetId`, insert roots using world coordinates.
- With `parentId`, append inside a frame/group. `replace:true` replaces that parent's children, preserving the parent. Coordinates are offsets from the parent; the HTML containing block defaults to its dimensions.
- With `targetId`, replace exactly one node and its descendants. The HTML must produce one root. Its ID, parent and sibling position are retained; new descendants receive new IDs. Coordinates default to the target's old origin, and any supplied `x`/`y` offset that origin. The containing block defaults to the target's dimensions. `targetId` cannot be combined with `parentId` or `replace`.

`width` and `height` override the containing block for any scope. `update_node` coordinates are always world coordinates; moving a frame or group translates all of its descendants with it.

Normal `write_html` results include `applied`, `nodeIds`, `roots`, `containers` and layer counts. Each `containers` entry describes an imported frame/group with its `id`, `name`, `kind`, `parentId` and world `x`, `y`, `width`, `height`, making nested sections easy to target on later calls. `validateOnly:true` measures and validates without changing layers, saves or history; root/container previews omit IDs and parent references because those nodes have not been created. Check `get_screenshot` after applying a section.

### Request handling

The SDK owns protocol negotiation, discovery, request validation and HTTP transport. `mod.rs` forwards tool requests to the main webview through Tauri IPC. `src/lib/mcp/` implements the live editor tools and HTML conversion. Only the main desktop window can use the bridge.

Editor tools execute in FIFO order; up to 16 overlapping requests wait automatically. Pairing writes and screenshots no longer produces busy retries. Await a mutation response when its screenshot must follow it across concurrent clients. Queued calls time out after 45 seconds without being dispatched and are safe to retry. Idle polling waits rather than busy-looping. Unanswered requests time out after 45 seconds. A dispatched edit may already have applied when its request times out: inspect the document before retrying. No active file, invalid input, or failed saves return tool errors.

## Verification

```sh
cargo test --manifest-path apps/desktop/Cargo.toml --lib
vp -C apps/web test src/lib/mcp/editor.test.ts
bunx playwright install chromium
bun run test:mcp
bun run check
bun run build
```

The automated renderer tests use a separate headless browser and temporary Vite server on port 1431. They do not control the user's browser or desktop. Rust tests cover SDK negotiation, tool discovery without authentication, Origin/Host rejection and bridge image/error responses. Renderer tests cover editable HTML, a Google-style page with inline typography and controls, compact layers, borders/shadows, line breaks, rounded images, dry-run validation, incremental section insertion and scoped replacement, agent presence, undo and PNG dimensions/pixels.
