# Development

Run everything from the repository root.

| Command                | What it does                                            |
| ---------------------- | ------------------------------------------------------- |
| `vp install`           | Install workspace dependencies (or `bun install`)        |
| `bun run api:dev`      | Backend API on `:3001`                                   |
| `vp -C apps/web dev`   | Frontend dev server on `:1420`                           |
| `bun run tauri:dev`    | Desktop app, starting `apps/web` on `:1420`              |
| `bun run tauri:build`  | Bundled desktop release build                            |
| `bun run build`        | Production frontend build                                |
| `vp check`             | Format + lint (Oxfmt / Oxlint via Vite+)                  |
| `bun run typecheck`    | `tsc --noEmit` in canvas, html, web, and API             |
| `bun run check`        | `vp check` + typecheck, for CI                           |
| `bun run test`         | Vitest in canvas, html, web, and API                     |
| `bun run test:gpu`     | Headless WebGPU pixel, interaction, and fallback checks  |
| `bun run test:mcp`     | Playwright MCP suite                                     |
| `bun run db:migrate`   | Apply API database migrations                            |

```bash
docker build -t flies-web .                  # production image for apps/web
docker run --rm -p 8080:8080 flies-web       # http://localhost:8080
```

Engine tests live next to sources in `packages/canvas`; app tests live in `apps/web`. Playwright
GPU/MCP suites stay under `scripts/`. Run `bun run check` and `bun run test` before submitting.

## Lint and format

Vite+ owns format and lint from the root `vite.config.ts` (`fmt` and `lint` blocks): two-space
indentation, double quotes, semicolons, trailing commas, and a 100-column print width. Run
`bun run format` to format code and insert blank lines around functions, multiline declarations,
blocks, and class methods, and before returns. The command applies only spacing fixes from Oxlint.
Use `bun run format:check` to verify formatting, or `bun run check` for formatting, lint, and
typechecks. Nested `oxlint.config.ts` / `oxfmt.config.ts` files are not used.

Oxfmt sorts Tailwind classes and import statements. It reads the theme from
`apps/web/src/styles.css`, since Tailwind v4 has no JS config.

The root `lint.overrides` block relaxes style/a11y rules for `apps/web/src/components/ui/**` — that
code is vendored from the shadcn registry, and fixing its lint findings would only create diffs
against upstream on the next `shadcn add`. Correctness rules still apply everywhere.

Use PascalCase component names, camelCase variables, and kebab-case component/hook filenames such
as `use-mobile.ts`. Preserve strict TypeScript checks. Follow existing four-space indentation and
snake_case functions in Rust.

## Adding a route

Drop a file in `apps/web/src/routes/`; the Vite plugin regenerates `apps/web/src/routeTree.gen.ts`
on save. Use `$param.tsx` for dynamic segments, `_layout.tsx` for pathless layouts, and `$.tsx` for
catch-alls. Never edit `routeTree.gen.ts` by hand.

## Adding a Rust command

Define it in `apps/desktop/src/lib.rs` and register it in `tauri::generate_handler![...]` —
commands missing from that macro fail silently when invoked. Call it with `invoke<T>("name", args)`
from `@tauri-apps/api/core`.

## Keeping MCP in sync

Canvas features must land with their MCP counterparts: live editor handlers, desktop tool schemas,
import validation, the MCP guide, and tests all change together. Agent edits share UI document
state, persistence, and undo history.

## Desktop and website UI

The workspace tab bar is desktop-only. Render it only when `isTauri()` is true; never show it on
the website, including while a design file is open. Tab-bar collaborator avatars belong to the
desktop UI too.

## Desktop releases and updates

Publishing a GitHub release builds and attaches desktop installers, updater binaries, signatures,
and `latest.json`. Once all five platform builds succeed, the release workflow mirrors every asset
to the S3-compatible R2 bucket configured in
[`scripts/desktop-downloads.json`](../scripts/desktop-downloads.json):

- Endpoint: `https://a3bad09d467f7e00ca2f879e28ecb620.r2.cloudflarestorage.com`
- Region: `auto`
- Bucket: `flies-downloads`
- Public downloads: `https://desktop.flies.design/`
- Stable updater feed: `https://desktop.flies.design/latest.json`

Credentials belong in GitHub Actions secrets `R2_DOWNLOADS_ACCESS_KEY_ID` and
`R2_DOWNLOADS_SECRET_ACCESS_KEY`; they are never shipped in the app. Existing Tauri signing secrets
and the public verification key remain unchanged.

Versioned assets live under `releases/<tag>/`. The publisher checks all platform entries, downloaded
asset sizes, and matching signature files, uploads binaries first, and checks public downloads
before publishing the manifest. Manifest URLs point to the bucket while signatures remain intact.
Only GitHub's current stable release may replace the root feed; prereleases and older reruns only
get versioned files. The root manifest is served with `no-cache` to avoid stale update checks.

Use the **Publish desktop downloads** workflow with an existing release tag to retry an upload or
mirror an older completed release without rebuilding it. GitHub release attachments are preserved.
Existing installed apps keep their compiled GitHub updater endpoint until they install a build
containing the R2 endpoint.

Test the publisher with:

```sh
python3 -m unittest discover -s scripts -p 'test_publish_desktop_update.py'
```
