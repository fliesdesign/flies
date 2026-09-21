# @flies/html

Shared conversion from HTML, JSX and static React/TSX snippets into editable `@flies/canvas`
layers. Canvas paste and MCP use this package; it does not mutate a document or save files.

```ts
import { importSource } from "@flies/html";

const { nodes, warnings, format } = await importSource(source, {
  format: "auto", // "html" or "jsx" (including TSX) also accepted
  x: 0,
  y: 0,
  width: 800,
  // height, parentId and shared css are optional
});
document.addMany(nodes); // one undoable editor operation after successful conversion
```

`importHtml` handles HTML directly. `detectSourceFormat` and `unwrapSource` are available
from `@flies/html/source` without loading the DOM importer. Tailwind compilation is exported
from `@flies/html/tailwind`; both Tailwind and the JSX parser load on demand. `@swc/wasm-web`
parses JSX/TSX locally using a bundled WASM asset. Initialization is shared across concurrent
imports, and failed WASM loads can be retried. HTML-only paste does not load SWC. DOM measurement
requires a browser. `importHtmlFragment` is for already sanitized internal capture fragments.

- `source.ts`: clipboard detection and code fences.
- `jsx-parser.ts`: lazy SWC WASM initialization and syntax parsing.
- `jsx.ts`: bounded static interpretation of SWC's JSX/TypeScript AST, without `eval` or scripts.
- `html-sanitize.ts`: passive elements, attributes, styles and embedded image validation.
- `html.ts`, `html-style.ts`, `html-paint.ts`: isolated measurement, native layers and paint.
- `tailwind.ts`, `styles.ts`: offline utilities and shared/embedded stylesheet validation.

JSX supports fragments, local function components/helpers, static props and children, literal
constants, style objects, conditionals and `array.map`. Imports are inert syntax; dependencies,
hooks, runtime APIs, class components and `dangerouslySetInnerHTML` are unsupported. Event
handlers and refs are omitted with warnings. Generated markup always passes the HTML sanitizer.

HTML supports the canvas's existing passive elements and CSS subset, Tailwind classes, embedded
plain `<style>` blocks, and raster/SVG images. A raster image may be an embedded data URL or a
public HTTP or HTTPS URL; the import downloads it and stores the pixels. Private hosts,
credentials, and non-raster responses are refused. Scripts, external CSS, unsupported CSS
effects and custom elements fail before editing. Limits: 200KB input/output, 500 HTML elements,
30 nested levels; static JSX also bounds operations, arrays and intermediate string growth.

Run `bun run --cwd packages/html test` and `bun run --cwd packages/html typecheck`. Browser
import/paste/MCP integration tests live in `scripts/mcp-tests/`. `bun run test:source:production`
checks the emitted WASM asset and paste/autosave/undo/reload in the built application.
