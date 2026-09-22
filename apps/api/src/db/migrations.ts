import { migrate } from "drizzle-orm/bun-sql/migrator";

import { connectDatabase } from "./client";

export function migrationConnectionString(connectionString: string) {
  const url = new URL(connectionString);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");

  return url.toString();
}

/** Serialize replica startup before Drizzle reads its migration journal. */
export async function runMigrations(connectionString: string) {
  const { db, client } = connectDatabase(migrationConnectionString(connectionString));

  try {
    // Keep the transaction-scoped lock on a dedicated connection while Drizzle
    // applies migrations on another connection. The lock is released on failure
    // too; a second replica then reads the newly committed migration journal.
    await client.begin(async (lock) => {
      await lock`select pg_advisory_xact_lock(hashtextextended('flies:database:migrations', 0))`;
      await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    });
  } finally {
    await client.close();
  }
}
