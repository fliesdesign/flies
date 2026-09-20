import { eq, isNull } from "drizzle-orm";

import { workosProvider } from "../auth";
import { readConfig } from "../config";
import { ensureWorkspace } from "../files";
import { connectDatabase } from "./client";
import { users, workspaces } from "./schema";

const config = readConfig();
const { db, client } = connectDatabase(config.DATABASE_URL);
const provider = workosProvider(config);

try {
  const pending = await db
    .select({ user: users })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerId))
    .where(isNull(workspaces.workosOrganizationId));

  for (const { user } of pending) {
    // eslint-disable-next-line no-await-in-loop
    const workspace = await ensureWorkspace(db, user, provider);
    console.log(`Linked workspace ${workspace.id} to ${workspace.workosOrganizationId}`);
  }

  console.log(`Backfilled ${pending.length} workspace organizations.`);
} finally {
  await client.close();
}
