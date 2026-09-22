import { randomUUID } from "node:crypto";

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import type { authService } from "../auth";
import type { billingService } from "../billing";
import type { Database } from "../db/client";
import { files as fileTable } from "../db/schema";
import type { fileService, Identity } from "../files";
import type { teamService } from "../teams";
import { commitSchema, presenceSchema, type Commit, type Peer } from "./protocol";
import { SyncRedis } from "./redis";

type Ticket = {
  fileId: string;
  workspaceId: string;
  sessionHash: string;
  user: Identity;
  origin: string;
  expires: number;
};
type Connection = Ticket & {
  id: string;
  room: string;
  validUntil: number;
  pending: boolean;
  writing: boolean;
  window: number;
  messages: number;
  peer: Peer;
  ready: boolean;
};
type Socket = ServerWebSocket<Connection>;
type Room = { sockets: Set<Socket>; ready: Promise<() => Promise<void>> };
const colors = ["#4c9aff", "#b18cff", "#ff9770", "#54c7a0", "#e78fcb", "#e1b34b"];
export const SYNC_MESSAGE_BYTES = 512 * 1024;

function send(ws: Socket, value: unknown) {
  if (ws.data.validUntil <= Date.now()) return;
  const result = ws.send(JSON.stringify(value));
  if (result === -1 || ws.getBufferedAmount() > 1_048_576)
    ws.close(1013, "Connection is too slow. Reconnect.");
}

export function createRealtime({
  db,
  auth,
  teams,
  files,
  billing,
  redis,
  origins,
  requireTLS = false,
}: {
  db: Database;
  auth: ReturnType<typeof authService>;
  teams: ReturnType<typeof teamService>;
  files: ReturnType<typeof fileService>;
  billing: ReturnType<typeof billingService>;
  redis: SyncRedis;
  origins: Set<string>;
  requireTLS?: boolean;
}) {
  const rooms = new Map<string, Room>();
  let stopped = false;

  redis.onDisconnect = () => {
    for (const room of rooms.values())
      for (const ws of room.sockets) ws.close(1012, "Sync service reconnecting.");
  };

  let maintaining = false;

  async function authorize(ticket: Ticket) {
    const session = await auth.validateSession(ticket.sessionHash);
    if (!session || session.user.id !== ticket.user.id)
      throw new HTTPException(401, { message: "Sign in again to reconnect." });
    if (!(await teams.access(ticket.workspaceId, session.user.id)))
      throw new HTTPException(403, { message: "Workspace access was removed." });

    const [file] = await db
      .select({ id: fileTable.id, revision: fileTable.revision })
      .from(fileTable)
      .where(
        and(
          eq(fileTable.id, ticket.fileId),
          eq(fileTable.workspaceId, ticket.workspaceId),
          eq(fileTable.archived, false),
        ),
      );

    if (!file) throw new HTTPException(404, { message: "This file is no longer available." });

    return { file, user: session.user };
  }

  async function changed(workspaceId: string, fileId: string, revision: number) {
    await redis.publish(redis.room(workspaceId, fileId), {
      type: "changed",
      revision,
      at: Date.now(),
    });
  }

  async function commit(ticket: Ticket, input: Commit) {
    await authorize(ticket);
    if (!(await redis.rateLimit(ticket.user.id, "commits", 120, 60)))
      throw new HTTPException(429, { message: "Too many edits. Please retry in a moment." });

    const result = (await files.write(
      ticket.workspaceId,
      ticket.user.id,
      { name: "", nodes: [], theme: { tokens: [] } },
      {
        id: ticket.fileId,
        revision: -1,
        mutationId: input.mutationId,
        delta: input.delta,
      },
      await billing.entitlements(ticket.workspaceId),
    )) as { revision: number };

    // A publish failure must not report a durable write as lost. Every connection
    // reconciles the authoritative revision during its next authorization heartbeat.
    await changed(ticket.workspaceId, ticket.fileId, result.revision).catch(() => {});

    return { revision: result.revision, mutationId: input.mutationId };
  }

  async function open(ws: Socket) {
    try {
      const authorized = await authorize(ws.data);
      if (stopped || ws.readyState !== 1) return;
      ws.data.validUntil = Date.now() + 25_000;
      let room = rooms.get(ws.data.room);

      if (!room) {
        const sockets = new Set<Socket>();
        room = {
          sockets,
          ready: redis.subscribe(ws.data.room, (event) => {
            if (!event || typeof event !== "object") return;
            const value = event as { at?: number; type?: string };
            if (!value.at || Math.abs(Date.now() - value.at) > 30_000) return;
            for (const target of sockets) if (target.data.ready) send(target, value);
          }),
        };
        rooms.set(ws.data.room, room);
      }

      room.sockets.add(ws);
      await room.ready;
      if (ws.readyState !== 1) return;
      const peers = await redis.peers<Peer>(ws.data.room);
      ws.data.ready = true;
      send(ws, {
        type: "ready",
        connectionId: ws.data.id,
        userId: ws.data.user.id,
        revision: authorized.file.revision,
        peers: peers.filter((peer) => Date.now() - peer.updatedAt < 25_000),
      });
      await presence(ws);
    } catch {
      ws.close(1011, "Could not join. Reconnect.");
    }
  }

  async function presence(ws: Socket) {
    ws.data.peer.updatedAt = Date.now();
    await redis.presence(ws.data.room, ws.data.id, ws.data.peer);
    await redis.publish(ws.data.room, { type: "presence", peer: ws.data.peer, at: Date.now() });
  }

  async function close(ws: Socket) {
    const room = rooms.get(ws.data.room);
    room?.sockets.delete(ws);

    if (room && room.sockets.size === 0) {
      rooms.delete(ws.data.room);
      await room.ready.then((unsubscribe) => unsubscribe()).catch(() => {});
    }

    await redis.release(ws.data.user.id, ws.data.id).catch(() => {});
    await redis.leave(ws.data.room, ws.data.id).catch(() => {});
    await redis
      .publish(ws.data.room, { type: "leave", connectionId: ws.data.id, at: Date.now() })
      .catch(() => {});
  }

  async function message(ws: Socket, payload: string | Buffer) {
    if (!ws.data.ready || ws.data.validUntil <= Date.now()) {
      ws.close(4001, "Reconnect to verify access.");

      return;
    }

    if (typeof payload !== "string") {
      ws.close(1003, "Use JSON messages.");

      return;
    }

    const now = Date.now();

    if (now - ws.data.window > 1000) {
      ws.data.window = now;
      ws.data.messages = 0;
    }

    if (++ws.data.messages > 40) {
      ws.close(1008, "Message rate exceeded.");

      return;
    }

    let mutationId: string | undefined;

    try {
      const input = JSON.parse(payload);

      if (input.type === "presence") {
        const next = v.parse(presenceSchema, input.presence);
        ws.data.peer = { ...ws.data.peer, ...next };
        if (ws.data.pending) return;
        ws.data.pending = true;

        try {
          await presence(ws);
        } finally {
          ws.data.pending = false;
        }

        return;
      }

      if (input.type !== "commit")
        throw new HTTPException(400, { message: "Unknown sync message." });
      const change = v.parse(commitSchema, input.change);
      mutationId = change.mutationId;

      // One in-flight commit per socket; callers preserve the same mutation ID on retry.
      if (ws.data.writing) {
        send(ws, {
          type: "error",
          mutationId,
          code: 429,
          error: "Connection is busy. Retry this change.",
        });

        return;
      }

      ws.data.writing = true;

      try {
        send(ws, { type: "ack", ...(await commit(ws.data, change)) });
      } finally {
        ws.data.writing = false;
      }
    } catch (error) {
      const code =
        error instanceof HTTPException
          ? error.status
          : v.isValiError(error) || error instanceof SyntaxError
            ? 400
            : 503;

      send(ws, {
        type: "error",
        mutationId,
        code,
        error:
          error instanceof HTTPException ? error.message : "Could not sync this change. Retry.",
      });
      if ([401, 403, 404].includes(code)) ws.close(4003, "Access is no longer available.");
    }
  }

  const timer = setInterval(() => {
    if (maintaining || stopped) return;
    maintaining = true;
    void Promise.all(
      [...rooms.values()]
        .flatMap((room) => Array.from(room.sockets))
        .map(async (ws) => {
          try {
            const authorized = await authorize(ws.data);
            if (!(await redis.lease(ws.data.user.id, ws.data.id)))
              throw new Error("Connection limit exceeded");
            if (ws.readyState !== 1) return;
            ws.data.validUntil = Date.now() + 25_000;
            send(ws, { type: "changed", revision: authorized.file.revision, at: Date.now() });
            await presence(ws);
          } catch {
            ws.close(4003, "Access could not be verified. Reconnect.");
          }
        }),
    ).finally(() => {
      maintaining = false;
    });
  }, 10_000);

  timer.unref();

  const websocket: WebSocketHandler<Connection> = {
    data: {} as Connection,
    open,
    message,
    close,
    maxPayloadLength: SYNC_MESSAGE_BYTES,
    backpressureLimit: 1_048_576,
    closeOnBackpressureLimit: true,
    idleTimeout: 40,
    sendPings: true,
    perMessageDeflate: false,
  };

  return {
    websocket,
    changed,
    async ticket(
      fileId: string,
      workspaceId: string,
      user: Identity,
      sessionHash: string,
      origin: string,
    ) {
      if (!origins.has(origin)) throw new HTTPException(403);

      const ticket: Ticket = {
        fileId,
        workspaceId,
        user,
        sessionHash,
        origin,
        expires: Date.now() + 30_000,
      };

      await authorize(ticket);
      if (!(await redis.rateLimit(user.id, "tickets", 60, 60))) throw new HTTPException(429);

      return { enabled: true, ticket: await redis.ticket(ticket) };
    },
    async change(
      fileId: string,
      workspaceId: string,
      user: Identity,
      sessionHash: string,
      input: unknown,
    ) {
      return commit(
        { fileId, workspaceId, user, sessionHash, origin: "", expires: 0 },
        v.parse(commitSchema, input),
      );
    },
    async upgrade(request: Request, server: Server<Connection>) {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (
        requireTLS &&
        new URL(request.url).protocol !== "https:" &&
        request.headers.get("x-forwarded-proto") !== "https"
      )
        return new Response("Encrypted connection required", { status: 426 });
      const origin = request.headers.get("origin") ?? "";
      if (!origins.has(origin) || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("Forbidden", { status: 403 });

      // Bearer/session credentials never go in URLs or Redis keys. Only this
      // single-use 30-second ticket is supplied in the WebSocket subprotocol.
      const protocols =
        request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((item) => item.trim()) ?? [];

      const credential = protocols.find((item) => item.startsWith("ticket."))?.slice(7);
      if (
        !protocols.includes("flies-sync-v1") ||
        !credential ||
        !/^[A-Za-z0-9_-]{43}$/.test(credential)
      )
        return new Response("Unauthorized", { status: 401 });

      try {
        const ticket = await redis.consume<Ticket>(credential);
        if (!ticket || ticket.expires < Date.now() || ticket.origin !== origin)
          return new Response("Unauthorized", { status: 401 });
        await authorize(ticket);
        const id = randomUUID();
        if (!(await redis.lease(ticket.user.id, id)))
          return new Response("Too many connections", { status: 429 });

        const hue =
          [...ticket.user.id].reduce((total, char) => total + char.charCodeAt(0), 0) %
          colors.length;

        const data: Connection = {
          ...ticket,
          id,
          room: redis.room(ticket.workspaceId, ticket.fileId),
          validUntil: Date.now() + 25_000,
          pending: false,
          writing: false,
          window: Date.now(),
          messages: 0,
          ready: false,
          peer: {
            connectionId: id,
            userId: ticket.user.id,
            name: ticket.user.name.slice(0, 100),
            color: colors[hue],
            cursor: null,
            selection: [],
            activity: "viewing",
            updatedAt: Date.now(),
          },
        };

        if (
          server.upgrade(request, { data, headers: { "Sec-WebSocket-Protocol": "flies-sync-v1" } })
        )
          return undefined;
        await redis.release(ticket.user.id, id);

        return new Response("Upgrade failed", { status: 400 });
      } catch {
        return new Response("Realtime unavailable", { status: 503 });
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const room of rooms.values())
        for (const ws of room.sockets) ws.close(1001, "Server restarting.");
      await redis.close();
    },
  };
}
