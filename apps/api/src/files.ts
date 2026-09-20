import { randomUUID } from "node:crypto";

import { CanvasDocument, type CanvasFrame } from "@flies/canvas/document";
import { EMPTY_THEME, type CanvasTheme } from "@flies/canvas/theme";
import { and, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import type { Database } from "./db/client";
import { files, revisions, users, workspaces } from "./db/schema";
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
export type Identity = { id: string; email: string; name: string };

export async function ensureWorkspace(db: Database, user: Identity) {
  return db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values(user)
      .onConflictDoUpdate({ target: users.id, set: { email: user.email, name: user.name } });
    await tx
      .insert(workspaces)
      .values({ ownerId: user.id, name: "My workspace" })
      .onConflictDoNothing({ target: workspaces.ownerId });
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.ownerId, user.id));

    return workspace;
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

  return nodes
    .filter((node) => !node.hidden)
    .slice(0, 80)
    .map((node) =>
      Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => fields.has(key))
          .map(([key, value]) => [key, key === "text" ? String(value).slice(0, 160) : value]),
      ),
    );
}

function notFound(): never {
  throw new HTTPException(404, { message: "File not found." });
}

const scope = (workspaceId: string, id: string) =>
  and(eq(files.workspaceId, workspaceId), eq(files.id, id));

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

      return storage.get(row.objectKey);
    },
    async write(
      workspaceId: string,
      userId: string,
      snapshot: Snapshot,
      existing?: { id: string; revision: number; mutationId: string },
    ) {
      const id = existing?.id ?? randomUUID();
      const revisionId = existing?.mutationId ?? randomUUID();

      return db.transaction(async (tx) => {
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

          if (prior) return storage.get(prior.objectKey);
          if (row.revision !== existing.revision)
            throw new HTTPException(409, {
              message:
                "This file changed in another session. Reopen it before saving; your current edits are still in this tab.",
            });
          createdAt = row.createdAt;
          number = row.revision + 1;
        }

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

        const objectKey = `${prefix}/${workspaceId}/${id}/${number}-${randomUUID()}.json.gz`;
        // Publish S3 first. A failed DB commit can only leave an unreferenced object,
        // never a DB pointer to a missing revision. Old objects are never overwritten.
        const metadata = await storage.put(objectKey, document);

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

        return document;
      });
    },
    async archive(workspaceId: string, id: string, archived: boolean) {
      const rows = await db
        .update(files)
        .set({ archived })
        .where(scope(workspaceId, id))
        .returning({ id: files.id });

      if (!rows.length) notFound();
    },
    async history(workspaceId: string, id: string) {
      const [file] = await db.select({ id: files.id }).from(files).where(scope(workspaceId, id));
      if (!file) notFound();

      return db
        .select({
          id: revisions.id,
          revision: revisions.number,
          createdAt: revisions.createdAt,
          byteLength: revisions.byteLength,
        })
        .from(revisions)
        .where(eq(revisions.fileId, id))
        .orderBy(desc(revisions.number));
    },
  };
}
