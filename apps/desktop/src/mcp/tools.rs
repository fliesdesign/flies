use serde_json::{json, Value};

fn tool(name: &str, description: &str, properties: Value, required: &[&str], read: bool) -> Value {
    json!({"name":name,"description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},
        "annotations":{"readOnlyHint":read,"openWorldHint":false}})
}

fn sizing_mode() -> Value {
    json!({"enum":["fixed","fill","hug",null],"description":"fixed keeps the numeric size (default; null resets). fill uses available space in an auto-layout parent; inactive without one and invalid on groups. hug continuously fits visible children and padding, only on frames with native layout. A fill child on an axis its parent hugs uses its minimum size to avoid a cycle."})
}

fn layout_properties() -> Value {
    json!({"type":["object","null"],"additionalProperties":false,"description":"Frame only. Partial patches merge with current layout/defaults; null disables auto layout and resets the frame's hug axes to fixed. Canvas spacing handles edit the same gap and uniform padding fields.","properties":{
        "direction":{"enum":["row","column"]},"gap":{"type":"number","minimum":0},"padding":{"type":"number","minimum":0},"align":{"enum":["start","center","end"]},"justify":{"enum":["start","center","end","space-between"]}
    }})
}

fn node_properties() -> Value {
    let mut properties = serde_json::Map::new();
    for name in [
        "name",
        "text",
        "src",
        "fill",
        "color",
        "stroke",
        "borderColor",
    ] {
        properties.insert(name.into(), json!({"type":"string"}));
    }
    for name in ["x", "y"] {
        properties.insert(name.into(), json!({"type":"number", "description":"Document layout coordinate before ancestor rotations; moving a container also moves descendants. Read get_node_info worldBounds for painted bounds."}));
    }
    for name in ["width", "height"] {
        properties.insert(name.into(), json!({"type":"number", "minimum":1, "description":"Size in pixels (frames need at least 40). Sets this axis to fixed unless its sizing mode is also supplied. Does not change clipping. Use hug sizing for continuous content fitting or fit_node for one-time fitting."}));
    }
    for name in ["widthSizing", "heightSizing"] {
        properties.insert(name.into(), sizing_mode());
    }
    for name in ["fontSize", "strokeWidth", "pathWidth", "pathHeight"] {
        properties.insert(name.into(), json!({"type":"number", "exclusiveMinimum":0}));
    }
    for name in ["cornerRadius", "borderWidth"] {
        properties.insert(name.into(), json!({"type":["number","null"], "minimum":0}));
    }
    for name in ["hidden", "locked"] {
        properties.insert(name.into(), json!({"type":["boolean","null"]}));
    }
    properties.insert("parentId".into(), json!({"type":["string","null"], "description":"Frame/group ID, or null to move to the root."}));
    properties.insert(
        "opacity".into(),
        json!({"type":["number","null"],"minimum":0,"maximum":1}),
    );
    properties.insert("rotation".into(), json!({"type":["number","null"],"description":"Degrees clockwise around the layer center, relative to its parent."}));
    properties.insert("blendMode".into(), json!({"enum":["normal","multiply","screen","overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference","exclusion","hue","saturation","color","luminosity",null]}));
    properties.insert("gradient".into(), json!({"type":["object","null"],"additionalProperties":false,"required":["type","angle","stops"],"description":"Frame/rectangle fill. Stops must be ordered by offset. null restores solid fill.","properties":{
        "type":{"enum":["linear","radial"]},"angle":{"type":"number"},"interpolation":{"enum":["srgb","oklab"]},"background":{"type":"string","pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"},"stops":{"type":"array","minItems":2,"maxItems":16,"items":{"type":"object","additionalProperties":false,"required":["offset","color"],"properties":{"offset":{"type":"number","minimum":0,"maximum":1},"color":{"type":"string","pattern":"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"}}}}
    }}));
    properties.insert("filters".into(), json!({"type":["object","null"],"additionalProperties":false,"properties":{
        "order":{"type":"array","maxItems":8,"uniqueItems":true,"items":{"enum":["blur","brightness","contrast","saturate","grayscale","sepia","invert","hue"]},"description":"Filters run in this order; omitted names follow in editor default order."},"blur":{"type":"number","minimum":0,"maximum":100},"brightness":{"type":"number","minimum":0,"maximum":4},"contrast":{"type":"number","minimum":0,"maximum":4},"saturate":{"type":"number","minimum":0,"maximum":4},"grayscale":{"type":"number","minimum":0,"maximum":1},"sepia":{"type":"number","minimum":0,"maximum":1},"invert":{"type":"number","minimum":0,"maximum":1},"hue":{"type":"number","minimum":-180,"maximum":180}
    }}));
    properties.insert("clipContent".into(), json!({"type":["boolean","null"],"description":"Frame only. true clips descendants to the frame; false allows overflow. Independent of width/height."}));
    properties.insert("fontFamily".into(), json!({"type":["string","null"]}));
    properties.insert(
        "fontWeight".into(),
        json!({"type":["integer","null"],"minimum":1,"maximum":1000}),
    );
    properties.insert(
        "lineHeight".into(),
        json!({"type":["number","null"],"minimum":0.5,"maximum":4}),
    );
    properties.insert(
        "letterSpacing".into(),
        json!({"type":["number","null"],"minimum":-10,"maximum":100}),
    );
    properties.insert(
        "textAlign".into(),
        json!({"enum":["left","center","right",null]}),
    );
    properties.insert("fontStyle".into(), json!({"enum":["normal","italic",null]}));
    properties.insert(
        "textDecoration".into(),
        json!({"enum":["none","underline","line-through",null]}),
    );
    properties.insert("htmlStyles".into(), json!({"type":["string","null"],"maxLength":50000,"description":"Frame only. Prefer set_styles for inherited CSS defaults used by future imports."}));
    properties.insert("layout".into(), layout_properties());
    properties.insert("points".into(), json!({"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"required":["x","y"],"properties":{"x":{"type":"number"},"y":{"type":"number"}}}}));
    properties.insert("shadows".into(), json!({"type":["array","null"],"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["offsetX","offsetY","blur","spread","color"],"properties":{"offsetX":{"type":"number"},"offsetY":{"type":"number"},"blur":{"type":"number","minimum":0},"spread":{"type":"number"},"color":{"type":"string"},"inset":{"type":"boolean"}}}}));
    json!({"type":"object","properties":properties,"additionalProperties":false,"minProperties":1,"description":"Only properties applicable to the target kind are accepted. Optional fields accept null to restore defaults."})
}

pub fn catalog() -> Vec<Value> {
    let string = json!({"type":"string"});
    let ids = json!({"type":"array","items":{"type":"string"},"minItems":1,"maxItems":1000});
    let mut tools = vec![
        tool("get_guide", "REQUIRED FIRST CALL: call get_guide before any other Flies tool. Read the complete design workflow, HTML/CSS rendering limits, responsive sizing and visual verification instructions. Other tools are blocked until this session reads the guide. Returns guideSessionId when the client has no MCP transport session; pass it to subsequent calls.", json!({}), &[], true),
        tool("get_request", "Read a desktop request that timed out after dispatch. Pass the id from that timeout. Returns immediately and does not use the editor or the file queue: status running, or the original tool result once it is stored. The stored result is delivered once.", json!({"id":string}), &["id"], true),
        tool("list_files", "List workspace files, without loading document contents.", json!({}), &[], true),
        tool("create_file", "Create and open a workspace Flies file.", json!({"name":string}), &["name"], false),
        tool("open_file", "Open an existing workspace file by id.", json!({"fileId":string}), &["fileId"], false),
        tool("archive_file", "Archive a workspace file by id. It leaves Recents/Files and can be restored later.", json!({"fileId":string}), &["fileId"], false),
        tool("restore_file", "Restore an archived workspace file by id so it appears in Recents and Files again.", json!({"fileId":string}), &["fileId"], false),
        tool("get_basic_info", "Get a file's pages, active page roots, node count and viewport. Defaults to this MCP session's last create_file/open_file. Pass fileId to target another open file.", json!({}), &[], true),
        tool("get_theme", "Read the file's theme tokens, CSS variable names and layer usage counts.", json!({}), &[], true),
        tool("set_theme", "Create or update theme tokens by stable ID. Existing IDs merge by default; replace:true replaces the full theme. deleteTokenIds removes tokens, preserving current values on linked layers. Bound layers update atomically with undo and save. Types: color (hex), fontFamily, fontWeight (1–1000), lineHeight (0.5–4 unitless), letterSpacing/spacing/radius/fontSize/container/breakpoint (pixels). Container and breakpoint tokens are CSS variables for write_html/preview_html. Every token is available as CSS var(--id); use apply_tokens to retain live links on native layers.", json!({"tokens":{"type":"array","maxItems":500,"items":{"type":"object","additionalProperties":false,"required":["id","name","type","value"],"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{0,79}$"},"name":{"type":"string","minLength":1,"maxLength":120},"type":{"enum":["color","radius","spacing","container","breakpoint","fontFamily","fontWeight","fontSize","lineHeight","letterSpacing"]},"value":{"type":["string","number"]}}}},"replace":{"type":"boolean"},"deleteTokenIds":{"type":"array","items":{"type":"string"}}}), &["tokens"], false),
        tool("apply_tokens", "Bind selected node properties to theme token IDs. Changes to a token update all bound layers. null detaches a binding while keeping the current literal value. Properties must match token types and node kinds; fill maps to text color or pen stroke when appropriate. Literal property edits detach their corresponding token.", json!({"nodeIds":ids,"bindings":{"type":"object","additionalProperties":false,"properties":{"fill":{"type":["string","null"]},"color":{"type":["string","null"]},"stroke":{"type":["string","null"]},"borderColor":{"type":["string","null"]},"fontFamily":{"type":["string","null"]},"fontWeight":{"type":["string","null"]},"fontSize":{"type":["string","null"]},"lineHeight":{"type":["string","null"]},"letterSpacing":{"type":["string","null"]},"cornerRadius":{"type":["string","null"]},"layoutGap":{"type":["string","null"]},"layoutPadding":{"type":["string","null"]},"borderWidth":{"type":["string","null"]},"strokeWidth":{"type":["string","null"]}}}}), &["nodeIds","bindings"], false),
        tool("get_selection", "Get selected node IDs in a file. Defaults to this MCP session's file.", json!({}), &[], true),
        tool("get_node_info", "Get a node's saved properties including sizing modes and resolved numeric dimensions, transformed worldBounds and direct child IDs. Omitted sizing modes mean fixed.", json!({"nodeId":string}), &["nodeId"], true),
        tool("list_pages", "List the file's pages with their node counts and which one is active. A page is a separate canvas; every other tool reads and writes the active page only.", json!({}), &[], true),
        tool("create_page", "Add a page (a separate canvas) and make it active. Subsequent edits land on it. Name defaults to the next free \"Page N\".", json!({"name":string}), &[], false),
        tool("set_page", "Make an existing page active. get_tree, get_screenshot, create_artboard and every write then target that canvas.", json!({"pageId":string}), &["pageId"], false),
        tool("delete_page", "Delete a page and all of its layers as one undoable operation. A file always keeps at least one page.", json!({"pageId":string}), &["pageId"], false),
        tool("get_tree", "Get the active page's node tree, optionally rooted at nodeId. Depth defaults to 5 (max 20). Use set_page to read another canvas.", json!({"nodeId":string,"depth":{"type":"integer","minimum":0,"maximum":20}}), &[], true),
        tool("create_artboard", "Create an artboard or section frame on the active page, using world coordinates. Returns its node ID for later write_html calls.", json!({"name":string,"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number","minimum":40},"height":{"type":"number","minimum":40},"fill":string,"widthSizing":sizing_mode(),"heightSizing":sizing_mode(),"layout":layout_properties()}), &["name","width","height"], false),
        tool("write_html", "Build one small section per call as editable layers. Tailwind CSS v4 class utilities compile automatically, offline; inline CSS also works. Supports native linear/centered radial gradients, 2D rotation/translation, blend modes and ordered filters. Read get_guide first. parentId appends inside a frame/group; replace:true replaces only its children. targetId replaces one node/subtree with one HTML root, preserving its ID, parent and order; cannot combine with parentId or replace. x/y offset the parent or target origin, or use world coordinates without either. Returns root/container IDs, names, bounds and rendering warnings. Inspect warnings and get_screenshot for clipped or overflowing text. validateOnly previews without editing or returning IDs. Use scoped edits, never resend the whole page for a local change.", json!({"html":string,"parentId":string,"targetId":string,"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number","minimum":40,"maximum":8192},"replace":{"type":"boolean"},"height":{"type":"number","minimum":1,"maximum":8192},"validateOnly":{"type":"boolean"}}), &["html"], false),
        tool("write_source", "Import HTML, static React/JSX or TSX as editable layers using the same importer as canvas paste. format defaults to auto; jsx includes TSX. Supports code fences, local function components, literal props, inline style objects, arrays.map and conditionals. Imports never execute; hooks, external components and runtime APIs fail clearly. Event handlers and refs are omitted with sourceWarnings. Tailwind compiles offline; embedded style blocks are validated. Uses the same parentId, targetId, replace, coordinate and validateOnly behavior as write_html. Returns format, sourceWarnings, native rendering warnings and layer IDs. Read get_guide first.", json!({"source":string,"format":{"enum":["auto","html","jsx"]},"parentId":string,"targetId":string,"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number","minimum":40,"maximum":8192},"replace":{"type":"boolean"},"height":{"type":"number","minimum":1,"maximum":8192},"validateOnly":{"type":"boolean"}}), &["source"], false),
        tool("set_styles", "Save shared CSS on a frame/artboard. Future write_html calls inside it or descendants inherit these rules and CSS variables. Survives save/reopen and undo. Existing measured layers are unchanged. Empty css clears defaults. Use :root for typography/tokens and classes for reusable sections.", json!({"nodeId":string,"css":{"type":"string","maxLength":50000}}), &["nodeId","css"], false),
        tool("fit_node", "Fit a frame/group to visible descendant bounds without replacing children or changing its origin. axis defaults to both; padding adds trailing space. Frames clipContent defaults to true, or pass false to keep overflow. One undo step. Call again after adding content; this is not continuous auto-hug.", json!({"nodeId":string,"axis":{"enum":["both","width","height"]},"padding":{"type":"number","minimum":0},"clipContent":{"type":"boolean"}}), &["nodeId"], false),
        tool("preview_html", "Open a live sandboxed HTML prototype alongside the canvas. Supports gradients, hover/focus, CSS animations, inline JS and Tailwind. nodeId inherits saved shared CSS; css adds preview-only rules. No native layers are modified. Preview is transient; Download HTML exports it. Scripts cannot access the editor/Tauri; fetch and external assets are blocked except Google Fonts. get_screenshot still captures native canvas, not this preview.", json!({"html":string,"nodeId":string,"css":{"type":"string","maxLength":50000},"width":{"type":"number","minimum":40,"maximum":8192},"height":{"type":"number","minimum":40,"maximum":8192}}), &["html"], false),
        tool("close_preview", "Close the interactive HTML preview and return to canvas editing.", json!({}), &[], false),
        tool("update_node", "Patch a node using native Flies properties. Bounds use document layout coordinates before ancestor rotations; moving a frame/group translates all descendants. Text edits to copy, font metrics or wrapping width grow its height when needed unless height is explicit or controlled by fill sizing; remaining text overflow/clipping is returned as warnings. SVG src uses a base64 data:image/svg+xml URL. Changing id/kind is forbidden. A single undo step.", json!({"nodeId":string,"properties":node_properties()}), &["nodeId","properties"], false),
        tool("delete_nodes", "Delete layers on the active page and their descendants as one undoable operation. Rejects the whole request if any layer is on another page. Use set_page first; use delete_page to remove a page.", json!({"nodeIds":ids}), &["nodeIds"], false),
        tool("set_selection", "Select a layer on the active page (or clear selection when nodeId is omitted). Use set_page before selecting another page's layer.", json!({"nodeId":string}), &[], false),
        tool("get_screenshot", "Return a PNG image of nodeId and descendants, or all visible root nodes. Includes offscreen content; excludes editor chrome. Max 8192px per side, 32 megapixels.", json!({"nodeId":string}), &[], true),
        tool("save_file", "Flush a file to local compressed JSON storage.", json!({}), &[], false),
        tool("undo", "Undo a document's last edit, including MCP edits.", json!({}), &[], false),
        tool("redo", "Redo a document's last undone edit.", json!({}), &[], false),
    ];
    let file_id = json!({
        "type":"string",
        "description":"Target file. Defaults to this MCP session's last create_file/open_file. Pass it when several agents edit different files."
    });
    for tool in &mut tools {
        let name = tool["name"].as_str().unwrap_or_default();
        let is_guide = name == "get_guide";
        if matches!(
            name,
            "get_basic_info"
                | "get_theme"
                | "set_theme"
                | "apply_tokens"
                | "get_selection"
                | "get_node_info"
                | "get_tree"
                | "list_pages"
                | "create_page"
                | "set_page"
                | "delete_page"
                | "create_artboard"
                | "write_html"
                | "write_source"
                | "set_styles"
                | "fit_node"
                | "preview_html"
                | "close_preview"
                | "update_node"
                | "delete_nodes"
                | "set_selection"
                | "get_screenshot"
                | "save_file"
                | "undo"
                | "redo"
        ) {
            tool["inputSchema"]["properties"]["fileId"] = file_id.clone();
        }
        tool["inputSchema"]["properties"]["guideSessionId"] = json!({
            "type":"string",
            "description":"Workflow session returned by get_guide. Required on subsequent calls when get_guide returned one; also reuse it when rereading the guide. Not authentication."
        });
        if !is_guide {
            let description = tool["description"].as_str().unwrap_or_default();
            tool["description"] = json!(format!("Call get_guide first. {description}"));
        }
    }
    tools
}

pub const INSTRUCTIONS: &str = "Your FIRST Flies tool call must be get_guide. Read its complete response before calling any other tool, including list_files and get_basic_info. Other tools return a recoverable error until this session reads the guide. If get_guide returns guideSessionId, pass it in every subsequent tool's arguments. Flies converts supported HTML/CSS into measured editable canvas layers; browser layouts are not preserved as live CSS. Follow the guide's section-by-section workflow, validate imports, and inspect get_screenshot before claiming a design is complete.";

pub const GUIDE: &str = r##"FIRST CALL: get_guide must be the first Flies tool called in each MCP session. Read this guide before continuing. If the response includes a guideSessionId, pass it in every subsequent call's arguments, including repeated get_guide calls. Each session has its own guide status and opened file; initialization or another agent reading the guide does not unlock your session.

Flies is an editable design canvas, not a browser page. write_html measures supported HTML/CSS at one explicit viewport size and converts the result to native layers. Those layers preserve their measured appearance and coordinates, not live DOM/CSS layout. Use preview_html for interactive prototypes; its browser appearance does not verify native canvas output.

Inspect first: use list_files/open_file for an existing design or create_file for a new one, then get_basic_info, get_tree and get_theme. Reuse the file's fonts, colors, spacing and existing sections. Inspect returned IDs; never invent them. Each session remembers its last opened file; later tools can pass fileId to target that file without switching the visible tab. Mutations share that file's document, undo history and API revision storage.

Design and verification: establish type sizes, line heights, container widths and spacing before building. Use real complete copy, readable contrast and consistent alignment. Create separate desktop and mobile artboards, importing each at its intended width; resizing an imported frame does not rerun responsive CSS. Use min-width:0 on flex/grid text children where needed and enough height for wrapped text. Both normal and explicit line-height are measured from browser layout. Center button labels with flex align-items:center and justify-content:center, or grid place-items:center. Use normal spaces and CSS layout, not space-padded copy. Do not delete words, shrink text or hide overflow to conceal a rendering problem: inspect its bounds and fix the section. After every meaningful import, inspect get_screenshot at the actual target size for missing words, overlaps, clipping, wrapping, alignment and readability. Check desktop and mobile separately. A successful tool response or validateOnly result is not a visual quality check.

Pages: a Flies file holds one or more pages, and each page is a separate canvas with its own artwork. Every tool reads and writes the active page only: get_basic_info and list_pages report the pages and activePageId, set_page switches which one is active, create_page adds one and makes it active, and delete_page removes a page with all of its layers. A file always keeps at least one page. Use separate pages for genuinely separate surfaces (marketing site, app, explorations); use separate artboards inside one page for screens that belong together. An artboard is a frame on a page, not a page. Selection is scoped to the active page; set_selection rejects layers on other pages, so call set_page first. delete_nodes validates all targets before deletion and rejects other pages or page containers; use delete_page for pages.

Build artboards incrementally across separate tool calls:
1. Create the artboard shell with create_artboard. Add small named or semantic section placeholders with write_html, using explicit width/height of at least 40px per side. Empty sections remain editable frames. Use data-name, for example Header, Search, Footer.
2. Read roots and containers in the response to get each section's actual ID. Populate sections one at a time using parentId. Each call becomes visible and saves independently; no full-page HTML call is needed.
3. Inspect with get_tree/get_node_info and get_screenshot after each section. Add more sections or adjust existing nodes with update_node. Never resend an entire page for a local edit.
4. For revisions, parentId plus replace:true replaces only that container's children. targetId replaces exactly one node and its subtree with one imported HTML root, retaining the target's ID, parent and sibling position. Descendant IDs change. targetId cannot combine with parentId or replace. Omit replace to append when using parentId.
Example (substitute actual returned IDs): create_artboard({name:"Home",width:960,height:600}); write_html({parentId:BOARD_ID,html:"<header data-name='Header' style='width:960px;height:64px'></header><main data-name='Search' style='width:960px;height:480px'></main><footer data-name='Footer' style='width:960px;height:56px'></footer>"}); write_html({parentId:HEADER_ID,html:"<div style='width:100%;height:100%;display:flex;justify-content:flex-end;align-items:center;padding:20px'>Gmail</div>"}); get_screenshot({nodeId:BOARD_ID}); write_html({parentId:SEARCH_ID,html:"<div style='width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:64px'>Google</div>"}); get_screenshot({nodeId:BOARD_ID}). Later, write_html({targetId:HEADER_ID,html:"<header data-name='Header' style='width:100%;height:100%;padding:20px'>Gmail · Images</header>"}) revises just the header.
Validation/results: use validateOnly:true before applying a complex or revised section; it measures and validates without creating nodes, saving or changing history. Response includes applied, nodeIds, roots, containers, layer counts and warnings. Inspect every warning: text_overflow reports text whose measured height exceeds its layer, with requiredHeight; clipped_text reports text outside a clipping ancestor, including an existing artboard. Fix unintended clipping with appropriate text/container height or fit_node, then recheck get_screenshot. Keep clipping only when the design intends it. A successful import can still have warnings. containers lists all imported frames/groups with id,name,kind,parentId, layout x/y/width/height and transformed worldBounds, so nested sections can be targeted later. Dry-run roots/containers and warnings omit generated IDs and parent references; preview nodes do not exist yet.
Coordinates: native nodes use absolute document layout x/y, including nested children; ancestor rotations transform these into painted world positions. get_node_info and write_html root/container descriptions include worldBounds for the transformed axis-aligned bounds. write_html x/y offset parentId's origin; targetId offsets the target's previous origin. Without either, x/y are world coordinates. width/height set the HTML containing block, defaulting to the parent's dimensions, or the target's dimensions for targetId. Omit x/y on targetId to keep its origin. This supports percentage dimensions inside each import. Native artboard sizes are at least 40px.
HTML supports passive semantic tags, Tailwind CSS v4 utility classes and inline CSS, block/flex/grid, spacing, solid colors, opacity, uniform corner radius, solid borders (including individual sides), multiple box shadows, inline styled text spans, strong/em, underline/strike, and raster or SVG images. Raster images accept an embedded data URL or a public HTTP or HTTPS URL. Each remote image is downloaded during import and stored as embedded pixels, with a limit of 32 remote images per call. Private hosts, credentials, literal IP addresses, and non-raster responses are refused. Inline SVG imports as a native svg node with its vector source preserved; use SVG gradients for static vector gradient artwork. Text-like inputs render their value or placeholder as editable text. Generic sans-serif/system-ui resolve to Arial; serif to Georgia; monospace to Courier New. Named font families are preserved. Desktop loads installed system fonts; other families load from Google Fonts. Supported weights: 1–1000, subject to the font. Arial, Helvetica, Georgia and Courier New have Regular (400) and Bold (700) faces; other numeric weights use browser font matching, so Thin/Light do not create lighter glyphs. Choose a family with real light faces, such as Inter, for those weights. Fonts load before measurement; unavailable families return an error. Use data-name for meaningful layer names. Named/semantic containers of at least 40px per side survive as frames; unnecessary unnamed wrappers collapse and plain text/shape leaves become single layers.
Tailwind works out of the box in write_html: use class="flex gap-4 p-6 bg-white rounded-xl" with the standard Tailwind v4 theme. No CDN, configuration or stylesheet is needed. Arbitrary values such as w-[420px], descendant variants and responsive utilities are compiled locally per call. Inline styles can be mixed with classes (normal CSS precedence). Responsive breakpoints use the import width, and viewport height uses height or 900px when omitted; rem is 16px. Preflight applies to imports containing classes. Custom classes inherit rules from set_styles; otherwise unknown classes have no styles. Hover/focus states are not activated: the result is a static snapshot. Supported appearance imports include linear/centered radial gradients, 2D rotation and translation, mix-blend-mode and the eight native color/blur filters. Masks, animations, backdrop filters, generated pseudo-element content, scale/skew/3D transforms, conic/repeating/multiple gradients and repeated filter functions fail validation. Use font-thin/light/normal/medium/semibold/bold/black and font-sans/serif/mono; use rounded-full for pills. Example: write_html({parentId:SECTION_ID,html:"<section data-name='Card' class='flex flex-col gap-4 rounded-xl bg-white p-6'><h2 class='text-2xl font-bold text-slate-900'>Hello</h2><p class='text-sm text-slate-600'>Editable Tailwind content</p></section>"}). validateOnly compiles and measures the same way without applying edits.
Theme tokens: call set_theme({tokens:[{id:"brand",name:"Brand",type:"color",value:"#6366f1"},{id:"body-font",name:"Body",type:"fontFamily",value:"Inter"},{id:"space-md",name:"Medium",type:"spacing",value:24},{id:"weight-bold",name:"Bold",type:"fontWeight",value:700},{id:"leading",name:"Leading",type:"lineHeight",value:1.5}]}) once per file. Theme tokens persist and have undo history. Use CSS var(--brand), var(--body-font), var(--space-md) in imports/previews. Container and breakpoint tokens are CSS variables only. To keep native layers linked, apply_tokens({nodeIds:[NODE_ID],bindings:{fill:"brand",fontFamily:"body-font",fontWeight:"weight-bold",lineHeight:"leading"}}) on applicable nodes. get_theme reports tokens and usage; updates propagate to bound layers. Null bindings detach; deleting a token leaves the current rendered value. The left sidebar's Theme tab edits the same tokens; Design pickers can select them.
Source paste and React: write_source({source:"export default function Card() { return <section className=\"p-6 bg-white\"><h2>Hello</h2></section>; }",format:"jsx",width:800}) uses the same @flies/html importer as canvas Cmd/Ctrl+V and menu Paste. format accepts auto, html or jsx (also TSX); fenced snippets work. Self-contained local components, static props, style objects, literal constants, arrays.map and conditional expressions become native editable layers. Imports are syntax only and never loaded or executed. Hooks, external components and runtime APIs fail without changing the document. Event handlers and refs are omitted and reported in sourceWarnings. Embedded plain <style> blocks are validated, isolated and measured. Both write_source and write_html share parentId/targetId scopes, validateOnly, undo and autosave. Review sourceWarnings as well as native rendering warnings.

Shared style workflow: set_styles({nodeId:BOARD_ID,css:":root { --space:24px; font-family:Inter; color:#172033; } .section { padding:var(--space); }"}) saves defaults on the artboard. Later write_html calls inside descendant frames inherit the CSS without repeating it, including custom classes and var() values. Nested frames can override defaults with set_styles. Changes are undoable and saved with the file; empty css clears that frame's rules. Existing native layers keep their measured appearance; shared styles affect future imports and previews. Native layout remains a measured snapshot: existing siblings do not reflow unless a frame has native layout enabled.
Node sizing: update_node and create_artboard accept widthSizing/heightSizing: fixed (default), fill or hug; null resets to fixed. width/height always report resolved numeric dimensions. fill uses available space in a native auto-layout parent, is inactive without one, and is invalid on groups. hug continuously fits visible children plus padding and requires a frame with native layout; the canvas labels it Fit. A fill child on an axis its parent hugs uses its minimum size (40px frame, 1px other) to avoid a cycle. Explicit width/height edits set that axis to fixed unless its sizing mode is supplied in the same patch; clipping stays unchanged. Text copy/font/width changes through update_node measure after fonts load and grow height only when needed, preserving larger boxes. Supplying height explicitly or using heightSizing:fill preserves the requested bounds; update_node returns warnings for remaining text overflow or ancestor clipping. Use fit_node({nodeId:BOARD_ID,axis:"height",padding:24,clipContent:true}) to fit existing content once and fix that axis, retaining every child ID. update_node can explicitly set clipContent:false or merge partial layout properties; layout:null removes auto layout and resets its hug axes to fixed. Canvas gap/padding handles edit these same layout.gap and uniform layout.padding fields; they share MCP document state, undo and save. Moving frames/groups translates descendants; fit_node keeps the origin and child IDs; active native auto layout may reposition children.
Interactive prototypes: preview_html({nodeId:BOARD_ID,html:"<button class='bg-blue-600 hover:bg-blue-700 transition p-4 text-white'>Try me</button>"}) opens a live preview using shared CSS and Tailwind. Gradients, hover/focus, animations and inline JavaScript work there; it cannot access the editor or Tauri; form submission, fetch and external assets are blocked except Google Fonts. The preview does not modify native layers and is not saved with the canvas. Use Download HTML to keep it; close_preview returns to editing. get_screenshot captures the static native canvas, not the live preview.
Unsupported: scripts/events, custom elements, stylesheets, external CSS resources, unsupported gradient geometry or transforms, dashed/dotted borders, non-uniform corner radii, non-square percentage corner radii, cropped images, or clipped containers smaller than 40px. For pill controls use border-radius:999px. Failures occur before editing. Limits: 500 HTML elements, 30 nesting levels, 200KB HTML, 3000 generated layers per insertion. Keep each call section-sized.
Native node kinds: frame,group,rectangle,text,image,svg,pen. update_node supports native properties including borderWidth,borderColor,shadows (array of offsetX,offsetY,blur,spread,color,inset), text fontStyle and textDecoration. Native rotation, blendMode, filters, and frame/rectangle gradient are supported through update_node; write_html imports their supported CSS equivalents through the same native model. rotation is clockwise degrees relative to the parent around the layer center. gradient has type linear/radial, angle, optional interpolation (srgb/oklab) and background (hex), and 2-16 ordered stops with offset 0-1 and hex color. HTML supports centered elliptical farthest-corner radial gradients, one full-size gradient per layer, stops within 0-100% (or equivalent px), and no interpolation hints. With borders, set background-origin:border-box. Modern CSS colors convert to canvas sRGB. Native filters.order retains CSS filter order; omitted names follow in default editor order. filters accepts blur (0-100px), brightness/contrast/saturate (0-4), grayscale/sepia/invert (0-1), and hue (-180 to 180 degrees). SVG src uses a base64 data:image/svg+xml URL. Changing id/kind is forbidden.
No open file produces an actionable error. Tools on different files run in parallel; calls that target the same file stay FIFO while the editor is free. Up to 16 overlapping requests wait automatically. Await write completion when a later screenshot of the same file must follow it. A queue wait times out after 45 seconds without dispatch and is safe to retry. A dispatched call still times out after 45 seconds, but the editor keeps running and the result is stored. The timeout includes a request id. Call get_request with that id. It returns immediately and does not use the editor: status running, or the original tool result once. While that request is unfinished, another tool for the same file also returns immediately with that id instead of waiting. After get_request returns the result, inspection can run. Server lifetime matches the desktop process."##;
