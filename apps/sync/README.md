# Flies sync server

Cloudflare Worker + SQLite-backed Durable Objects for live canvas collaboration. This
replaces Upstash Realtime and the Bun API's WebSocket server. Deploy this directory
as a Worker; the existing Bun API remains responsible for authentication, workspace
membership, billing, document merges, revision storage, and idempotent mutation IDs.

## Architecture

- `SyncRoom`: one object per workspace/file, addressed by an HMAC-derived name.
  It terminates WebSockets, consumes single-use 30-second connection tickets, and
  broadcasts presence and committed revision notifications.
- `SyncUser`: one object per user, enforcing 12 concurrent connection leases,
  60 tickets/minute, and 120 commits/minute across all rooms and API replicas.
- WebSockets use the Hibernation API. Only the connection ID is in the attachment;
  grant and presence state live in SQLite, including selections larger than the
  attachment limit. No in-memory connection map is required after eviction.
- Room alarms recheck session, membership, and file access every ten seconds through
  the API. Outgoing messages stop after a 25-second authorization lease; failed
  checks close the socket. Alarms also reconcile the authoritative revision after
  a missed notification. Empty rooms stop scheduling alarms after tickets expire.
- Commits go through `/internal/sync/commit` on the API and are acknowledged only
  after a durable write. Retry keeps the original mutation ID. Large/offline edits
  still use the authenticated API `/api/files/:id/changes` endpoint.
- Rooms allow at most 100 sockets, each with a 40-message/second limit and a
  512 KiB message limit. Presence cannot supply or override user identity.

Cloudflare is a trusted sync server, not an opaque Redis relay. It temporarily stores
session hashes, names, presence, and connection metadata in Durable Object storage;
it does not store document revisions. All production links use HTTPS/WSS. The
server-to-server secret never reaches the editor. API callbacks use a configured
origin, refuse redirects, and have an eight-second timeout. Tickets travel in the
WebSocket subprotocol, not the URL, and only ticket hashes are stored. Expired tickets,
leases, and disconnected presence are removed. This is not end-to-end encryption.

## Production

The Worker is deployed at `https://sync.flies.design`. It calls the
Unkey API at `https://board.flies.design` and accepts the web origin
`https://app.flies.design`.

In Unkey project `flies`, app `api`, environment `production`, add:

```dotenv
SYNC_SERVER_URL=https://sync.flies.design
SYNC_SERVER_SECRET=<same secret configured on the Worker>
```

Deploy the migrated API and updated clients to complete the cutover. Existing
`API_URL`, `WEB_URL`, database, storage, and authentication settings stay in place.
The old Upstash variables and `SYNC_ENCRYPTION_KEY` are unused by the migrated API;
remove them after the cutover. Never expose `SYNC_SERVER_SECRET` in client builds.

## Deploy

From the repository root:

1. Set `API_URL` and `WEB_URL` in `apps/sync/wrangler.jsonc` to the existing API and
   web origins. The API origin must route `/internal/sync/*` to the Bun API; the
   repository Caddy configuration forwards it for same-origin deployments.
   The defaults are the Flies production origins. The allowlist also
   includes the three existing Tauri localhost origins.
2. Generate a random service secret, e.g. `openssl rand -hex 32`. Set the same
   value as `SYNC_SERVER_SECRET` on the API and in Cloudflare:

   ```sh
   cd apps/sync
   bunx wrangler secret put SYNC_SERVER_SECRET
   ```

3. Run `bun install --frozen-lockfile`, `bun run sync:build`, then
   `bun run sync:deploy` from the root. Wrangler needs an authenticated account
   with Workers and Durable Objects access. The first deployment creates both
   SQLite namespaces through migration `v1`.
4. Set API `SYNC_SERVER_URL` to the deployed HTTPS Worker origin printed by
   Wrangler, without a path. Redeploy the API with this URL and the shared secret.
   A Workers custom domain can be used instead; update `SYNC_SERVER_URL` to match.
5. Deploy the updated web client and release an updated desktop client. The ticket
   endpoint now returns `socketUrl`; clients connect directly to Cloudflare. Old
   desktop builds that assume the API hosts `/api/sync/socket` must be upgraded for
   live collaboration. Their HTTPS save path still works.
6. Check the Worker's `/health`, then open a file in two signed-in clients and
   verify cursor movement and saved edits. Health alone does not prove API callbacks
   or authorization are configured correctly.

Upstash credentials and `SYNC_ENCRYPTION_KEY` are no longer used. Remove them from
the API after switching. Leaving both `SYNC_SERVER_*` variables empty disables
realtime and keeps ordinary autosave; partial configuration fails API startup.
The API and Worker must have matching secrets before issuing tickets.

## Local development

Copy `.dev.vars.example` to `.dev.vars` in this directory and replace the secret.
Set the same secret plus `SYNC_SERVER_URL=http://127.0.0.1:8787` in the root `.env`.
Run the API on port 3001 and the frontend on port 1420, both using `127.0.0.1` origins,
then start the sync Worker with `bun run sync:dev`. Local data stays in ignored
`.wrangler/` storage. Local secrets are ignored too; do not commit them.

## Verification

```sh
bun run --cwd apps/sync typecheck
bun run --cwd apps/sync test
bun run sync:build
```

The test pool runs inside workerd with real Durable Objects and SQLite. It covers
one-use/expired tickets, origins, API secrets, room isolation, presence validation,
durable commit acknowledgement, revocation, quotas, alarms, and WebSocket hibernation.

`apps/api/test/realtime.integration.test.ts` launches a real local Wrangler Worker
and two Bun API replicas against an isolated `TEST_DATABASE_URL`. It needs Node 22+
as well as Bun. Set `DATABASE_URL` to that test database and run:

```sh
bun run --cwd apps/api test:realtime
```

No Cloudflare login or Upstash credentials are needed for tests. The test suite
creates random identities and cleans them up. For the two-browser test, run Vite
on `http://127.0.0.1:1423` with `VITE_API_URL=http://127.0.0.1:3221`, then set
`SYNC_BROWSER_URL=http://127.0.0.1:1423` for the integration test. It verifies live
cursors, edits, offline recovery, undo/redo, and the desktop-only tab-bar boundary.
