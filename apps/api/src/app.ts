import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import { authService, type AuthEnv, type AuthProvider } from "./auth";
import { billingService, type BillingProvider } from "./billing";
import { billingConfig } from "./config";
import type { Config } from "./config";
import type { Database } from "./db/client";
import { fileService, parseSnapshot } from "./files";
import { idSchema } from "./ids";
import type { RevisionStorage } from "./storage";

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

  const origins = new Set([
    new URL(config.WEB_URL).origin,
    new URL(config.API_URL).origin,
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);

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

    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !(c.req.method === "POST" && c.req.path === "/api/billing/webhook")) {
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
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/api/billing/webhook", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    await billing.webhook(await c.req.text(), c.req.header());
    return c.json({ received: true });
  });
  app.use("/api/*", async (c, next) => {
    await auth.authenticate(c);
    await next();
  });
  app.get("/api/me", (c) => c.json({ user: c.get("user"), workspace: c.get("workspace") }));
  app.get("/api/billing", async (c) => c.json(await billing.entitlements(c.get("workspace").id)));
  app.post("/api/billing/refresh", async (c) => c.json(await billing.entitlements(c.get("workspace").id, true)));
  app.post("/api/billing/checkout", async (c) => {
    const { seats } = v.parse(v.object({ seats: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), 1) }), await c.req.json());
    return c.json({ url: await billing.checkout(c.get("workspace").id, c.get("user"), seats) });
  });
  app.post("/api/billing/portal", async (c) => c.json({ url: await billing.portal(c.get("workspace").id) }));
  app.get("/api/files", async (c) =>
    c.json({
      files: await files.list(c.get("workspace").id),
      warnings: [],
      workspace: c.get("workspace"),
    }),
  );
  app.post("/api/files", async (c) =>
    c.json(
      await files.write(c.get("workspace").id, c.get("user").id, parseSnapshot(await c.req.json()), undefined, await billing.entitlements(c.get("workspace").id)),
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
      }, await billing.entitlements(c.get("workspace").id)),
      body,
    );

    return c.json(
      await files.write(c.get("workspace").id, c.get("user").id, parseSnapshot(body), {
        id: v.parse(idSchema, c.req.param("id")),
        ...version,
      }),
    );
  });
  app.post("/api/files/:id/archive", async (c) => {
    const { archived } = v.parse(v.object({ archived: v.boolean() }), await c.req.json());
    await files.archive(c.get("workspace").id, v.parse(idSchema, c.req.param("id")), archived);

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

  return { app, auth, billing };
}
