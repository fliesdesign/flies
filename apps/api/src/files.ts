import { CanvasDocument, type CanvasFrame } from "@flies/canvas/document";
import { applyDocumentDelta, type DocumentDelta } from "@flies/canvas/sync";
import { EMPTY_THEME, type CanvasTheme } from "@flies/canvas/theme";
import { and, count, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ulid } from "ulid";
import * as v from "valibot";

import { assertImageLimits, BILLING_DISABLED, type Entitlements } from "./billing";
import type { Database } from "./db/client";
import {
  files,
  revisions,
  revisionObjects,
  revisionObjectRefs,
  revisionUploads,
  users,
  workspaces,
} from "./db/schema";
import type { OrganizationProvider } from "./organizations";
import { lockRevisionFile } from "./revision-objects";
import { assertFreshMutation, revisionRetention } from "./revision-policy";
import { prepareRevision, readRevision } from "./revision-snapshot";
import type { RevisionStorage } from "./storage";

const snapshotSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  nodes: v.pipe(v.array(v.unknown()), v.maxLength(50_000)),
  theme: v.optional(v.unknown()),
});

export function parseSnapshot(input: unknown) {
  const value = v.parse(snapshotSchema, input);

  try {
    const document = new CanvasDocument(
      value.nodes as CanvasFrame[],
      (value.theme ?? EMPTY_THEME) as CanvasTheme,
    );

    return { name: value.name, nodes: document.getCommittedFrames(), theme: document.getTheme() };
  } catch {
    throw new HTTPException(400, { message: "Invalid layers, theme, or frame hierarchy." });
  }
}

export type Snapshot = ReturnType<typeof parseSnapshot>;
export type Identity = { id: string; email: string; name: string; emailVerified?: boolean };

export async function ensureWorkspace(
  db: Database,
  user: Identity,
  provider: OrganizationProvider,
) {
  const workspace = await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values(user)
      .onConflictDoUpdate({ target: users.id, set: { email: user.email, name: user.name } });
    await tx
      .insert(workspaces)
      .values({ id: ulid(), ownerId: user.id, name: "My workspace" })
      .onConflictDoNothing({ target: workspaces.ownerId });
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.ownerId, user.id));

    return row;
  });

  if (workspace.workosOrganizationId) return workspace;

  // Serialize provisioning across API instances without rolling back the workspace ID.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
      .for("update");

    if (locked.workosOrganizationId) return locked;
    const workosOrganizationId = await provider.ensureOrganization(locked, user);

    const [linked] = await tx
      .update(workspaces)
      .set({ workosOrganizationId })
      .where(eq(workspaces.id, locked.id))
      .returning();

    return linked;
  });
}

function preview(nodes: CanvasFrame[]) {
  const fields = new Set([
    "id",
    "parentId",
    "kind",
    "x",
    "y",
    "width",
    "height",
    "fill",
    "color",
    "fontSize",
    "fontWeight",
    "fontFamily",
    "textAlign",
    "fontStyle",
    "cornerRadius",
    "opacity",
    "clipContent",
    "text",
  ]);

  return (
    nodes
      // Pages hold no geometry, so they would only consume thumbnail slots.
      .filter((node) => !node.hidden && node.kind !== "page")
      .slice(0, 80)
      .map((node) =>
        Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => fields.has(key))
            .map(([key, value]) => [key, key === "text" ? String(value).slice(0, 160) : value]),
        ),
      )
  );
}

function notFound(): never {
  throw new HTTPException(404, { message: "File not found." });
}

const scope = (workspaceId: string, id: string) =>
  and(eq(files.workspaceId, workspaceId), eq(files.id, id));

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function assertFileCapacity(
  tx: Transaction,
  workspaceId: string,
  entitlements: Entitlements,
) {
  if (!entitlements.enabled || entitlements.limits.designFiles === null) return;

  const [usage] = await tx
    .select({ total: count() })
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.archived, false)));

  if (usage.total >= entitlements.limits.designFiles)
    throw new HTTPException(403, {
      message: `Your ${entitlements.plan} plan allows ${entitlements.limits.designFiles} active design files. Archive a file to free up space.`,
    });
}

export function fileService(db: Database, storage: RevisionStorage, prefix: string) {
  return {
    async list(workspaceId: string) {
      const rows = await db
        .select()
        .from(files)
        .where(eq(files.workspaceId, workspaceId))
        .orderBy(desc(files.updatedAt));

      return rows.map((file) => ({
        id: file.id,
        name: file.name,
        archived: file.archived,
        nodeCount: file.nodeCount,
        preview: file.preview,
        createdAt: file.createdAt.getTime(),
        updatedAt: file.updatedAt.getTime(),
      }));
    },
    async read(workspaceId: string, id: string) {
      const [row] = await db
        .select()
        .from(files)
        .where(and(scope(workspaceId, id), eq(files.archived, false)));

      if (!row) notFound();

      return readRevision(storage, row.objectKey);
    },
    async write(
      workspaceId: string,
      userId: string,
      snapshot: Snapshot,
      existing?: { id: string; revision: number; mutationId: string; delta?: DocumentDelta },
      entitlements: Entitlements = BILLING_DISABLED,
    ) {
      const id = existing?.id ?? ulid();
      const revisionId = existing?.mutationId ?? ulid();
      const uploadId = ulid();
      const directory = `${prefix}/${workspaceId}/${id}/`;
      let uploadStarted = false;

      // This commits before the save transaction, so even a killed process leaves
      // a durable record of the directory that may contain abandoned uploads.
      await db.insert(revisionUploads).values({ id: uploadId, fileId: id, prefix: directory });

      return db
        .transaction(async (tx) => {
          await lockRevisionFile(tx, id);

          const [upload] = await tx
            .select()
            .from(revisionUploads)
            .where(eq(revisionUploads.id, uploadId));

          if (!upload) throw new Error("Upload reservation expired. Retry the save.");

          if (!existing && entitlements.enabled) {
            await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");

            await assertFileCapacity(tx, workspaceId, entitlements);
          }

          let createdAt = new Date();
          let number = 0;

          if (existing) {
            const [row] = await tx
              .select()
              .from(files)
              .where(and(scope(workspaceId, id), eq(files.archived, false)))
              .for("update");

            if (!row) notFound();

            // A retried request after a lost response returns its original revision.
            const [prior] = await tx
              .select()
              .from(revisions)
              .where(and(eq(revisions.id, revisionId), eq(revisions.fileId, id)));

            if (prior) {
              await tx.delete(revisionUploads).where(eq(revisionUploads.id, uploadId));

              return readRevision(storage, prior.objectKey);
            }

            assertFreshMutation(revisionId, entitlements);
            if (!existing.delta && row.revision !== existing.revision)
              throw new HTTPException(409, {
                message:
                  "This file changed in another session. Reopen it before saving; your current edits are still in this tab.",
              });

            if (existing.delta) {
              const current = parseSnapshot(await readRevision(storage, row.objectKey));
              snapshot = parseSnapshot(applyDocumentDelta(current, existing.delta));
            }

            createdAt = row.createdAt;
            number = row.revision + 1;
          }

          assertImageLimits(snapshot, entitlements);
          const updatedAt = new Date();

          const document = {
            format: "flies",
            version: 1,
            id,
            workspaceId,
            revision: number,
            createdAt: createdAt.getTime(),
            updatedAt: updatedAt.getTime(),
            ...snapshot,
          };

          const objectKey = `${directory}${number}-${uploadId}.json.gz`;
          const { snapshot: storedSnapshot, assets } = prepareRevision(objectKey, document);
          const assetKeys = [...assets.keys()];

          const known = assetKeys.length
            ? await tx
                .select({ key: revisionObjects.key })
                .from(revisionObjects)
                .where(
                  and(inArray(revisionObjects.key, assetKeys), isNull(revisionObjects.deleteAfter)),
                )
            : [];

          const knownKeys = new Set(known.map((object) => object.key));
          const missing = [...assets].filter(([key]) => !knownKeys.has(key));

          for (let offset = 0; offset < missing.length; offset += 4) {
            // eslint-disable-next-line no-await-in-loop
            const outcomes = await Promise.allSettled(
              missing.slice(offset, offset + 4).map(async ([key, source]) => {
                uploadStarted = true;
                const metadata = await storage.put(key, source);

                return { key, fileId: id, byteLength: metadata.byteLength };
              }),
            );

            const uploaded = outcomes.map((outcome) => {
              if (outcome.status === "rejected") throw outcome.reason;

              return outcome.value;
            });

            // eslint-disable-next-line no-await-in-loop
            await tx
              .insert(revisionObjects)
              .values(uploaded)
              .onConflictDoUpdate({ target: revisionObjects.key, set: { deleteAfter: null } });
          }

          // Publish S3 first. A failed DB commit can only leave an unreferenced object,
          // never a DB pointer to a missing revision. Old objects are never overwritten.
          uploadStarted = true;
          const metadata = await storage.put(objectKey, storedSnapshot);
          await tx
            .insert(revisionObjects)
            .values({ key: objectKey, fileId: id, byteLength: metadata.byteLength });

          const values = {
            name: snapshot.name,
            revision: number,
            objectKey,
            nodeCount: snapshot.nodes.length,
            preview: preview(snapshot.nodes),
            updatedAt,
          };

          if (existing) await tx.update(files).set(values).where(scope(workspaceId, id));
          else await tx.insert(files).values({ id, workspaceId, createdAt, ...values });
          await tx.insert(revisions).values({
            id: revisionId,
            fileId: id,
            number,
            objectKey,
            ...metadata,
            createdBy: userId,
          });
          const objectKeys = [objectKey, ...assetKeys];

          for (let offset = 0; offset < objectKeys.length; offset += 1000) {
            // eslint-disable-next-line no-await-in-loop
            await tx
              .insert(revisionObjectRefs)
              .values(
                objectKeys
                  .slice(offset, offset + 1000)
                  .map((key) => ({ revisionId, objectKey: key })),
              );
          }

          await tx
            .update(revisionObjects)
            .set({ deleteAfter: null })
            .where(inArray(revisionObjects.key, objectKeys));
          await tx.delete(revisionUploads).where(eq(revisionUploads.id, uploadId));

          return document;
        })
        .catch(async (error: unknown) => {
          if (!uploadStarted)
            await db
              .delete(revisionUploads)
              .where(eq(revisionUploads.id, uploadId))
              .catch(() => {});
          throw error;
        });
    },
    async archive(
      workspaceId: string,
      id: string,
      archived: boolean,
      entitlements: Entitlements = BILLING_DISABLED,
    ) {
      await db.transaction(async (tx) => {
        // Use the same workspace lock as creation so concurrent restores cannot exceed the limit.
        if (!archived && entitlements.enabled)
          await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");

        const [file] = await tx.select().from(files).where(scope(workspaceId, id)).for("update");
        if (!file) notFound();
        if (file.archived === archived) return;

        if (!archived && entitlements.enabled)
          await assertFileCapacity(tx, workspaceId, entitlements);

        await tx.update(files).set({ archived }).where(scope(workspaceId, id));
      });
    },
    async history(
      workspaceId: string,
      id: string,
      entitlements: Entitlements = BILLING_DISABLED,
      before?: number,
    ) {
      const [file] = await db
        .select({ id: files.id, revision: files.revision })
        .from(files)
        .where(scope(workspaceId, id));

      if (!file) notFound();

      return db
        .select({
          id: revisions.id,
          revision: revisions.number,
          createdAt: revisions.createdAt,
          byteLength: revisions.byteLength,
        })
        .from(revisions)
        .where(
          and(
            eq(revisions.fileId, id),
            or(
              eq(revisions.number, file.revision),
              gt(revisions.createdAt, new Date(Date.now() - revisionRetention(entitlements))),
            ),
            before === undefined ? undefined : lt(revisions.number, before),
          ),
        )
        .orderBy(desc(revisions.number))
        .limit(100);
    },
  };
}
