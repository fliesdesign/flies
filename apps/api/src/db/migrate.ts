import { runMigrations } from "./migrations";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
await runMigrations(url);
console.log("Database migrations applied.");
