import { createApp, MAX_BODY, BILLING_MAX_BODY } from "./app";
import { workosProvider } from "./auth";
import { billingService } from "./billing";
import { readConfig, billingConfig } from "./config";
import { connectDatabase } from "./db/client";
import { revisionCleanup, startRevisionCleanup } from "./revision-cleanup";
import { createStorage } from "./storage";
const config = readConfig();
const { db, client } = connectDatabase(config.DATABASE_URL);
const storage = createStorage(config);
const { app } = createApp(db, storage, config, workosProvider(config));
const billing = billingService(db, config);

const stopCleanup = startRevisionCleanup(
  revisionCleanup({
    db,
    storage,
    prefix: config.S3_PREFIX,
    billingEnabled: Boolean(billingConfig(config)),
    entitlements: billing.entitlements,
  }),
);

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
  maxRequestBodySize: billingConfig(config) ? BILLING_MAX_BODY : MAX_BODY,
});

async function shutdown() {
  await server.stop();
  await stopCleanup();
  await client.close();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
