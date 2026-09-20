import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

export function connectDatabase(connectionString: string) {
  const client = new SQL(connectionString, { max: 8, idleTimeout: 30, connectionTimeout: 15 });

  return { db: drizzle({ client, schema }), client };
}

export type Database = ReturnType<typeof connectDatabase>["db"];
