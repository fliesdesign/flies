# Flies API

Bun + Hono API with WorkOS AuthKit, Valibot validation, Drizzle on Bun SQL/Postgres, and Bun S3 storage. Every accepted save uploads an immutable gzip-compressed JSON revision. Postgres holds users, default workspaces, file metadata, revision history, and sessions.

## Local development

Copy `.env.example` to `.env` at the repository root and fill the server credentials. Generate `WORKOS_COOKIE_PASSWORD` with at least 32 random characters. Never expose these values through `VITE_` variables.

Run from the repository root:

```sh
bun install
bun run db:migrate
bun run api:dev
# In a second terminal:
bun run dev
# Or launch the native editor with the API still running:
bun run tauri:dev
```

Register `http://localhost:3001/auth/callback` in WorkOS. The web editor runs at `http://localhost:1420` and proxies `/api` and `/auth` to the API. Set `API_URL`, `WEB_URL`, and `WORKOS_REDIRECT_URI` together for other environments.

The provisioned development database is Neon project `blue-art-89162937`, branch `api-testing` (`br-summer-heart-b1clv41o`). The `main` branch is untouched. Revision storage is the private Railway `flies-revisions` bucket in Amsterdam, under the linked `flies` project. The ignored `.env` contains the connection and bucket credentials; integration tests use a unique `tests/` prefix and remove their own objects and rows.

## Authentication

`GET /auth/login` redirects to hosted WorkOS AuthKit. The callback verifies a single-use state bound to an HttpOnly browser cookie and exchanges the code using PKCE. WorkOS credentials are sealed with the server-only cookie password and stored in Postgres. The browser receives an opaque HttpOnly, SameSite=Lax session cookie. HTTPS deployments use Secure cookies. Session tokens are hashed in the session table; every authenticated request validates the sealed WorkOS session and refreshes it under a database row lock when needed.

Desktop opens AuthKit in the system browser. A random verifier held in the webview claims the finished login through `/auth/desktop/complete`; only its hash appears in the login URL. No session token is put in a URL. The desktop app keeps its opaque token in memory, so restarting requires signing in again. The encrypted WorkOS refresh credentials stay on the server.

The first authenticated login creates one default workspace, guarded by a unique owner constraint, and provisions its WorkOS organization with an active owner membership. The workspace ID is the WorkOS external ID; row locks and idempotency keys make provisioning retryable without duplicate organizations. The linked WorkOS ID is stored on the workspace. Existing unlinked workspaces are linked on their next authenticated request, or with `bun src/db/backfill-organizations.ts` inside the API image. All file operations derive the workspace from the authenticated user, never from client-supplied ownership fields. Requests from unapproved browser origins are rejected. Cross-origin desktop requests use a bearer token; browser mutations require the configured origin and JSON content type.

New workspace, file, revision, and save-operation IDs are ULIDs. WorkOS assigns its own user and organization IDs. The initial schema uses text keys; no UUID-to-ULID upgrade migration is included because production was reset.

## Endpoints

| Method | Path                       | Purpose                                              |
| ------ | -------------------------- | ---------------------------------------------------- |
| GET    | `/health`                  | Process health                                       |
| GET    | `/api/me`                  | Current user and default workspace                   |
| GET    | `/api/files`               | Workspace file summaries, including archived entries |
| POST   | `/api/files`               | Create from `{ name, nodes, theme }`                 |
| GET    | `/api/files/:id`           | Read the current document from S3                    |
| POST   | `/api/files/:id/revisions` | Save `{ name, nodes, theme, revision, mutationId }`  |
| GET    | `/api/files/:id/revisions` | List revision metadata                               |
| POST   | `/api/files/:id/archive`   | Set `{ archived: boolean }`                          |
| POST   | `/auth/logout`             | Revoke the app and WorkOS sessions                   |

A revision save supplies the last known `revision` and a new ULID `mutationId`. Reuse that ULID only when retrying the same save after an uncertain response. Same-file writes lock the metadata row. A stale base revision returns 409; a repeated mutation returns its original saved document. Other users receive 404 for inaccessible files. Invalid documents return 400 and oversized requests return 413 (100 MiB maximum).

## Revision storage

Snapshots use `<prefix>/<workspace>/<file>/<revision>-<random ULID>.json.gz`. Bun compresses and uploads before the database transaction commits the file pointer and revision row. A failed upload cannot advance the database revision. A process crash or failed database commit after upload can leave an unreferenced object; do not delete objects by age alone. A future reconciler can remove keys not referenced by revision rows after a grace period. Accepted historical revisions are retained indefinitely; monitor storage growth and add an explicit retention policy before large-scale use.

Use directly readable S3 storage for revisions. Archive tiers requiring restoration would make opening old designs asynchronous. Embedded images remain in every snapshot, compressed with the document; asset deduplication is a separate future optimization.

## Deployment

```sh
docker build -f Dockerfile.api -t flies-api .
docker run --env-file .env -p 3001:3001 flies-api
```

Set the API service's Railway Dockerfile path to `Dockerfile.api`, provide the server environment variables, and run `bun run db:migrate` as a pre-deploy command from the repository root (inside the image use `bun src/db/migrate.ts`). The API image's working directory is `/app/apps/api`. Migrations are explicit and are not run by every web process.

The web image remains `Dockerfile`. Production uses `app.flies.design` for the web app and `board.flies.design` for the API. Configure the API with:

```dotenv
API_URL=https://board.flies.design
WEB_URL=https://app.flies.design
WORKOS_REDIRECT_URI=https://board.flies.design/auth/callback
```

Register that callback in the matching WorkOS environment. Set its initiate login URL to `https://board.flies.design/auth/login` and homepage to `https://app.flies.design`. Use the production environment's API key and client ID when launching.

Set `VITE_API_URL=https://board.flies.design` during both web and desktop production builds. For the web Docker build:

```sh
docker build --build-arg VITE_API_URL=https://board.flies.design -t flies-web .
```

On Railway, set `VITE_API_URL` on the web service; the Dockerfile declares it as a build argument. Changing it requires rebuilding the frontend. The browser calls the API directly with credentials, and the API allows the configured `WEB_URL` origin.

For an optional same-origin deployment, omit `VITE_API_URL` from the web build and set `API_UPSTREAM` to the API service's private host and port (for example `api.railway.internal:3001`); Caddy forwards `/api/*` and `/auth/*`. In that configuration, use the public web origin for both `API_URL` and `WEB_URL`. Never bake an S3 key, WorkOS API key, database URL, or cookie password into the frontend.

## Verification

```sh
bun run check
bun run test
bun run test:api:integration
# Explicit real WorkOS smoke test (creates and deletes one verified test user):
bun --env-file=.env apps/api/test/workos-smoke.ts
cargo test --manifest-path apps/desktop/Cargo.toml --lib --locked
```

Integration tests require `DATABASE_URL` to equal the separately supplied `TEST_DATABASE_URL`. They exercise a real Neon database and Railway S3 bucket with an injected identity provider to cover ownership, concurrent writes, idempotent retry, failed uploads, immutable historical reads, state/verifier checks, and logout. The WorkOS smoke separately exercises real WorkOS authentication and sealed sessions. No authentication bypass exists in the running API.
