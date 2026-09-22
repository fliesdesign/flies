import { sql } from "drizzle-orm";

import type { Database } from "./db/client";
import { files, revisions, revisionObjects, revisionObjectRefs } from "./db/schema";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function lockRevisionFile(tx: Transaction, fileId: string, wait = true) {
  const key = `flies:revision:${fileId}`;

  if (wait) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

    return true;
  }

  const [row] = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked`,
  );

  return row.locked;
}

// Include the legacy revision/current pointers as well as new shared-asset refs.
export const unreferencedObject = sql`
  not exists (select 1 from ${revisionObjectRefs} where ${revisionObjectRefs.objectKey} = ${revisionObjects.key})
  and not exists (select 1 from ${revisions} where ${revisions.objectKey} = ${revisionObjects.key})
  and not exists (select 1 from ${files} where ${files.objectKey} = ${revisionObjects.key})
`;
