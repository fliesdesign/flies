import {
  commitSchema,
  grantSchema,
  idSchema,
  presenceSchema,
  secretMatches,
  secureServiceUrl,
  SYNC_MESSAGE_BYTES,
  SYNC_PROTOCOL,
  type Peer,
  type SyncGrant,
} from "@flies/sync";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

export interface Env {
  SYNC_ROOMS: DurableObjectNamespace<SyncRoom>;
  SYNC_USERS: DurableObjectNamespace<SyncUser>;
  API_URL: string;
  WEB_URL: string;
  SYNC_SERVER_SECRET: string;
}

class SyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const colors = ["#4c9aff", "#b18cff", "#ff9770", "#54c7a0", "#e78fcb", "#e1b34b"];

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hash = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function objectName(env: Env, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SYNC_SERVER_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function userObject(env: Env, userId: string) {
  return env.SYNC_USERS.getByName(await objectName(env, `user:${userId}`));
}

function allowedOrigin(env: Env, origin: string) {
  return [
    new URL(env.WEB_URL).origin,
    new URL(env.API_URL).origin,
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ].includes(origin);
}

async function jsonBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new SyncError(415, "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new SyncError(400, "Missing request body.");
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      // Read incrementally so a missing or dishonest Content-Length cannot bypass the limit.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > SYNC_MESSAGE_BYTES + 4096) throw new SyncError(413, "Request is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return JSON.parse(new TextDecoder().decode(body));
}

async function api<T>(env: Env, action: "authorize" | "commit", body: unknown): Promise<T> {
  const response = await fetch(`${secureServiceUrl(env.API_URL)}/internal/sync/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SYNC_SERVER_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok)
    throw new SyncError(
      [401, 403, 404, 429].includes(response.status) ? response.status : 503,
      "Sync access or write could not be verified.",
    );

  return response.json<T>();
}

async function schedule(ctx: DurableObjectState, at: number) {
  const current = await ctx.storage.getAlarm();
  if (current === null || current > at) await ctx.storage.setAlarm(at);
}

/** Per-user quotas coordinate all rooms without a global bottleneck. */
export class SyncUser extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
  }

  async take(bucket: "tickets" | "commits") {
    const now = Date.now();
    const maximum = bucket === "tickets" ? 60 : 120;

    const allowed = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM limits WHERE expires <= ?", now);

      const row = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT count FROM limits WHERE bucket = ?", bucket)
        .toArray()[0];

      if ((row?.count ?? 0) >= maximum) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1",
        bucket,
        now + 60_000,
      );

      return true;
    });

    await schedule(this.ctx, now + 60_000);

    return allowed;
  }

  async lease(id: string) {
    const now = Date.now();

    const allowed = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires <= ?", now);

      const exists =
        this.ctx.storage.sql.exec("SELECT id FROM leases WHERE id = ?", id).toArray().length > 0;

      if (
        !exists &&
        this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases").one()
          .count >= 12
      )
        return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO leases VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET expires = excluded.expires",
        id,
        now + 30_000,
      );

      return true;
    });

    await schedule(this.ctx, now + 30_000);

    return allowed;
  }

  release(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE id = ?", id);
  }

  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires <= ?", Date.now());
    this.ctx.storage.sql.exec("DELETE FROM limits WHERE expires <= ?", Date.now());

    const row = this.ctx.storage.sql
      .exec<{ expires: number | null }>(
        "SELECT MIN(expires) AS expires FROM (SELECT expires FROM leases UNION ALL SELECT expires FROM limits)",
      )
      .one();

    if (row.expires !== null) await this.ctx.storage.setAlarm(row.expires);
  }
}

type ConnectionRow = {
  id: string;
  grant_json: string;
  peer_json: string;
  valid_until: number;
  window: number;
  messages: number;
};

/** One file, one fan-out point. WebSockets and SQLite survive hibernation. */
export class SyncRoom extends DurableObject<Env> {
  private readonly writing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, grant_json TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, peer_json TEXT NOT NULL, valid_until INTEGER NOT NULL, window INTEGER NOT NULL, messages INTEGER NOT NULL)",
    );
  }

  async issue(grant: SyncGrant) {
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    this.ctx.storage.sql.exec(
      "INSERT INTO tickets VALUES (?, ?, ?)",
      await hash(token),
      JSON.stringify(grant),
      Date.now() + 30_000,
    );
    await schedule(this.ctx, Date.now() + 10_000);

    return token;
  }

  private connection(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as { id: string } | null;
    if (!attachment) return undefined;

    return this.ctx.storage.sql
      .exec<ConnectionRow>("SELECT * FROM connections WHERE id = ?", attachment.id)
      .toArray()[0];
  }

  private send(ws: WebSocket, value: unknown) {
    const row = this.connection(ws);
    if (!row || row.valid_until <= Date.now() || ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(value));
    } catch {
      this.drop(ws, 1013, "Reconnect to sync.");
    }
  }

  private broadcast(value: unknown) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, value);
  }

  notify(revision: number) {
    this.broadcast({ type: "changed", revision, at: Date.now() });
  }

  private drop(ws: WebSocket, code: number, reason: string) {
    const row = this.connection(ws);

    if (row) {
      this.ctx.storage.sql.exec("DELETE FROM connections WHERE id = ?", row.id);
      const grant = JSON.parse(row.grant_json) as SyncGrant;
      this.ctx.waitUntil(
        userObject(this.env, grant.user.id)
          .then((user) => user.release(row.id))
          .catch(() => {}),
      );
      this.broadcast({ type: "leave", connectionId: row.id, at: Date.now() });
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING)
      ws.close(code, reason);
  }

  async fetch(request: Request) {
    const protocols =
      request.headers
        .get("Sec-WebSocket-Protocol")
        ?.split(",")
        .map((item) => item.trim()) ?? [];

    const credential = protocols.find((item) => item.startsWith("ticket."))?.split(".")[2];
    if (!credential) return new Response("Unauthorized", { status: 401 });
    const tokenHash = await hash(credential);

    const ticket = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ grant_json: string; expires: number }>(
          "SELECT grant_json, expires FROM tickets WHERE hash = ?",
          tokenHash,
        )
        .toArray()[0];

      if (!row || row.expires <= Date.now()) return null;
      const grant = JSON.parse(row.grant_json) as SyncGrant;
      if (grant.origin !== request.headers.get("Origin")) return null;
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE hash = ?", tokenHash);

      return grant;
    });

    if (!ticket) return new Response("Unauthorized", { status: 401 });
    const id = crypto.randomUUID();
    const user = await userObject(this.env, ticket.user.id);
    let leased = false;
    let accepted: WebSocket | undefined;

    try {
      const authorized = await api<{ revision: number }>(this.env, "authorize", { grant: ticket });
      leased = await user.lease(id);
      if (!leased) throw new SyncError(429, "Too many connections.");
      if (this.ctx.getWebSockets().length >= 100)
        throw new SyncError(429, "This file has too many connections.");

      const hue =
        [...ticket.user.id].reduce((total, char) => total + char.charCodeAt(0), 0) % colors.length;

      const peer: Peer = {
        connectionId: id,
        userId: ticket.user.id,
        name: ticket.user.name,
        color: colors[hue],
        cursor: null,
        selection: [],
        activity: "viewing",
        updatedAt: Date.now(),
      };

      const peers = this.ctx.storage.sql
        .exec<{ peer_json: string }>(
          "SELECT peer_json FROM connections WHERE valid_until > ?",
          Date.now(),
        )
        .toArray()
        .map((row) => JSON.parse(row.peer_json) as Peer);

      const pair = new WebSocketPair();
      this.ctx.storage.sql.exec(
        "INSERT INTO connections VALUES (?, ?, ?, ?, ?, 0)",
        id,
        JSON.stringify(ticket),
        JSON.stringify(peer),
        Date.now() + 25_000,
        Date.now(),
      );
      this.ctx.acceptWebSocket(pair[1]);
      accepted = pair[1];
      pair[1].serializeAttachment({ id });
      await schedule(this.ctx, Date.now() + 10_000);
      this.send(pair[1], {
        type: "ready",
        connectionId: id,
        userId: ticket.user.id,
        revision: authorized.revision,
        peers,
      });
      this.broadcast({ type: "presence", peer, at: Date.now() });

      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": SYNC_PROTOCOL },
      });
    } catch (error) {
      accepted?.close(1011, "Could not join sync.");
      if (leased) await user.release(id);
      this.ctx.storage.sql.exec("DELETE FROM connections WHERE id = ?", id);

      return new Response("Could not join sync.", {
        status: error instanceof SyncError ? error.status : 503,
      });
    }
  }

  async webSocketMessage(ws: WebSocket, payload: string | ArrayBuffer) {
    const row = this.connection(ws);

    if (!row || row.valid_until <= Date.now()) {
      this.drop(ws, 4001, "Reconnect to verify access.");

      return;
    }

    if (typeof payload !== "string") {
      this.drop(ws, 1003, "Use JSON messages.");

      return;
    }

    if (encoder.encode(payload).length > SYNC_MESSAGE_BYTES) {
      this.drop(ws, 1009, "Message is too large.");

      return;
    }

    const now = Date.now();
    const window = now - row.window >= 1000 ? now : row.window;
    const count = (window === row.window ? row.messages : 0) + 1;
    this.ctx.storage.sql.exec(
      "UPDATE connections SET window = ?, messages = ? WHERE id = ?",
      window,
      count,
      row.id,
    );

    if (count > 40) {
      this.drop(ws, 1008, "Message rate exceeded.");

      return;
    }

    let mutationId: string | undefined;

    try {
      const input = JSON.parse(payload);

      if (input.type === "presence") {
        const peer: Peer = {
          ...JSON.parse(row.peer_json),
          ...v.parse(presenceSchema, input.presence),
          updatedAt: now,
        };

        this.ctx.storage.sql.exec(
          "UPDATE connections SET peer_json = ? WHERE id = ?",
          JSON.stringify(peer),
          row.id,
        );
        this.broadcast({ type: "presence", peer, at: now });

        return;
      }

      if (input.type !== "commit") throw new SyncError(400, "Unknown sync message.");
      const change = v.parse(commitSchema, input.change);
      mutationId = change.mutationId;
      if (this.writing.has(row.id))
        throw new SyncError(429, "Connection is busy. Retry this change.");
      this.writing.add(row.id);

      try {
        const grant = JSON.parse(row.grant_json) as SyncGrant;
        if (!(await (await userObject(this.env, grant.user.id)).take("commits")))
          throw new SyncError(429, "Too many edits. Retry shortly.");

        const result = await api<{ revision: number; mutationId: string }>(this.env, "commit", {
          grant,
          change,
        });

        this.send(ws, { type: "ack", ...result });
        this.notify(result.revision);
      } finally {
        this.writing.delete(row.id);
      }
    } catch (error) {
      const code =
        error instanceof SyncError
          ? error.status
          : v.isValiError(error) || error instanceof SyntaxError
            ? 400
            : 503;

      this.send(ws, {
        type: "error",
        mutationId,
        code,
        error: "Could not sync this change. Retry.",
      });
      if ([401, 403, 404].includes(code)) this.drop(ws, 4003, "Access is no longer available.");
    }
  }

  webSocketClose(ws: WebSocket) {
    this.drop(ws, 1000, "File closed.");
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws, 1011, "Reconnect to sync.");
  }

  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires <= ?", Date.now());
    const sockets = this.ctx.getWebSockets();
    const liveIds = new Set(sockets.map((ws) => (ws.deserializeAttachment() as { id: string }).id));
    // A runtime restart can remove sockets without running close handlers.
    for (const row of this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM connections"))
      if (!liveIds.has(row.id))
        this.ctx.storage.sql.exec("DELETE FROM connections WHERE id = ?", row.id);
    await Promise.all(
      sockets.map(async (ws) => {
        const row = this.connection(ws);
        if (!row) return;

        try {
          const grant = JSON.parse(row.grant_json) as SyncGrant;
          const authorized = await api<{ revision: number }>(this.env, "authorize", { grant });
          if (!(await (await userObject(this.env, grant.user.id)).lease(row.id)))
            throw new SyncError(429, "Connection limit exceeded.");
          const current = this.connection(ws);
          if (!current || ws.readyState !== WebSocket.OPEN) return;
          const peer: Peer = { ...JSON.parse(current.peer_json), updatedAt: Date.now() };
          this.ctx.storage.sql.exec(
            "UPDATE connections SET valid_until = ?, peer_json = ? WHERE id = ?",
            Date.now() + 25_000,
            JSON.stringify(peer),
            row.id,
          );
          this.send(ws, { type: "changed", revision: authorized.revision, at: Date.now() });
          this.broadcast({ type: "presence", peer, at: Date.now() });
        } catch {
          this.drop(ws, 4003, "Access could not be verified. Reconnect.");
        }
      }),
    );

    const pendingTickets = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM tickets")
      .one().count;

    const active = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM connections")
      .one().count;

    if (active || pendingTickets) await schedule(this.ctx, Date.now() + 10_000);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET")
        return Response.json({ ok: true, backend: "durable-objects" });
      if (env.SYNC_SERVER_SECRET?.length < 32 || !env.SYNC_SERVER_SECRET)
        return new Response("Sync is not configured.", { status: 503 });
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        return new Response("HTTPS required.", { status: 426 });

      if (url.pathname === "/api/sync/socket") {
        if (
          request.method !== "GET" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
        )
          return new Response("WebSocket required.", { status: 426 });
        if (!allowedOrigin(env, request.headers.get("Origin") ?? ""))
          return new Response("Forbidden", { status: 403 });

        const protocols =
          request.headers
            .get("Sec-WebSocket-Protocol")
            ?.split(",")
            .map((item) => item.trim()) ?? [];

        const ticket = protocols.find((item) => item.startsWith("ticket."));
        const match = ticket?.match(/^ticket\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/);
        if (!protocols.includes(SYNC_PROTOCOL) || !match)
          return new Response("Unauthorized", { status: 401 });

        return await env.SYNC_ROOMS.getByName(match[1]).fetch(request);
      }

      if (!url.pathname.startsWith("/internal/") || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      if (!(await secretMatches(request.headers.get("Authorization"), env.SYNC_SERVER_SECRET)))
        return new Response("Unauthorized", { status: 401 });
      const body = await jsonBody(request);

      if (url.pathname === "/internal/ticket") {
        const grant = v.parse(grantSchema, body);
        if (!allowedOrigin(env, grant.origin)) throw new SyncError(403, "Forbidden");
        if (!(await (await userObject(env, grant.user.id)).take("tickets")))
          throw new SyncError(429, "Too many connections.");
        const room = await objectName(env, `room:${grant.workspaceId}:${grant.fileId}`);
        const token = await env.SYNC_ROOMS.getByName(room).issue(grant);

        return Response.json({ ticket: `${room}.${token}` });
      }

      if (url.pathname === "/internal/changed") {
        const value = v.parse(
          v.strictObject({
            workspaceId: idSchema,
            fileId: idSchema,
            revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
          }),
          body,
        );

        const room = await objectName(env, `room:${value.workspaceId}:${value.fileId}`);
        await env.SYNC_ROOMS.getByName(room).notify(value.revision);

        return Response.json({ ok: true });
      }

      if (url.pathname === "/internal/limit") {
        const value = v.parse(
          v.strictObject({ userId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
          body,
        );

        const allowed = await (await userObject(env, value.userId)).take("commits");

        return Response.json({ allowed });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      const status =
        error instanceof SyncError
          ? error.status
          : v.isValiError(error) || error instanceof SyntaxError
            ? 400
            : 503;

      return Response.json({ error: "Sync request could not be completed." }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
