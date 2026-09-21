# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Repository conventions live in [AGENTS.md](AGENTS.md) (structure, style, MCP parity, desktop-only UI
rules) and the long-form docs in `docs/` — [architecture](docs/architecture.md),
[development](docs/development.md), [canvas](docs/canvas.md),
[design system](docs/design-system.md), plus the [MCP guide](apps/desktop/src/mcp/README.md) and
[API setup](apps/api/README.md). This file covers the cross-cutting behavior that is only visible by
reading several files at once.

## Commands

Everything runs from the repository root. `vp` is Vite+ (`vite-plus`); use `bunx vp` if it is not on
PATH.

```bash
bun install                       # or: vp install
bun run api:dev                   # API on :3001 — start this FIRST, the web dev server proxies to it
bun run dev                       # web on :1420 (vp -C apps/web dev)
bun run tauri:dev                 # desktop shell; also serves apps/web on :1420
bun run check                     # vp check (Oxfmt + Oxlint) + typecheck — run before submitting
bun run format                    # write formatting + spacing-only lint fixes
bun run test                      # firefly + canvas + html + web (Vitest via vp) and api (bun test)
bun run db:migrate                # apply Drizzle migrations
```

Single tests:

```bash
vp -C packages/canvas test canvas-camera         # file-name filter (vitest run semantics)
vp -C apps/web test canvas-layers -t "reorders"  # plus test-name filter
bun test --cwd apps/api test/unit.test.ts        # api uses bun test, not Vitest
bun run test:api:integration                     # hits real Neon branch + R2 bucket from root .env
bun run test:gpu                                 # Playwright, Chromium software WebGL2 renderer
bun run test:mcp                                 # Playwright MCP suite (scripts/mcp-tests)
python3 -m unittest discover -s scripts -p 'test_publish_desktop_update.py'
```

The API and its tests read the repository-root `.env` (`bun --env-file=../../.env`); web-facing
values must be `VITE_`-prefixed and server secrets must never be.

## Architecture

Workspace packages and applications:

| Layer                                 | What it owns                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/firefly` (`@flies/firefly`) | Standalone TypeScript WebGL2 drawing, textures, clipping, filters, and compositing                                           |
| `packages/canvas` (`@flies/canvas`)   | Headless document model, geometry, layout, hit-testing, spatial index, theme tokens, clipboard, sync deltas, Firefly adapter |
| `packages/html` (`@flies/html`)       | HTML/JSX/TSX parsing (`@swc/wasm-web`), sanitization, Tailwind v4 compilation, DOM measurement → canvas nodes                |
| `apps/web`                            | React 19 + TanStack Router editor UI, MCP tool handlers, autosave, realtime client                                           |
| `apps/desktop`                        | Tauri v2 Rust shell: native menus, clipboard, fonts, credentials, embedded MCP server                                        |
| `apps/api`                            | Bun + Hono, WorkOS AuthKit, Drizzle/Postgres, gzip revisions in S3, Redis realtime fanout                                    |

### `CanvasDocument` is the single source of truth

`packages/canvas/src/canvas-document.ts` holds every node as an immutable `CanvasFrame` in a `Map`,
plus a derived hierarchy (`ids`, `children`, `order`) and the active page. All mutation funnels
through `transact({ add, update, remove })`; `add`/`update`/`remove`/`reorder`/`moveLayers` are thin
wrappers. Rules that matter when touching it:

- Never mutate a frame object — clone and pass it through a transaction. Layout, token bindings, and
  hierarchy validation run inside `transact` and reject invalid results.
- Drags use `beginGesture` → `previewMany` → `endGesture`, which writes one history entry for the
  whole gesture instead of one per frame.
- Subscriptions are granular: `subscribe` (snapshot), `subscribeFrame(id)` (one node),
  `subscribeChanges`, `subscribeActivePage`. React components subscribe per node so a drag does not
  re-render the tree.
- Undo/redo are patch stacks (~100 entries, in memory only). Structural edits also retain ordering
  arrays, so they cost more memory than geometry edits.
- `apps/web/src/components/canvas/design-canvas.tsx` exposes `CanvasControls` — the document, camera,
  selection, page switching, and preview flush. This is the shared surface used by the UI, the MCP
  handlers, and realtime; prefer adding a capability there over reaching into internals.

### MCP round trip (desktop only)

An agent's tool call crosses three files and must be changed in all of them together:

1. `apps/desktop/src/mcp/mod.rs` — Streamable HTTP server on `127.0.0.1:43123/mcp` (loopback only,
   port overridable with `FLIES_MCP_PORT`),
   writes a client config into the app data dir, holds per-file locks and a request queue.
2. `apps/web/src/lib/mcp/bridge.ts` — one long poll per webview over `invoke("mcp_next_request")`,
   answers with `invoke("mcp_reply")`. There is no direct socket into the webview.
3. `apps/web/src/lib/mcp/editor.ts` — `editorTool(controls, name, args)` validates arguments and
   applies them through `CanvasControls`, so agent edits share document state, undo history, and
   autosave with manual edits. `session.ts` serializes work per file (`withFileLock`).

Tool schemas and prose live in `apps/desktop/src/mcp/tools.rs` (`catalog()`), documented in
`apps/desktop/src/mcp/README.md`, with Rust tests in `apps/desktop/src/mcp/tests.rs` and TS tests in
`apps/web/src/lib/mcp/*.test.ts`. A new canvas feature is incomplete until the tool schema, the
editor handler, import validation, the guide, and both test suites land in the same change.

### Saving, revisions, and realtime

- `FileAutosave` (`apps/web/src/lib/files.ts`) debounces ~500 ms, then `POST
/api/files/:id/revisions` with the last known `revision` and a fresh ULID `mutationId`.
- `apps/api/src/files.ts` gzips the document to S3 _before_ committing the Postgres revision pointer
  under a row lock. A stale base revision returns 409; replaying the same `mutationId` returns the
  original saved document, so retries are safe. Documents are never stored in `localStorage`.
- Realtime is optional: `apps/web/src/lib/realtime.ts` (`RealtimeFile`) requests a ticket from
  `/api/sync/ticket`, then exchanges `DocumentDelta`s produced by
  `packages/canvas/src/canvas-sync.ts` (`diffDocument` / `applyDocumentDelta`) over a WebSocket
  fanned out through Redis (`apps/api/src/realtime/`). Without Redis configured the API reports
  `{ enabled: false }` and the editor stays single-player.
- Remote snapshots must not clobber a live text draft — `CanvasControls.hasTextDraft()` guards that.

### Rendering

The DOM/CSS renderer is the default. The project menu's **Use Firefly renderer** option enables
the custom WebGL2 library (`packages/firefly/`) through `packages/canvas/src/webgl/` and saves
the choice under `flies.canvas.renderer`. Unsupported devices, initialization failure, or context
loss fall back to DOM artwork. Both renderers use the same document, camera, history, and MCP
handlers. Selection overlays, labels, and the text editor remain HTML. PNG export uses the DOM
renderer. See `packages/firefly/README.md` for the API and measured performance limits.

## Gotchas

- Rust commands must be listed in `tauri::generate_handler![...]` in `apps/desktop/src/lib.rs` or
  `invoke` fails silently.
- `apps/web/src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` — never edit it. Add
  routes by dropping files in `apps/web/src/routes/` (`_layout.tsx`, `$param.tsx`, `$.tsx`).
- `apps/web/src/components/ui/**` is vendored from the shadcn registry on Base UI (not Radix); the
  root `vite.config.ts` relaxes style/a11y lint there so `shadcn add` stays diffable.
- Tailwind v4 has no JS config: the theme lives in `apps/web/src/styles.css`, which Oxfmt also reads
  to sort classes. The editor theme is dark-only.
- Lint/format config is root-only — nested `oxlint.config.ts` / `oxfmt.config.ts` files are ignored.
- Desktop-only UI (tab bar, collaborator avatars in it) renders only when `isTauri()` is true.
