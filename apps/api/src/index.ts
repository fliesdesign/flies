import { createApp, MAX_BODY } from "./app";
import { workosProvider } from "./auth";
import { readConfig } from "./config";
import { connectDatabase } from "./db/client";
import { createStorage } from "./storage";
const config = readConfig();
const { db } = connectDatabase(config.DATABASE_URL);
const { app } = createApp(db, createStorage(config), config, workosProvider(config));
export default { port: config.PORT, fetch: app.fetch, maxRequestBodySize: MAX_BODY };
