import { createApp, MAX_BODY, BILLING_MAX_BODY } from "./app";
import { workosProvider } from "./auth";
import { readConfig, billingConfig } from "./config";
import { connectDatabase } from "./db/client";
import { createStorage } from "./storage";
const config = readConfig();
const { db } = connectDatabase(config.DATABASE_URL);
const { app, realtime } = createApp(db, createStorage(config), config, workosProvider(config));

const server = Bun.serve({
  port: config.PORT,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/api/sync/socket")
      return realtime
        ? realtime.upgrade(request, bunServer)
        : new Response("Realtime is not configured", { status: 503 });

    return app.fetch(request, bunServer);
  },
  websocket: realtime?.websocket ?? { message() {} },
  maxRequestBodySize: billingConfig(config) ? BILLING_MAX_BODY : MAX_BODY,
});

async function shutdown() {
  await realtime?.stop();
  await server.stop();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
