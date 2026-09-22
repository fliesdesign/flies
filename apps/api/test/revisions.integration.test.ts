import { afterAll, beforeAll, expect, test } from "bun:test";

import { and, eq, inArray, lt } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { ulid } from "ulid";

import { BILLING_DISABLED, PLANS, type Entitlements } from "../src/billing";
import { connectDatabase } from "../src/db/client";
import {
  revisions,
  revisionObjects,
  revisionObjectRefs,
  revisionUploads,
  users,
  workspaceBilling,
  workspaces,
} from "../src/db/schema";
import { fileService, parseSnapshot } from "../src/files";
import { revisionCleanup } from "../src/revision-cleanup";
import { lockRevisionFile } from "../src/revision-objects";
import {
  FREE_RETENTION_MS,
  OBJECT_DELETE_GRACE_MS,
  PRO_RETENTION_MS,
} from "../src/revision-policy";
import { readRevision } from "../src/revision-snapshot";
import { memoryRevisionStorage } from "./revision-storage";

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.startsWith("/flies_revision_test")
)
  throw new Error(
    "Revision tests require a local flies_revision_test database as both TEST_DATABASE_URL and DATABASE_URL.",
  );
const { db, client } = connectDatabase(url);
const free = { enabled: true, plan: "free", limits: PLANS.free } as const;
const pro = { enabled: true, plan: "pro", limits: PLANS.pro } as const;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
});
afterAll(() => client.close());

const source = "data:image/png;base64,YWJj";

const snapshot = (src = source) =>
  parseSnapshot({
    name: "Design",
    nodes: [
      { id: "image", kind: "image", name: "Image", x: 0, y: 0, width: 100, height: 100, src },
    ],
  });

async function fixture(access: Entitlements = free) {
  const userId = ulid();
  const workspaceId = ulid();
  const prefix = `tests/${ulid()}`;
  await db
    .insert(users)
    .values({ id: userId, name: "Retention test", email: `${userId}@example.test` });
  await db.insert(workspaces).values({ id: workspaceId, ownerId: userId, name: "Retention" });
  const memory = memoryRevisionStorage();
  const service = fileService(db, memory.storage, prefix);
  const errors: unknown[] = [];

  const options = {
    db,
    storage: memory.storage,
    prefix,
    billingEnabled: access.enabled,
    entitlements: async () => access,
    onError: (error: unknown) => {
      errors.push(error);
    },
  };

  const cleanup = revisionCleanup(options);
  type Saved = ReturnType<typeof snapshot> & { id: string; revision: number };
  let current = (await service.write(workspaceId, userId, snapshot(), undefined, access)) as Saved;
  const id = current.id;

  const save = async (src = source, mutationId = ulid()) => {
    current = (await service.write(
      workspaceId,
      userId,
      snapshot(src),
      { id, revision: current.revision, mutationId },
      access,
    )) as Saved;

    return current;
  };

  const age = (number: number, timestamp: number) =>
    db
      .update(revisions)
      .set({ createdAt: new Date(timestamp) })
      .where(and(eq(revisions.fileId, id), eq(revisions.number, number)));

  const history = () =>
    db.select().from(revisions).where(eq(revisions.fileId, id)).orderBy(revisions.number);

  return {
    ...memory,
    service,
    errors,
    options,
    cleanup,
    save,
    age,
    history,
    id,
    userId,
    workspaceId,
    prefix,
    snapshot,
  };
}

test("Free expiry honors its exact boundary and preserves the latest archived snapshot and shared image", async () => {
  const f = await fixture();
  await f.save();
  await f.save();
  await f.save();
  const now = Date.now();
  await f.age(0, now - FREE_RETENTION_MS - 1);
  await f.age(1, now - FREE_RETENTION_MS);
  await f.age(2, now - FREE_RETENTION_MS + 1);
  await f.age(3, 0); // The latest file must survive regardless of age or archive state.
  await f.service.archive(f.workspaceId, f.id, true);
  const first = await f.cleanup.runOnce(now);
  expect(first.revisions).toBe(2);
  expect(first.objects).toBe(0);
  expect((await f.history()).map((r) => r.number)).toEqual([2, 3]);
  expect(await f.service.history(f.workspaceId, f.id, free)).toEqual([
    expect.objectContaining({ revision: 3 }),
  ]);
  await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS);
  expect(f.deletes.some((key) => key.includes("/assets/"))).toBe(false);
  const rows = await f.history();
  expect(await readRevision(f.storage, rows.at(-1)!.objectKey)).toMatchObject({
    id: f.id,
    revision: 3,
    nodes: f.snapshot().nodes,
  });
  expect(f.errors).toEqual([]);
});

test("Pro and billing-disabled installs retain seven days; a downgrade uses one hour", async () => {
  for (const access of [pro, BILLING_DISABLED]) {
    // eslint-disable-next-line no-await-in-loop
    const f = await fixture(access);
    // eslint-disable-next-line no-await-in-loop
    await f.save();
    const now = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await f.age(0, now - PRO_RETENTION_MS + 1);
    // eslint-disable-next-line no-await-in-loop
    expect((await f.cleanup.runOnce(now)).revisions).toBe(0);
    // eslint-disable-next-line no-await-in-loop
    expect((await f.cleanup.runOnce(now + 1)).revisions).toBe(1);
  }

  const f = await fixture(pro);
  await f.save();
  await f.age(0, Date.now() - 2 * FREE_RETENTION_MS);
  expect((await f.cleanup.runOnce()).revisions).toBe(0);
  expect(
    (await revisionCleanup({ ...f.options, entitlements: async () => free }).runOnce()).revisions,
  ).toBe(1);
});

test("failed billing refresh preserves history", async () => {
  const f = await fixture();
  await f.save();
  await f.age(0, 0);

  const result = await revisionCleanup({
    ...f.options,
    entitlements: async () => {
      throw new Error("Billing unavailable");
    },
  }).runOnce();

  expect(result.errors).toBe(1);
  expect(await f.history()).toHaveLength(2);
  expect(f.deletes).toEqual([]);
});

test("cached Pro uses seven days and webhook invalidation refreshes a downgrade before cleanup", async () => {
  const f = await fixture(pro);
  await f.save();
  await f.age(0, Date.now() - 2 * FREE_RETENTION_MS);
  await db.insert(workspaceBilling).values({
    workspaceId: f.workspaceId,
    checkedAt: new Date(),
    proUntil: new Date(Date.now() + PRO_RETENTION_MS),
  });
  let refreshes = 0;

  const cleanup = revisionCleanup({
    ...f.options,
    entitlements: async () => {
      refreshes++;

      return free;
    },
  });

  expect((await cleanup.runOnce()).revisions).toBe(0);
  expect(refreshes).toBe(0);
  await db
    .update(workspaceBilling)
    .set({ checkedAt: new Date(0) })
    .where(eq(workspaceBilling.workspaceId, f.workspaceId));
  expect((await cleanup.runOnce()).revisions).toBe(1);
  expect(refreshes).toBe(1);
});

test("large history is paginated and cleanup signals another bounded batch", async () => {
  const f = await fixture();

  for (let i = 0; i < 105; i++) {
    // eslint-disable-next-line no-await-in-loop
    await f.save();
  }

  const first = await f.service.history(f.workspaceId, f.id, free);
  expect(first).toHaveLength(100);
  expect(await f.service.history(f.workspaceId, f.id, free, first.at(-1)!.revision)).toHaveLength(
    6,
  );
  await db
    .update(revisions)
    .set({ createdAt: new Date(0) })
    .where(eq(revisions.fileId, f.id));
  const now = Date.now();
  expect(await f.cleanup.runOnce(now)).toMatchObject({ revisions: 100, backlog: true });
  expect(await f.cleanup.runOnce(now)).toMatchObject({ revisions: 5 });
  expect(await f.history()).toHaveLength(1);
  expect(await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS)).toMatchObject({
    objects: 100,
    backlog: true,
  });
  expect(await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS)).toMatchObject({ objects: 5 });
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({ revision: 105 });
});

test("shared assets upload once and disappear only after their final retained reference expires", async () => {
  const f = await fixture();
  await f.save();
  await f.save();
  expect(f.writes.filter((key) => key.includes("/assets/"))).toHaveLength(1);
  const oldAsset = f.writes[0];
  await f.save("data:image/png;base64,ZGVm");
  await db
    .update(revisions)
    .set({ createdAt: new Date(0) })
    .where(and(eq(revisions.fileId, f.id), lt(revisions.number, 3)));
  const now = Date.now();
  expect((await f.cleanup.runOnce(now)).revisions).toBe(3);
  expect(f.objects.has(oldAsset)).toBe(true);
  const result = await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS);
  expect(result.objects).toBe(4);
  expect(f.objects.has(oldAsset)).toBe(false);
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({
    revision: 3,
    nodes: f.snapshot("data:image/png;base64,ZGVm").nodes,
  });
});

test("failed deletion is durable across worker restarts and reusing a queued asset repairs a missing blob", async () => {
  const f = await fixture();
  const oldAsset = f.writes[0];
  await f.save("data:image/png;base64,ZGVm");
  await f.age(0, 0);
  const now = Date.now();
  await f.cleanup.runOnce(now);
  f.failures.delete = true;
  expect((await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS)).errors).toBe(2);
  // Simulate S3 succeeding but the DB commit failing: queued metadata still exists.
  f.objects.delete(oldAsset);
  await f.save();
  expect(f.objects.has(oldAsset)).toBe(true);
  f.failures.delete = false;
  await revisionCleanup(f.options).runOnce(now + OBJECT_DELETE_GRACE_MS);
  expect(f.objects.has(oldAsset)).toBe(true);
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({ revision: 2 });
});

test("an uploaded snapshot whose database commit fails is reclaimed after restart", async () => {
  const f = await fixture();
  const other = await fixture();
  const [occupied] = await other.history();
  const before = new Set(f.objects.keys());
  // A global mutation collision fails the revision insert after objects are uploaded.
  await expect(f.save("data:image/png;base64,ZGVm", occupied.id)).rejects.toThrow();
  expect(await f.history()).toHaveLength(1);
  const abandoned = [...f.objects.keys()].filter((key) => !before.has(key));
  expect(abandoned).toHaveLength(2);
  const now = Date.now();
  await db
    .update(revisionUploads)
    .set({ createdAt: new Date(0) })
    .where(eq(revisionUploads.fileId, f.id));
  const restarted = revisionCleanup(f.options);
  expect((await restarted.runOnce(now)).uploads).toBe(1);
  expect((await restarted.runOnce(now + OBJECT_DELETE_GRACE_MS)).objects).toBe(2);
  expect([...f.objects.keys()].toSorted()).toEqual([...before].toSorted());
  expect(f.errors).toEqual([]);
});

test("cleanup skips an in-flight save and concurrent replicas preserve the current file", async () => {
  const f = await fixture();
  await f.save();
  await f.age(0, 0);
  await db.transaction(async (tx) => {
    await lockRevisionFile(tx, f.id);
    expect((await f.cleanup.runOnce()).revisions).toBe(0);
  });
  const now = Date.now();

  const results = await Promise.all([
    f.cleanup.runOnce(now),
    revisionCleanup(f.options).runOnce(now),
  ]);

  expect(results.reduce((sum, result) => sum + result.revisions, 0)).toBe(1);
  await Promise.all([
    f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS),
    revisionCleanup(f.options).runOnce(now + OBJECT_DELETE_GRACE_MS),
  ]);
  expect(f.deletes).toHaveLength(1);
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({ revision: 1 });
  expect(f.errors).toEqual([]);
});

test("legacy snapshots are queued and deleted without an object registry or asset references", async () => {
  const f = await fixture();
  await f.save();
  const [legacy] = await f.history();
  await f.storage.put(legacy.objectKey, { ...f.snapshot(), revision: 0 });
  await db.delete(revisionObjectRefs).where(eq(revisionObjectRefs.revisionId, legacy.id));
  await db.delete(revisionObjects).where(eq(revisionObjects.key, legacy.objectKey));
  await f.age(0, 0);
  const now = Date.now();
  await f.cleanup.runOnce(now);
  await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS);
  expect(f.objects.has(legacy.objectKey)).toBe(false);
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({ revision: 1 });
});

test("failed uploads leave the last save intact and retry the same mutation exactly once", async () => {
  const f = await fixture();
  const mutationId = ulid();
  f.failures.put = true;
  await expect(f.save(undefined, mutationId)).rejects.toThrow("Upload failed");
  expect(await f.history()).toHaveLength(1);
  f.failures.put = false;
  const saved = await f.save(undefined, mutationId);
  const writes = f.writes.length;
  expect(await f.save(undefined, mutationId)).toEqual(saved);
  expect(f.writes).toHaveLength(writes);
  expect(await f.history()).toHaveLength(2);
});

test("history pagination is bounded and a pruned mutation cannot reapply its delta", async () => {
  const f = await fixture();
  await f.save();
  expect(await f.service.history(f.workspaceId, f.id, free, 1)).toEqual([
    expect.objectContaining({ revision: 0 }),
  ]);
  await expect(
    f.service.write(
      f.workspaceId,
      f.userId,
      f.snapshot(),
      {
        id: f.id,
        revision: -1,
        mutationId: ulid(Date.now() - FREE_RETENTION_MS - 1),
        delta: { name: "Duplicate", nodes: [], tokens: [] },
      },
      free,
    ),
  ).rejects.toThrow("expired");
  expect(await f.history()).toHaveLength(2);
});

test("orphan reconciliation is paginated, bounded to its prefix, and resumes after restart", async () => {
  const f = await fixture();
  const prefix = `${f.prefix}/${f.workspaceId}/${f.id}/`;

  const keys = Array.from(
    { length: 105 },
    (_, i) => `${prefix}abandoned-${String(i).padStart(3, "0")}.json.gz`,
  );

  await Promise.all(keys.map((key) => f.storage.put(key, {})));
  await f.storage.put("unrelated/keep.json.gz", {});
  await db
    .insert(revisionUploads)
    .values({ id: ulid(), fileId: f.id, prefix, createdAt: new Date(0) });
  const now = Date.now();
  await f.cleanup.runOnce(now);
  const [pending] = await db.select().from(revisionUploads).where(eq(revisionUploads.fileId, f.id));
  expect(pending.cursor).toBeString();
  await revisionCleanup(f.options).runOnce(now);
  expect(
    await db.select().from(revisionUploads).where(eq(revisionUploads.fileId, f.id)),
  ).toHaveLength(0);
  await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS);
  await f.cleanup.runOnce(now + OBJECT_DELETE_GRACE_MS);
  expect(
    await db.select().from(revisionObjects).where(inArray(revisionObjects.key, keys)),
  ).toHaveLength(0);
  expect(f.objects.has("unrelated/keep.json.gz")).toBe(true);
  expect(await f.service.read(f.workspaceId, f.id)).toMatchObject({ revision: 0 });
});
