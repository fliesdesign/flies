# Repository Guidelines

## Default Agent Skills

Use these skills by default, applying each to the relevant work:

- `$just-fucking-do-it`: complete authorized tasks end to end and verify results.
- `$tauri-v2`: guide Tauri configuration, IPC, capabilities, and desktop integration.
- `$frontend-design`: guide frontend UI design and implementation.
- `$rust-best-practices`: guide Rust implementation, review, and testing.

## Project Structure & Module Organization

This is a Tauri v2 desktop app with React 19, TypeScript, Vite, TanStack Router, and Tailwind CSS v4.

- `src/routes/`: file-based pages; `__root.tsx` provides the shared layout.
- `src/components/ui/`: reusable shadcn components built on Base UI.
- `src/hooks/` and `src/lib/`: shared hooks and utilities; use the `@/` source alias.
- `src/styles.css`: global styles and theme tokens; `public/`: static assets.
- `src-tauri/src/lib.rs`: native commands and app setup; `main.rs`: entry point.
- `src-tauri/capabilities/`: desktop permissions; `src-tauri/icons/`: app icons.

Do not manually edit `src/routeTree.gen.ts`; the router plugin generates it. Keep build outputs in `dist/` and `src-tauri/target/` out of contributions.

## Build, Test, and Development Commands

Run these from the repository root:

- `bun install`: install frontend dependencies using `bun.lock`.
- `bun run dev`: start the frontend development server.
- `bun run tauri:dev`: launch the desktop app with the development server.
- `bun run typecheck`: check TypeScript without emitting files.
- `bun run build`: build the frontend and check TypeScript.
- `bun run preview`: preview the built frontend.
- `bun run tauri:build`: create a desktop release bundle; requires Rust and platform build prerequisites.

## Coding Style & Naming Conventions

Follow `oxfmt.config.ts`: two-space indentation, double quotes, semicolons, trailing commas, and a 100-column print width. Oxfmt also sorts imports and Tailwind classes. `oxlint.config.ts` defines correctness, React, TypeScript, and accessibility checks; no lint or format package scripts currently exist.

Use PascalCase component names, camelCase variables, and kebab-case component/hook filenames such as `use-mobile.ts`. Preserve strict TypeScript checks. Follow existing four-space indentation and snake_case functions in Rust.

## Testing Guidelines

No automated test suite, test script, or coverage threshold is configured. Before submitting, run typecheck and build, then manually verify navigation, theme behavior, and changed interactions. Test native commands such as `greet` in the desktop app. Document verification steps and results in the PR.

## Commit & Pull Request Guidelines

This directory has no Git metadata, so historical commit conventions cannot be verified. Use concise, imperative subjects, for example `Fix greeting error handling`. Keep changes focused. PRs should explain behavior changes, link relevant issues, list validation results, and include screenshots for UI changes.
