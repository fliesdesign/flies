import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import type { Entitlements } from "./billing";
import type { Database } from "./db/client";
import { files, revisions, revisionObjects, revisionUploads, workspaceBilling } from "./db/schema";
import { lockRevisionFile, unreferencedObject } from "./revision-objects";
import {
  CLEANUP_INTERVAL_MS,
  FREE_RETENTION_MS,
  OBJECT_DELETE_GRACE_MS,
  PRO_RETENTION_MS,
  revisionRetention,
} from "./revision-policy";
import type { RevisionStorage } from "./storage";

type Options = {
  db: Database;
  storage: RevisionStorage;
  prefix: string;
  billingEnabled: boolean;
  entitlements(workspaceId: string): Promise<Entitlements>;
  onError?(error: unknown): void;
};

export function revisionCleanup({
  db,
  storage,
  prefix,
  billingEnabled,
  entitlements,
  onError = console.error,
}: Options) {
  let fileCursor = "";
  const ownsKey = (key: string) => key.startsWith(`${prefix}/`);

  async function runOnce(now = Date.now()) {
    const result = { revisions: 0, objects: 0, bytes: 0, uploads: 0, errors: 0, backlog: false };

    const reportError = (error: unknown) => {
      result.errors++;
      onError(error);
    };

    const proCutoff = new Date(now - PRO_RETENTION_MS);
    const freeCutoff = new Date(now - FREE_RETENTION_MS);

    // A webhook-invalidated or expired subscription is refreshed before deletion.
    const cutoff = billingEnabled
      ? sql`case when ${workspaceBilling.proUntil} > ${new Date(now)} and ${workspaceBilling.checkedAt} > ${new Date(0)} then ${proCutoff}::timestamptz else ${freeCutoff}::timestamptz end`
      : sql`${proCutoff}::timestamptz`;

    const candidates = await db
      .selectDistinct({ id: files.id, workspaceId: files.workspaceId })
      .from(revisions)
      .innerJoin(files, eq(revisions.fileId, files.id))
      .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, files.workspaceId))
      .where(
        and(
          sql`starts_with(${files.objectKey}, ${`${prefix}/`})`,
          gt(files.id, fileCursor),
          ne(revisions.objectKey, files.objectKey),
          lte(revisions.createdAt, cutoff),
        ),
      )
      .orderBy(asc(files.id))
      .limit(20);

    fileCursor = candidates.length === 20 ? candidates.at(-1)!.id : "";
    result.backlog = candidates.length === 20;
    const access = new Map<string, Entitlements>();

    for (const candidate of candidates) {
      try {
        if (!access.has(candidate.workspaceId))
          // eslint-disable-next-line no-await-in-loop
          access.set(candidate.workspaceId, await entitlements(candidate.workspaceId));
        const expires = new Date(now - revisionRetention(access.get(candidate.workspaceId)!));

        // eslint-disable-next-line no-await-in-loop
        result.revisions += await db.transaction(async (tx) => {
          if (!(await lockRevisionFile(tx, candidate.id, false))) return 0;

          const [file] = await tx
            .select()
            .from(files)
            .where(eq(files.id, candidate.id))
            .for("update");

          if (!file || !ownsKey(file.objectKey)) return 0;

          const expired = await tx
            .select()
            .from(revisions)
            .where(
              and(
                eq(revisions.fileId, file.id),
                ne(revisions.objectKey, file.objectKey),
                lte(revisions.createdAt, expires),
              ),
            )
            .orderBy(asc(revisions.createdAt))
            .limit(100);

          if (!expired.length) return 0;
          if (expired.length === 100) result.backlog = true;
          const ids = expired.map((revision) => revision.id);
          // Older revisions have no object registry. Queue them in the same
          // transaction that removes their metadata, so a failure cannot leak them.
          await tx
            .insert(revisionObjects)
            .values(
              expired.map((revision) => ({
                key: revision.objectKey,
                fileId: file.id,
                byteLength: revision.byteLength,
              })),
            )
            .onConflictDoNothing();
          await tx.delete(revisions).where(inArray(revisions.id, ids));
          await tx
            .update(revisionObjects)
            .set({ deleteAfter: new Date(now + OBJECT_DELETE_GRACE_MS) })
            .where(
              and(
                eq(revisionObjects.fileId, file.id),
                isNull(revisionObjects.deleteAfter),
                unreferencedObject,
              ),
            );

          return expired.length;
        });
      } catch (error) {
        reportError(error);
      }
    }

    // Reconcile only directories with interrupted saves. Pagination is durable;
    // successful saves require no bucket listing, even with millions of files.
    const uploads = await db
      .select()
      .from(revisionUploads)
      .where(
        and(
          sql`starts_with(${revisionUploads.prefix}, ${`${prefix}/`})`,
          lte(revisionUploads.createdAt, freeCutoff),
        ),
      )
      .orderBy(asc(revisionUploads.createdAt))
      .limit(4);

    if (uploads.length === 4) result.backlog = true;

    for (const upload of uploads) {
      if (!upload.prefix.startsWith(`${prefix}/`)) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        result.uploads += await db.transaction(async (tx) => {
          if (!(await lockRevisionFile(tx, upload.fileId, false))) return 0;

          const [current] = await tx
            .select()
            .from(revisionUploads)
            .where(eq(revisionUploads.id, upload.id))
            .for("update");

          if (!current) return 0;
          const page = await storage.list(current.prefix, current.cursor ?? undefined);
          const objects = page.objects.filter((object) => object.key.startsWith(current.prefix));

          if (objects.length) {
            await tx
              .insert(revisionObjects)
              .values(
                objects.map((object) => ({
                  key: object.key,
                  byteLength: object.byteLength,
                  fileId: upload.fileId,
                  deleteAfter: new Date(now + OBJECT_DELETE_GRACE_MS),
                })),
              )
              .onConflictDoNothing();
          }

          if (page.truncated) {
            result.backlog = true;
            const cursor = page.objects.at(-1)?.key;
            if (!cursor || cursor === current.cursor)
              throw new Error("Revision storage listing did not advance.");
            await tx
              .update(revisionUploads)
              .set({ cursor })
              .where(eq(revisionUploads.id, upload.id));
          } else await tx.delete(revisionUploads).where(eq(revisionUploads.id, upload.id));

          return 1;
        });
      } catch (error) {
        reportError(error);
      }
    }

    const objects = await db
      .select()
      .from(revisionObjects)
      .where(
        and(
          sql`starts_with(${revisionObjects.key}, ${`${prefix}/`})`,
          lte(revisionObjects.deleteAfter, new Date(now)),
          unreferencedObject,
        ),
      )
      .orderBy(asc(revisionObjects.deleteAfter))
      .limit(100);

    if (objects.length === 100) result.backlog = true;
    const groups = new Map<string, string[]>();

    for (const object of objects) {
      if (!ownsKey(object.key)) continue;
      const keys = groups.get(object.fileId) ?? [];
      keys.push(object.key);
      groups.set(object.fileId, keys);
    }

    const batches = [...groups];

    for (let offset = 0; offset < batches.length; offset += 2) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        batches.slice(offset, offset + 2).map(async ([fileId, keys]) => {
          try {
            const deleted = await db.transaction(async (tx) => {
              if (!(await lockRevisionFile(tx, fileId, false))) return [];

              const pending = await tx
                .select()
                .from(revisionObjects)
                .where(
                  and(
                    inArray(revisionObjects.key, keys),
                    lte(revisionObjects.deleteAfter, new Date(now)),
                    unreferencedObject,
                  ),
                )
                .for("update");

              const removed: typeof pending = [];

              for (let start = 0; start < pending.length; start += 4) {
                // eslint-disable-next-line no-await-in-loop
                const outcomes = await Promise.allSettled(
                  pending.slice(start, start + 4).map(async (object) => {
                    await storage.delete(object.key);

                    return object;
                  }),
                );

                for (const outcome of outcomes) {
                  if (outcome.status === "fulfilled") removed.push(outcome.value);
                  else reportError(outcome.reason);
                }
              }

              if (removed.length)
                await tx.delete(revisionObjects).where(
                  inArray(
                    revisionObjects.key,
                    removed.map((object) => object.key),
                  ),
                );

              // Back off failures so a broken key cannot starve the rest of the queue.
              const removedKeys = new Set(removed.map((object) => object.key));

              const failedKeys = pending
                .filter((object) => !removedKeys.has(object.key))
                .map((object) => object.key);

              if (failedKeys.length)
                await tx
                  .update(revisionObjects)
                  .set({ deleteAfter: new Date(now + CLEANUP_INTERVAL_MS) })
                  .where(inArray(revisionObjects.key, failedKeys));

              return removed;
            });

            result.objects += deleted.length;
            result.bytes += deleted.reduce((sum, object) => sum + object.byteLength, 0);
          } catch (error) {
            reportError(error);
          }
        }),
      );
    }

    return result;
  }

  return { runOnce };
}

export function startRevisionCleanup(cleanup: ReturnType<typeof revisionCleanup>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;

  const run = async () => {
    let delay = CLEANUP_INTERVAL_MS;

    try {
      const result = await cleanup.runOnce();
      if (result.backlog && result.errors === 0) delay = 1000;
      if (result.revisions || result.objects || result.uploads || result.errors)
        console.info("Revision cleanup", result);
    } catch (error) {
      console.error("Revision cleanup failed; will retry", error);
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          running = run();
        }, delay);
    }
  };

  running = run();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
