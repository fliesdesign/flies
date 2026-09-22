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

AuthKit MFA is optional. Users with an enrolled TOTP authenticator are challenged for its code at sign-in. SSO sign-in does not require MFA.

Passkeys are enabled on hosted AuthKit, including progressive enrollment after a password sign-in. WorkOS only registers passkeys on the AuthKit domain; a custom AuthKit domain should be configured before relying on them in production.

Desktop opens AuthKit in the system browser. A random verifier held in the webview claims the finished login through `/auth/desktop/complete`; only its hash appears in the login URL. No session token is put in a URL. The desktop app keeps its opaque token in memory, so restarting requires signing in again. The encrypted WorkOS refresh credentials stay on the server.

The first authenticated login creates one default workspace, guarded by a unique owner constraint, and provisions its WorkOS organization with an active owner membership. The workspace ID is the WorkOS external ID; row locks and idempotency keys make provisioning retryable without duplicate organizations. The linked WorkOS ID is stored on the workspace. Existing unlinked workspaces are linked on their next authenticated request, or with `bun src/db/backfill-organizations.ts` inside the API image. All file operations derive the workspace from the authenticated user, never from client-supplied ownership fields. Requests from unapproved browser origins are rejected. Cross-origin desktop requests use a bearer token; browser mutations require the configured origin and JSON content type.

New workspace, file, revision, and save-operation IDs are ULIDs. WorkOS assigns its own user and organization IDs. The initial schema uses text keys; no UUID-to-ULID upgrade migration is included because production was reset.

## Endpoints

| Method | Path                       | Purpose                                              |
| ------ | -------------------------- | ---------------------------------------------------- |
| GET    | `/health`                  | Process health                                       |
| GET    | `/api/me`                  | Current user and default workspace                   |
| GET    | `/api/account/mfa`         | Whether the user has an authenticator enrolled       |
| POST   | `/api/account/mfa`         | Start TOTP enrollment and return a QR code           |
| POST   | `/api/account/mfa/verify`  | Confirm enrollment with a 6-digit authenticator code |
| POST   | `/api/account/mfa/remove`  | Turn off two-factor authentication                   |
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

Production runs on Unkey in project `flies`, app `api`, environment `production`, using `Dockerfile.api` from the repository root. Keep Unkey's runtime port and API `PORT` set to `3000`. Provide the server environment variables and run `bun run db:migrate` before deploying database changes (inside the image use `bun src/db/migrate.ts`). The API image's working directory is `/app/apps/api`. Migrations are explicit and are not run by every web process.

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

On the web hosting provider, set `VITE_API_URL` for the build; the Dockerfile declares it as a build argument. Changing it requires rebuilding the frontend. The browser calls the API directly with credentials, and the API allows the configured `WEB_URL` origin.

For an optional same-origin deployment, omit `VITE_API_URL` from the web build and set `API_UPSTREAM` to the API service's private host and port (for example `api:3000`); Caddy forwards `/api/*`, `/auth/*`, and `/internal/sync/*`. In that configuration, use the public web origin for both `API_URL` and `WEB_URL`. Never bake an S3 key, WorkOS API key, database URL, or cookie password into the frontend.

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

## Polar billing (optional)

Leave every `POLAR_*` variable unset or empty to disable billing. This preserves
unrestricted file saves and MCP usage; it does **not** silently assign the Free
plan. `/api/billing` returns `{ enabled: false, plan: null, limits: null }`, and
checkout, portal, and webhook routes return 503. Partial configuration fails at
startup instead of accidentally bypassing payment checks.

To enable billing, set all four server-only values:

- `POLAR_ACCESS_TOKEN`: a Flies organization access token with customer read,
  checkout write, and customer-session write access.
- `POLAR_WEBHOOK_SECRET`: the signing secret for a Raw webhook subscribed to
  `customer.state_changed`, targeting `https://board.flies.design/api/billing/webhook`.
- `POLAR_PRO_PRODUCT_ID`: `14e2d2c3-fa2d-4b26-a686-30efbebbcf1b` in production.
- `POLAR_ORGANIZATION_ID`: `be8119a2-23a8-4edf-ab4c-5edd1ba71ccf` in production.

`POLAR_SERVER` optionally selects `production` (default) or `sandbox`. Sandbox
requires its own token, webhook secret, organization, and product IDs. Run
`bun run db:migrate` before enabling billing. Secrets remain outside source control.

| Entitlement                               | Free                       | Pro ($12/user/month) |
| ----------------------------------------- | -------------------------- | -------------------- |
| Active design files per workspace         | 5                          | Unlimited            |
| Maximum decoded size per image            | 30 MB                      | 250 MB               |
| MCP tool calls per workspace per UTC week | 300                        | 500,000              |
| Public MCP access                         | No                         | Yes                  |
| Workspace type                            | Personal, single workspace | Team workspace       |
| Share links                               | No                         | Yes                  |

All plans allow commercial use.

MB means 1,000,000 bytes. Plan limits are per workspace, not multiplied by paid
seats. Pro returns `limits.designFiles: null` to indicate unlimited files. Existing
files remain readable on downgrade; new files and restores stop at the Free cap,
and saves validate each embedded image. Archived files do not count toward the cap. Billing-enabled
requests allow up to 350 MiB to accommodate a base64-encoded 250 MB image; disabled
mode retains the original 100 MiB request cap.

| Method | Path                       | Purpose                                                  |
| ------ | -------------------------- | -------------------------------------------------------- |
| GET    | `/api/billing`             | Current plan and entitlements                            |
| POST   | `/api/billing/refresh`     | Refresh after checkout; never trusts redirect parameters |
| POST   | `/api/billing/checkout`    | `{ seats: 1 }` (1–1000); returns hosted checkout URL     |
| POST   | `/api/billing/portal`      | Returns hosted subscription management URL               |
| POST   | `/api/billing/mcp/consume` | Reserve one local MCP tool call before dispatch          |
| POST   | `/api/billing/webhook`     | Signature-authenticated Polar events; no app session     |

All other billing routes require the existing app session and mutation-origin
checks. Checkout derives the external customer ID from the authenticated workspace,
and uses only the configured Pro product. It does not accept customer, product,
workspace, or redirect overrides. The owner can choose seats and manage them in
Polar's portal. An active, unexpired subscription to that exact product grants Pro;
other products and payment failures do not. Cancel-at-period-end subscriptions keep
access until their paid period ends.

Customer state is fetched from Polar and cached in Postgres for up to 60 seconds.
Signed webhooks invalidate that cache; the next request reads authoritative state.
Duplicate and out-of-order deliveries cannot restore old access. Both current
Standard Webhooks and legacy Polar signatures are supported, with timestamp checks.
Failed Polar lookups do not silently grant access or downgrade a customer.

The API provides atomic weekly MCP accounting (Monday 00:00 UTC) and checks the
public-access entitlement through `billing.consumeMcp(workspaceId, true)` for future
server-side MCP dispatchers. The existing desktop MCP bridge reserves a local
call through `/api/billing/mcp/consume` before running a tool. Public MCP transport,
and share-link creation are separate features;
this integration exposes their entitlements, not those feature implementations.

Billing tests use an injected provider and signed fixtures. They never charge a
card or create a real customer. A sandbox checkout and deployed webhook delivery
still need verification after credentials and deployment are configured.

## Workspace members and seats

Settings has Appearance, Billing, Members, and Updates tabs. Sign out is available
in the workspace switcher and saves pending edits before ending the session. The sidebar
keeps the Upgrade to Pro action for Free workspace owners. Checkout lets the owner
choose seats; existing subscribers manage seats in the Polar billing portal.

The Members tab sends seven-day WorkOS email invitations. The owner occupies one
seat, and each unexpired pending invitation reserves one. Invitation creation and
acceptance force a Polar refresh and lock the workspace row before checking capacity,
so concurrent requests cannot overbook seats. Seat quantity comes from the active
Polar subscription, never client input. Free workspaces have one seat. When billing
is disabled, seat limits are disabled too.

Invitees sign in with their verified invited email and accept under Settings → Members.
Joined workspaces appear in the workspace switcher; selection is stored per session.
Members can edit shared files. Only the owner can invite, revoke invitations, remove
members, start checkout, or open the billing portal. A downgrade leaves the owner
and oldest members within the paid capacity active; excess members lose access until
seats are restored. Existing invitations cannot be accepted beyond the new capacity.
Normal access uses the billing cache (up to 60 seconds, invalidated by webhooks).

Run `bun run db:migrate` before deploying this change (migration `0002_real_madripoor`).
WorkOS uses the existing API credentials and its configured invitation email/AuthKit
flow; no additional environment variables are required. Integration tests mock email
delivery and Polar. Actual email delivery still needs verification in the deployed
WorkOS environment.

## Realtime collaboration

Realtime connections run in `apps/sync`, a Cloudflare Worker with SQLite-backed
Durable Objects. The API retains session/workspace/billing checks and durable,
idempotent file writes. Upstash and the API-hosted WebSocket server are no longer
used. See [the sync server guide](../sync/README.md) for deployment and testing.

Set `SYNC_SERVER_URL` to the Worker's HTTPS origin and `SYNC_SERVER_SECRET` to a
random secret of at least 32 characters. Configure the same secret on the Worker,
along with its `API_URL` and `WEB_URL`. Both variables empty disables collaboration;
partial configuration fails startup. HTTP origins are accepted only on loopback.

The authenticated, CSRF-protected `/api/sync/ticket` endpoint checks access and
returns a one-use ticket and `socketUrl`. Updated web and desktop clients connect
directly to that Worker. The Worker calls `/internal/sync/authorize` and
`/internal/sync/commit` with the shared service secret; these endpoints do not accept
ordinary user bearer tokens. Every internal commit rechecks access before writing.

Changes merge under the file database row lock; retries preserve mutation IDs and
reconnects reapply unsaved local changes over the latest committed revision. Large
updates and offline saves use `/api/files/:id/changes` over HTTPS. Worker room alarms
reconcile revision notifications and revoke connections when access changes.

Deploy the Worker first, then configure/redeploy the API and updated clients. Older
desktop builds must be updated for live collaboration because their socket URL is
fixed to the API. Remove the old Upstash variables and `SYNC_ENCRYPTION_KEY` after
cutover. Cloudflare now holds temporary connection/presence state as a trusted sync
server; it is not an encrypted Redis relay or the durable document store.
