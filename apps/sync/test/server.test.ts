import type { SyncGrant } from "@flies/sync";
import {
  env,
  SELF,
  reset,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env as WorkerEnv, SyncRoom } from "../src";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
const origin = "https://app.example.com";
const base = "https://sync.example.com";
const sockets: WebSocket[] = [];

const grant = (): SyncGrant => ({
  fileId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionHash: "a".repeat(64),
  user: { id: crypto.randomUUID(), name: "Alice" },
  origin,
});

const post = (path: string, body: unknown, secret = env.SYNC_SERVER_SECRET) =>
  SELF.fetch(base + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const responses: { path: string; status: number; body: unknown }[] = [];

const authorize = (status = 200, revision = 0) =>
  responses.push({ path: "/internal/sync/authorize", status, body: { revision } });

async function ticket(access: SyncGrant) {
  const response = await post("/internal/ticket", access);
  expect(response.status).toBe(200);

  return (await response.json<{ ticket: string }>()).ticket;
}

async function upgrade(token: string, requestOrigin = origin) {
  return SELF.fetch(base + "/api/sync/socket", {
    headers: {
      Upgrade: "websocket",
      Origin: requestOrigin,
      "Sec-WebSocket-Protocol": `flies-sync-v1, ticket.${token}`,
    },
  });
}

function watch(socket: WebSocket) {
  const messages: Record<string, any>[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const waiter of waiters) waiter();
  });

  return {
    messages,
    wait(predicate: (event: Record<string, any>) => boolean): Promise<Record<string, any>> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const check = () => {
          const found = messages.find(predicate);

          if (found) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(found);
          }
        };

        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("No sync message"));
        }, 3000);

        waiters.add(check);
      });
    },
  };
}

async function connect(access: SyncGrant) {
  const token = await ticket(access);
  authorize();
  const response = await upgrade(token);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.push(socket);
  const watched = watch(socket);
  socket.accept();
  const ready = await watched.wait((message) => message.type === "ready");

  return { ...watched, token, socket, ready };
}

beforeEach(() => {
  responses.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${env.SYNC_SERVER_SECRET}`);
    const response = responses.shift();
    if (!response || new URL(request.url).pathname !== response.path)
      throw new Error("Unexpected API callback");

    return Response.json(response.body, { status: response.status });
  });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
  vi.restoreAllMocks();
});

describe("Cloudflare sync server", () => {
  it("requires the service secret and checks browser origins and single-use tickets", async () => {
    const access = grant();
    expect((await post("/internal/ticket", access, "wrong")).status).toBe(401);
    const token = await ticket(access);
    expect((await upgrade(token, "https://attacker.example")).status).toBe(403);
    authorize();
    const attempts = await Promise.all([upgrade(token), upgrade(token)]);
    expect(attempts.map((response) => response.status).toSorted()).toEqual([101, 401]);
    const connected = attempts.find((response) => response.status === 101)!;
    connected.webSocket!.accept();
    sockets.push(connected.webSocket!);
    expect((await upgrade(token)).status).toBe(401);
    const old = await ticket(access);
    const room = env.SYNC_ROOMS.getByName(old.split(".")[0]);
    await runInDurableObject(room, (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE tickets SET expires = 0");
    });
    expect((await upgrade(old)).status).toBe(401);
  });

  it("isolates rooms, broadcasts validated presence, and acknowledges only durable commits", async () => {
    const access = grant();
    const first = await connect(access);
    const second = await connect({ ...access, user: { id: crypto.randomUUID(), name: "Bob" } });
    const other = await connect(grant());
    second.socket.send(
      JSON.stringify({
        type: "presence",
        presence: { cursor: { x: 10, y: 20 }, selection: ["box"], activity: "editing" },
      }),
    );
    expect(
      (await first.wait((event) => event.type === "presence" && event.peer.cursor?.x === 10)).peer
        .name,
    ).toBe("Bob");
    expect(other.messages.some((event) => event.peer?.name === "Bob")).toBe(false);
    second.socket.send(
      JSON.stringify({
        type: "presence",
        presence: { cursor: null, selection: [], activity: "viewing", userId: access.user.id },
      }),
    );
    expect((await second.wait((event) => event.type === "error")).code).toBe(400);
    const mutationId = crypto.randomUUID();
    responses.push({
      path: "/internal/sync/commit",
      status: 200,
      body: { revision: 1, mutationId },
    });
    first.socket.send(
      JSON.stringify({ type: "commit", change: { mutationId, delta: { nodes: [], tokens: [] } } }),
    );
    expect((await first.wait((event) => event.type === "ack")).revision).toBe(1);
    expect((await second.wait((event) => event.type === "changed")).revision).toBe(1);
    expect(responses).toHaveLength(0);
  });

  it("fails closed when access is revoked and reconciles HTTP changes", async () => {
    const access = grant();
    const client = await connect(access);
    expect(
      (
        await post("/internal/changed", {
          workspaceId: access.workspaceId,
          fileId: access.fileId,
          revision: 7,
        })
      ).status,
    ).toBe(200);
    expect((await client.wait((event) => event.type === "changed")).revision).toBe(7);

    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );

    authorize(403);
    await runDurableObjectAlarm(env.SYNC_ROOMS.getByName(client.token.split(".")[0]));
    expect(await closed).toBe(4003);
  });

  it("keeps presence and connection state in SQLite with small hibernation attachments", async () => {
    const client = await connect(grant());
    const selection = Array.from({ length: 100 }, (_, i) => String(i).padEnd(100, "x"));
    client.socket.send(
      JSON.stringify({
        type: "presence",
        presence: { cursor: null, selection, activity: "editing" },
      }),
    );
    await client.wait((event) => event.peer?.selection?.length === 100);
    const room = env.SYNC_ROOMS.getByName(client.token.split(".")[0]);
    await runInDurableObject(room, (_instance: SyncRoom, ctx) => {
      const attachment = ctx.getWebSockets()[0].deserializeAttachment();
      expect(Object.keys(attachment)).toEqual(["id"]);

      const stored = ctx.storage.sql
        .exec<{ peer_json: string }>("SELECT peer_json FROM connections")
        .one();

      expect(JSON.parse(stored.peer_json).selection).toHaveLength(100);
    });
    await evictDurableObject(room);
    client.socket.send(
      JSON.stringify({
        type: "presence",
        presence: { cursor: { x: 77, y: 88 }, selection, activity: "editing" },
      }),
    );
    const resumed = await client.wait((event) => event.peer?.cursor?.x === 77);
    expect(resumed.peer.connectionId).toBe(client.ready.connectionId);
    expect(resumed.peer.selection).toHaveLength(100);
  });

  it("does not acknowledge failed writes and rejects expired leases and oversized messages", async () => {
    const client = await connect(grant());
    const mutationId = crypto.randomUUID();
    responses.push({ path: "/internal/sync/commit", status: 503, body: { error: "unavailable" } });
    client.socket.send(
      JSON.stringify({ type: "commit", change: { mutationId, delta: { nodes: [], tokens: [] } } }),
    );
    expect(
      (await client.wait((event) => event.type === "error" && event.mutationId === mutationId))
        .code,
    ).toBe(503);
    expect(client.messages.some((event) => event.type === "ack")).toBe(false);
    const room = env.SYNC_ROOMS.getByName(client.token.split(".")[0]);
    await runInDurableObject(room, (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE connections SET valid_until = 0");
    });

    const expired = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );

    client.socket.send(
      JSON.stringify({
        type: "presence",
        presence: { cursor: null, selection: [], activity: "viewing" },
      }),
    );
    expect(await expired).toBe(4001);
    const large = await connect(grant());

    const oversized = new Promise<number>((resolve) =>
      large.socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );

    large.socket.send("x".repeat(512 * 1024 + 1));
    expect(await oversized).toBe(1009);
  });

  it("enforces socket message rates and removes empty room state", async () => {
    const client = await connect(grant());

    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );

    for (let count = 0; count < 41; count++)
      client.socket.send(
        JSON.stringify({
          type: "presence",
          presence: { cursor: null, selection: [], activity: "viewing" },
        }),
      );
    expect(await closed).toBe(1008);
    const room = env.SYNC_ROOMS.getByName(client.token.split(".")[0]);
    await runDurableObjectAlarm(room);
    await runInDurableObject(room, async (_instance, ctx) => {
      expect(
        ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM connections").one()
          .count,
      ).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("enforces per-user quotas across rooms and expires abandoned leases", async () => {
    const user = env.SYNC_USERS.getByName(crypto.randomUUID());
    const leases = await Promise.all(Array.from({ length: 13 }, (_, i) => user.lease(String(i))));
    expect(leases.filter(Boolean)).toHaveLength(12);
    await user.release(String(leases.indexOf(true)));
    expect(await user.lease("replacement")).toBe(true);
    await runInDurableObject(user, (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE leases SET expires = 0");
    });
    await runDurableObjectAlarm(user);
    expect(await user.lease("after-expiry")).toBe(true);
    const limits = await Promise.all(Array.from({ length: 61 }, () => user.take("tickets")));
    expect(limits.filter(Boolean)).toHaveLength(60);
  });
});
