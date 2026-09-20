import { migrate } from "drizzle-orm/bun-sql/migrator";

import { connectDatabase } from "./client";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, client } = connectDatabase(url);

try {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  console.log("Database migrations applied.");
} finally {
  await client.close();
}
