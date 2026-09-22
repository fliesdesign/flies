import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";

import { createApp } from "../src/app";
import type { AuthProvider } from "../src/auth";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/db/client";
import { files, revisions, sessions, users, workspaceMembers, workspaces } from "../src/db/schema";
import { memoryRevisionStorage } from "./revision-storage";

if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL)
  throw new Error("Use the isolated TEST_DATABASE_URL.");

const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const syncPort = portProbe.port!;
await portProbe.stop(true);

const config = {
  ...readConfig(),
  API_URL: "http://127.0.0.1:3221",
  WEB_URL: "http://127.0.0.1:1423",
  SYNC_SERVER_URL: `http://127.0.0.1:${syncPort}`,
  SYNC_SERVER_SECRET: randomBytes(32).toString("hex"),
  POLAR_ACCESS_TOKEN: undefined,
  POLAR_WEBHOOK_SECRET: undefined,
  POLAR_PRO_PRODUCT_ID: undefined,
  POLAR_ORGANIZATION_ID: undefined,
  POLAR_SERVER: undefined,
};

const { db, client } = connectDatabase(config.DATABASE_URL);

const people = ["Owner", "Member", "Outsider"].map((name) => ({
  id: `sync_test_${ulid()}`,
  name,
  email: `${ulid()}@example.invalid`,
  emailVerified: true,
}));

const provider: AuthProvider = {
  async ensureOrganization(workspace) {
    return `org_sync_${workspace.id}`;
  },
  authorizationUrl: () => "https://example.invalid",
  async exchange() {
    throw new Error("unused");
  },
  async verify(id) {
    const user = people.find((person) => person.id === id);

    return user ? { user, sealedSession: id } : null;
  },
  async revoke() {},
  async listFactors() {
    return [];
  },
  async enrollFactor() {
    throw new Error("unused");
  },
  async verifyEnrollment() {
    return false;
  },
  async deleteFactor() {},
};

const { storage } = memoryRevisionStorage();

const replicas = [
  createApp(db, storage, config, provider),
  createApp(db, storage, config, provider),
];

const servers = replicas.map((replica, index) =>
  Bun.serve({
    port: process.env.SYNC_BROWSER_URL && index === 0 ? 3221 : 0,
    hostname: "127.0.0.1",
    fetch: replica.app.fetch,
  }),
);

const workerState = mkdtempSync(join(tmpdir(), "flies-sync-test-"));

const worker = Bun.spawn(
  [
    "node",
    "apps/sync/node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "apps/sync/wrangler.jsonc",
    "--persist-to",
    workerState,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(syncPort),
    "--var",
    `API_URL:${servers[0].url.origin}`,
    "--var",
    `WEB_URL:${config.WEB_URL}`,
    "--var",
    `SYNC_SERVER_SECRET:${config.SYNC_SERVER_SECRET}`,
  ],
  { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
);

// Drain output without exposing development bindings in test logs.
const workerOutput = new Response(worker.stdout).text();
const workerErrors = new Response(worker.stderr).text();

let tokens: string[];
let fileId: string;
let workspaceId: string;
const sockets: WebSocket[] = [];

// Bun supports headers alongside protocols; DOM types loaded by Playwright omit this overload.
const NativeSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

const call = (replica: number, user: number, path: string, body?: unknown) =>
  fetch(new URL(path, servers[replica].url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${tokens[user]}`,
      Origin: config.WEB_URL,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function watch(socket: WebSocket) {
  const messages: Record<string, any>[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const listener of listeners) listener();
  });

  return {
    socket,
    messages,
    wait(predicate: (message: Record<string, any>) => boolean) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<Record<string, any>>((resolve, reject) => {
        const check = () => {
          const value = messages.find(predicate);

          if (value) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(value);
          }
        };

        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error("Timed out waiting for sync message: " + JSON.stringify(messages)));
        }, 10000);

        listeners.add(check);
      });
    },
  };
}

async function connect(replica: number, user: number) {
  const response = await call(replica, user, "/api/sync/ticket", { fileId });
  expect(response.status).toBe(200);
  const { ticket, socketUrl } = (await response.json()) as { ticket: string; socketUrl: string };

  const socket = new NativeSocket(socketUrl.replace("http:", "ws:"), {
    protocols: ["flies-sync-v1", `ticket.${ticket}`],
    headers: { Origin: config.WEB_URL },
  });

  sockets.push(socket);
  const watched = watch(socket);
  await watched.wait((message) => message.type === "ready");

  return { ...watched, ticket };
}

beforeAll(async () => {
  let ready = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      ready = (await fetch(`${config.SYNC_SERVER_URL}/health`)).ok;
    } catch {
      /* Still starting. */
    }

    if (ready) break;
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }

  if (!ready) throw new Error("Cloudflare local sync runtime did not start.");
  tokens = await Promise.all(
    people.map((person) => replicas[0].auth.createSession(person, person.id)),
  );
  const account = (await (await call(0, 0, "/api/me")).json()) as { workspace: { id: string } };
  workspaceId = account.workspace.id;
  await db.insert(workspaceMembers).values({ id: ulid(), workspaceId, userId: people[1].id });
  expect((await call(1, 1, "/api/workspaces/switch", { id: workspaceId })).status).toBe(200);

  const response = await call(0, 0, "/api/files", {
    name: "Private sync design",
    nodes: [
      {
        id: "box",
        kind: "rectangle",
        name: "Box",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        fill: "#ffffff",
      },
    ],
  });

  fileId = ((await response.json()) as { id: string }).id;
}, 30_000);
afterAll(async () => {
  for (const socket of sockets) socket.close();
  worker.kill();
  await worker.exited;
  await Promise.all([workerOutput, workerErrors]);
  rmSync(workerState, { recursive: true, force: true });
  await Promise.all(servers.map((server) => server.stop(true)));
  const ids = people.map((person) => person.id);
  const owned = await db.select().from(workspaces).where(inArray(workspaces.ownerId, ids));

  const fileRows = await db
    .select()
    .from(files)
    .where(
      inArray(
        files.workspaceId,
        owned.map((workspace) => workspace.id),
      ),
    );

  if (fileRows.length)
    await db.delete(revisions).where(
      inArray(
        revisions.fileId,
        fileRows.map((file) => file.id),
      ),
    );
  await db.delete(files).where(
    inArray(
      files.workspaceId,
      owned.map((workspace) => workspace.id),
    ),
  );
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db.delete(workspaces).where(inArray(workspaces.ownerId, ids));
  await db.delete(users).where(inArray(users.id, ids));
  await client.close();
}, 30_000);

test("Cloudflare Durable Objects relay presence and durable concurrent edits across Bun replicas", async () => {
  expect((await call(0, 2, "/api/sync/ticket", { fileId })).status).toBe(404);
  expect((await call(0, 0, "/internal/sync/authorize", {})).status).toBe(401);
  expect((await call(0, 0, "/internal/sync/commit", {})).status).toBe(401);
  const first = await connect(0, 0);
  const second = await connect(1, 1);
  second.socket.send(
    JSON.stringify({
      type: "presence",
      presence: { cursor: { x: 122, y: 94 }, selection: ["box"], activity: "editing" },
    }),
  );

  const presence = await first.wait(
    (message) =>
      message.type === "presence" &&
      message.peer.userId === people[1].id &&
      message.peer.cursor?.x === 122,
  );

  expect(presence.peer.name).toBe("Member");
  second.socket.send(
    JSON.stringify({
      type: "presence",
      presence: { userId: people[0].id, cursor: null, selection: [], activity: "viewing" },
    }),
  );
  expect((await second.wait((message) => message.type === "error")).code).toBe(400);

  const moves = {
    mutationId: ulid(),
    delta: { nodes: [{ id: "box", set: { x: 240 } }], tokens: [] },
  };

  const colors = {
    mutationId: ulid(),
    delta: { nodes: [{ id: "box", set: { fill: "#ff0000" } }], tokens: [] },
  };

  first.socket.send(JSON.stringify({ type: "commit", change: moves }));
  second.socket.send(JSON.stringify({ type: "commit", change: colors }));
  await Promise.all([
    first.wait((message) => message.type === "ack" && message.mutationId === moves.mutationId),
    second.wait((message) => message.type === "ack" && message.mutationId === colors.mutationId),
  ]);
  await first.wait((message) => message.type === "changed" && message.revision === 2);

  const result = (await (await call(0, 0, `/api/files/${fileId}`)).json()) as {
    nodes: unknown[];
    revision: number;
  };

  expect(result.nodes[0]).toMatchObject({ x: 240, fill: "#ff0000" });
  expect(result.revision).toBe(2);
  // Replaying after a dropped acknowledgement does not apply twice.
  expect((await call(1, 1, `/api/files/${fileId}/changes`, colors)).status).toBe(200);
  expect(
    ((await (await call(0, 0, `/api/files/${fileId}`)).json()) as { revision: number }).revision,
  ).toBe(2);

  const replay = new NativeSocket(
    `${config.SYNC_SERVER_URL.replace("http:", "ws:")}/api/sync/socket`,
    {
      protocols: ["flies-sync-v1", `ticket.${first.ticket}`],
      headers: { Origin: config.WEB_URL },
    },
  );

  await new Promise<void>((resolve, reject) => {
    replay.addEventListener("error", () => resolve(), { once: true });
    replay.addEventListener("open", () => reject(new Error("Ticket replay accepted")), {
      once: true,
    });
  });
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, people[1].id));

  const revoked = {
    mutationId: ulid(),
    delta: { nodes: [{ id: "box", set: { x: 999 } }], tokens: [] },
  };

  second.socket.send(JSON.stringify({ type: "commit", change: revoked }));
  expect(
    (
      await second.wait(
        (message) => message.type === "error" && message.mutationId === revoked.mutationId,
      )
    ).code,
  ).toBe(403);
  expect(
    ((await (await call(0, 0, `/api/files/${fileId}`)).json()) as { nodes: { x: number }[] })
      .nodes[0].x,
  ).toBe(240);
  first.socket.close();
}, 60_000);

test.skipIf(!process.env.SYNC_BROWSER_URL)(
  "two browsers share cursors, edits, undo, and reconnect without losing offline changes",
  async () => {
    const { chromium, expect: browserExpect } = await import("@playwright/test");
    await db.insert(workspaceMembers).values({ id: ulid(), workspaceId, userId: people[1].id });

    const browser = await chromium.launch({
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });

    const contexts = await Promise.all(
      [0, 1].map(async (index) => {
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        await context.addCookies([
          {
            name: "flies_session",
            value: tokens[index],
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);

        return context;
      }),
    );

    try {
      const pages = await Promise.all(contexts.map((context) => context.newPage()));

      for (const page of pages) {
        page.on("pageerror", (error) => console.error("Browser error:", error.message));
        page.on("response", (response) => {
          if (response.status() >= 400 && response.url().includes("/api/"))
            console.error("API response:", new URL(response.url()).pathname, response.status());
        });
      }

      await Promise.all(
        pages.map((page) => page.goto(`${process.env.SYNC_BROWSER_URL}/files/${fileId}`)),
      );
      await Promise.all(
        pages.map((page) =>
          browserExpect(page.locator(".canvas-presence")).toBeAttached({
            timeout: 20000,
          }),
        ),
      );
      await pages[0].mouse.move(650, 350);
      await browserExpect(pages[1].locator('[data-peer-name="Owner"]')).toBeVisible({
        timeout: 20000,
      });
      await pages[0].getByRole("treeitem", { name: "Box", exact: true }).click();
      await pages[1].getByRole("treeitem", { name: "Box", exact: true }).click();
      const x1 = pages[0].getByLabel("X position", { exact: true });
      const x2 = pages[1].getByLabel("X position", { exact: true });
      await x1.fill("320");
      await x1.press("Enter");
      await browserExpect(x2).toHaveValue("320", { timeout: 15000 });
      await contexts[1].setOffline(true);
      await x2.fill("410");
      await x2.press("Enter");
      await contexts[1].setOffline(false);
      await browserExpect(x1).toHaveValue("410", { timeout: 30000 });
      await pages[1].locator(".canvas-surface").focus();
      await pages[1].keyboard.press("Meta+z");
      await browserExpect(x1).toHaveValue("320", { timeout: 15000 });
      await pages[1].keyboard.press("Meta+Shift+z");
      await browserExpect(x1).toHaveValue("410", { timeout: 15000 });
      await browserExpect(pages[0].locator(".workspace-tabs")).toHaveCount(0);
      await browserExpect(pages[1].locator(".workspace-tabs")).toHaveCount(0);

      const durable = (await (await call(0, 0, `/api/files/${fileId}`)).json()) as {
        nodes: { x: number }[];
      };

      expect(durable.nodes[0].x).toBe(410);
    } finally {
      await browser.close();
    }
  },
  90_000,
);
