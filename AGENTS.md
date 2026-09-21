# Repository Guidelines

## Default Agent Skills

Use these skills by default, applying each to the relevant work:

- `$just-fucking-do-it`: complete authorized tasks end to end and verify results.
- `$tauri-v2`: guide Tauri configuration, IPC, capabilities, and desktop integration.
- `$frontend-design`: guide frontend UI design and implementation.
- `$rust-best-practices`: guide Rust implementation, review, and testing.

## Project Structure & Module Organization

Flies is a Vite+ Bun workspace with a Tauri v2 desktop shell.

- `packages/canvas/`: canvas engine (`@flies/canvas`) — document model, geometry, GPU, clipboard
- `apps/web/src/routes/`: file-based pages; `__root.tsx` provides the shared layout
- `apps/web/src/components/ui/`: reusable shadcn components built on Base UI
- `apps/web/src/hooks/` and `apps/web/src/lib/`: app hooks, MCP, files, snapshots; `@/` aliases `apps/web/src`
- `apps/web/src/styles.css`: global styles and theme tokens; `apps/web/public/`: static assets
- `apps/desktop/src/lib.rs`: native commands and app setup; `main.rs`: entry point
- `apps/desktop/capabilities/`: desktop permissions
- Root `vite.config.ts`: Vite+ `fmt` and `lint` for the whole workspace

Do not manually edit `apps/web/src/routeTree.gen.ts`; the router plugin generates it. Keep build
outputs in `apps/web/dist/` and `apps/desktop/target/` out of contributions.

## Desktop and Website UI

The workspace tab bar is **desktop-only**. Render it only when `isTauri()` is true;
never show it on the website, including while a design file is open. Tab-bar
collaborator avatars belong to the desktop UI too. Do not enable the tab bar on
the website to expose a desktop feature or simplify browser testing.

## Build, Test, and Development Commands

Run these from the repository root:

- `vp install` or `bun install`: install workspace dependencies
- `bun run dev` / `vp -C apps/web dev`: start the frontend development server
- `bun run tauri:dev`: launch the desktop app with the development server
- `bun run typecheck`: `tsc --noEmit` in canvas and web
- `vp check`: Oxfmt + Oxlint
- `bun run check`: format, lint, and typecheck
- `bun run test`: Vitest in `packages/canvas` and `apps/web`
- `bun run build`: production frontend build
- `bun run tauri:build`: desktop release bundle
- `docker build -t flies-web .`: production image for `apps/web` (Caddy on 8080)

## Coding Style & Naming Conventions

Root `vite.config.ts` `fmt` / `lint` blocks: two-space indentation, double quotes, semicolons,
trailing commas, and a 100-column print width. Oxfmt sorts imports and Tailwind classes.

Use PascalCase component names, camelCase variables, and kebab-case component/hook filenames such as
`use-mobile.ts`. Preserve strict TypeScript checks. Follow existing four-space indentation and
snake_case functions in Rust.

## Testing Guidelines

Engine tests live next to sources in `packages/canvas`. App tests live in `apps/web`. Playwright
GPU/MCP suites stay under `scripts/`. Before submitting, run `bun run check` and `bun run test`.
