import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import { authService, type AuthEnv, type AuthProvider } from "./auth";
import { billingService, type BillingProvider } from "./billing";
import { billingConfig, realtimeConfig } from "./config";
import type { Config } from "./config";
import type { Database } from "./db/client";
import { latestDesktopDownload } from "./desktop-downloads";
import { fileService, parseSnapshot } from "./files";
import { idSchema } from "./ids";
import { mfaService } from "./mfa";
import { SyncRedis } from "./realtime/redis";
import { createRealtime } from "./realtime/server";
import type { RevisionStorage } from "./storage";
import { teamService } from "./teams";

export const MAX_BODY = 100 * 1024 * 1024;
export const BILLING_MAX_BODY = 350 * 1024 * 1024;

export function createApp(
  db: Database,
  storage: RevisionStorage,
  config: Config,
  provider: AuthProvider,
  billingProvider?: BillingProvider,
) {
  const app = new Hono<AuthEnv>();
  const auth = authService(db, config, provider);
  const files = fileService(db, storage, config.S3_PREFIX);
  const billing = billingService(db, config, billingProvider);
  const teams = teamService(db, billing, provider);
  const mfa = mfaService(provider);

  const origins = new Set([
    new URL(config.WEB_URL).origin,
    new URL(config.API_URL).origin,
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);

  const syncConfig = realtimeConfig(config);

  const realtime = syncConfig
    ? createRealtime({
        db,
        auth,
        teams,
        files,
        billing,
        origins,
        requireTLS: new URL(config.API_URL).protocol === "https:",
        redis: new SyncRedis(syncConfig.url, syncConfig.key),
      })
    : null;

  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");

    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !(c.req.method === "POST" && c.req.path === "/api/billing/webhook")
    ) {
      const origin = c.req.header("Origin");
      if ((origin && !origins.has(origin)) || (!origin && !c.req.header("Authorization")))
        throw new HTTPException(403, { message: "Request origin is not allowed." });
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        throw new HTTPException(415, { message: "Use application/json." });
    }

    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: billingConfig(config) ? BILLING_MAX_BODY : MAX_BODY,
      onError: (c) => c.json({ error: "Request body is too large." }, 413),
    }),
  );
  app.route("/auth", auth.routes);
  app.get("/downloads/desktop/:target", async (c) => {
    try {
      const url = await latestDesktopDownload(c.req.param("target"));
      if (!url) return c.redirect("https://github.com/lassejlv/flies/releases/latest");

      return c.redirect(url);
    } catch {
      return c.redirect("https://github.com/lassejlv/flies/releases/latest");
    }
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/api/billing/webhook", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    await billing.webhook(await c.req.text(), c.req.header());

    return c.json({ received: true });
  });
  app.use("/api/*", async (c, next) => {
    await auth.authenticate(c);
    const selected = c.get("selectedWorkspaceId");

    if (selected && selected !== c.get("workspace").id) {
      const workspace = await teams.access(selected, c.get("user").id);

      if (workspace) c.set("workspace", workspace);
      else if (c.req.path === "/api/me") {
        await teams.switch(c.get("workspace").id, c.get("user").id, c.get("sessionHash"));
      } else if (
        !["/api/me", "/api/workspaces", "/api/workspaces/switch"].includes(c.req.path) &&
        !c.req.path.startsWith("/api/account/") &&
        !c.req.path.endsWith("/accept")
      ) {
        throw new HTTPException(403, {
          message: "Workspace access is unavailable. Switch to another workspace.",
        });
      }
    }

    await next();
  });
  app.post("/api/sync/ticket", async (c) => {
    if (!realtime) return c.json({ enabled: false });
    const { fileId } = v.parse(v.object({ fileId: idSchema }), await c.req.json());

    return c.json(
      await realtime.ticket(
        fileId,
        c.get("workspace").id,
        c.get("user"),
        c.get("sessionHash"),
        c.req.header("Origin") ?? "",
      ),
    );
  });
  app.post("/api/files/:id/changes", async (c) => {
    if (!realtime) throw new HTTPException(503, { message: "Realtime is not configured." });

    return c.json(
      await realtime.change(
        v.parse(idSchema, c.req.param("id")),
        c.get("workspace").id,
        c.get("user"),
        c.get("sessionHash"),
        await c.req.json(),
      ),
    );
  });
  app.get("/api/me", (c) => c.json({ user: c.get("user"), workspace: c.get("workspace") }));
  app.get("/api/account/mfa", async (c) => c.json(await mfa.status(c.get("user").id)));
  app.post("/api/account/mfa", async (c) => {
    await c.req.json();

    return c.json(await mfa.enroll(c.get("user")), 201);
  });
  app.post("/api/account/mfa/verify", async (c) =>
    c.json(await mfa.verify(c.get("user").id, await c.req.json())),
  );
  app.post("/api/account/mfa/remove", async (c) =>
    c.json(await mfa.remove(c.get("user").id, await c.req.json())),
  );
  app.get("/api/billing", async (c) => c.json(await billing.entitlements(c.get("workspace").id)));
  app.post("/api/billing/refresh", async (c) =>
    c.json(await billing.entitlements(c.get("workspace").id, true)),
  );
  app.post("/api/billing/checkout", async (c) => {
    await teams.owner(c.get("workspace").id, c.get("user").id);

    const { seats } = v.parse(
      v.object({
        seats: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), 1),
      }),
      await c.req.json(),
    );

    return c.json({ url: await billing.checkout(c.get("workspace").id, c.get("user"), seats) });
  });
  app.post("/api/billing/portal", async (c) => {
    await teams.owner(c.get("workspace").id, c.get("user").id);

    return c.json({ url: await billing.portal(c.get("workspace").id) });
  });
  app.get("/api/workspaces", async (c) => c.json(await teams.list(c.get("user"))));
  app.post("/api/workspaces/switch", async (c) => {
    const { id } = v.parse(v.object({ id: idSchema }), await c.req.json());

    return c.json(await teams.switch(id, c.get("user").id, c.get("sessionHash")));
  });
  app.get("/api/workspaces/members", async (c) =>
    c.json(await teams.details(c.get("workspace").id, c.get("user").id)),
  );
  app.post("/api/workspaces/invitations", async (c) => {
    const { email } = v.parse(
      v.object({
        email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(254)),
      }),
      await c.req.json(),
    );

    return c.json(await teams.invite(c.get("workspace").id, c.get("user"), email), 201);
  });
  app.post("/api/workspaces/invitations/:id/accept", async (c) =>
    c.json(await teams.accept(v.parse(idSchema, c.req.param("id")), c.get("user"))),
  );
  app.post("/api/workspaces/invitations/:id/revoke", async (c) => {
    await teams.revoke(
      c.get("workspace").id,
      c.get("user").id,
      v.parse(idSchema, c.req.param("id")),
    );

    return c.json({ revoked: true });
  });
  app.post("/api/workspaces/members/remove", async (c) => {
    const { userId } = v.parse(
      v.object({ userId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)) }),
      await c.req.json(),
    );

    await teams.remove(c.get("workspace").id, c.get("user").id, userId);

    return c.json({ removed: true });
  });
  // This endpoint accounts for local desktop calls. Future public MCP handlers
  // must call consumeMcp(workspaceId, true) directly before dispatching a tool.
  app.post("/api/billing/mcp/consume", async (c) =>
    c.json(await billing.consumeMcp(c.get("workspace").id, false)),
  );
  app.get("/api/files", async (c) =>
    c.json({
      files: await files.list(c.get("workspace").id),
      warnings: [],
      workspace: c.get("workspace"),
    }),
  );
  app.post("/api/files", async (c) =>
    c.json(
      await files.write(
        c.get("workspace").id,
        c.get("user").id,
        parseSnapshot(await c.req.json()),
        undefined,
        await billing.entitlements(c.get("workspace").id),
      ),
      201,
    ),
  );
  app.get("/api/files/:id", async (c) =>
    c.json(await files.read(c.get("workspace").id, v.parse(idSchema, c.req.param("id")))),
  );
  app.get("/api/files/:id/revisions", async (c) =>
    c.json(await files.history(c.get("workspace").id, v.parse(idSchema, c.req.param("id")))),
  );
  app.post("/api/files/:id/revisions", async (c) => {
    const body = await c.req.json();

    const version = v.parse(
      v.object({
        revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
        mutationId: idSchema,
      }),
      body,
    );

    return c.json(
      await files.write(
        c.get("workspace").id,
        c.get("user").id,
        parseSnapshot(body),
        {
          id: v.parse(idSchema, c.req.param("id")),
          ...version,
        },
        await billing.entitlements(c.get("workspace").id),
      ),
    );
  });
  app.post("/api/files/:id/archive", async (c) => {
    const { archived } = v.parse(v.object({ archived: v.boolean() }), await c.req.json());
    await files.archive(
      c.get("workspace").id,
      v.parse(idSchema, c.req.param("id")),
      archived,
      archived ? undefined : await billing.entitlements(c.get("workspace").id),
    );

    return c.json({ archived });
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json({ error: "Invalid request." }, 400);
    // Do not log request bodies, session cookies, database URLs, or SDK errors with credentials.
    console.error("API request failed", c.req.method, c.req.path, error.name);

    return c.json({ error: "Could not complete the request. Please retry." }, 500);
  });

  return { app, auth, billing, realtime };
}
