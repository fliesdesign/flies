import { describe, expect, test } from "bun:test";

import { ulid } from "ulid";

import { BILLING_DISABLED, PLANS } from "../src/billing";
import type { Config } from "../src/config";
import {
  assertFreshMutation,
  FREE_RETENTION_MS,
  PRO_RETENTION_MS,
  revisionRetention,
} from "../src/revision-policy";
import { prepareRevision, readRevision } from "../src/revision-snapshot";
import { createStorage } from "../src/storage";
import { memoryRevisionStorage } from "./revision-storage";

describe("revision retention", () => {
  const free = { enabled: true, plan: "free", limits: PLANS.free } as const;
  const pro = { enabled: true, plan: "pro", limits: PLANS.pro } as const;

  test("Free keeps one hour; Pro and billing-disabled installs keep seven days", () => {
    expect(revisionRetention(free)).toBe(3_600_000);
    expect(revisionRetention(pro)).toBe(604_800_000);
    expect(revisionRetention(BILLING_DISABLED)).toBe(604_800_000);
  });

  test("expired mutation IDs cannot reapply edits after their history has been deleted", () => {
    const now = Date.now();
    expect(() => assertFreshMutation(ulid(now - FREE_RETENTION_MS), free, now)).toThrow("expired");
    expect(() => assertFreshMutation(ulid(now - FREE_RETENTION_MS + 1), free, now)).not.toThrow();
    expect(() => assertFreshMutation(ulid(now - FREE_RETENTION_MS), pro, now)).not.toThrow();
    expect(() => assertFreshMutation(ulid(now - PRO_RETENTION_MS), pro, now)).toThrow("expired");
    expect(() => assertFreshMutation(ulid(now + 600_000), free, now)).toThrow("expired");
    expect(() => assertFreshMutation(crypto.randomUUID(), free, now)).toThrow("ULID");
  });
});

describe("deduplicated revision snapshots", () => {
  test("Bun S3 storage round-trips gzip objects, lists pages, and deletes idempotently", async () => {
    const objects = new Map<string, ArrayBuffer>();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname).replace(/^\/(?:test-bucket\/?)?/, "");

        if (url.searchParams.has("list-type")) {
          const prefix = url.searchParams.get("prefix") ?? "";
          const after = url.searchParams.get("start-after") ?? "";

          const all = [...objects]
            .filter(([name]) => name.startsWith(prefix) && name > after)
            .toSorted(([a], [b]) => a.localeCompare(b));

          const contents = all
            .slice(0, 1)
            .map(
              ([name, bytes]) =>
                `<Contents><Key>${name}</Key><Size>${bytes.byteLength}</Size></Contents>`,
            )
            .join("");

          return new Response(
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${all.length > 1}</IsTruncated>${contents}</ListBucketResult>`,
            { headers: { "Content-Type": "application/xml" } },
          );
        }

        if (request.method === "PUT") {
          objects.set(key, await request.arrayBuffer());

          return new Response(null);
        }

        if (request.method === "DELETE") {
          objects.delete(key);

          return new Response(null, { status: 204 });
        }

        const bytes = objects.get(key);

        return bytes ? new Response(bytes) : new Response("Missing", { status: 404 });
      },
    });

    const storage = createStorage({
      S3_ENDPOINT: server.url.origin,
      S3_REGION: "auto",
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY_ID: "test",
      S3_SECRET_ACCESS_KEY: "test",
    } as Config);

    try {
      const document = { nodes: [], name: "Round trip" };
      const metadata = await storage.put("revisions/a.json.gz", document);
      await storage.put("revisions/b.json.gz", {});
      expect(metadata.byteLength).toBeGreaterThan(0);
      expect(await storage.get("revisions/a.json.gz")).toEqual(document);
      const first = await storage.list("revisions/");
      expect(first.truncated).toBe(true);
      expect(first.objects).toEqual([
        { key: "revisions/a.json.gz", byteLength: metadata.byteLength },
      ]);
      expect(
        (await storage.list("revisions/", first.objects[0].key)).objects.map(
          (object) => object.key,
        ),
      ).toEqual(["revisions/b.json.gz"]);
      await storage.delete("revisions/a.json.gz");
      await storage.delete("revisions/a.json.gz");
      expect(objects.has("revisions/a.json.gz")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("images are stored once across layers and revisions, with lossless reads", async () => {
    const { storage, objects, writes } = memoryRevisionStorage();
    const source = `data:image/png;base64,${Buffer.from(crypto.getRandomValues(new Uint8Array(60_000))).toString("base64")}`;
    let legacyBytes = 0;

    for (let revision = 0; revision < 20; revision++) {
      const key = `revisions/workspace/file/${revision}.json.gz`;

      const document = {
        revision,
        name: "Images",
        nodes: [
          { id: "one", kind: "image", src: source, x: revision },
          { id: "two", kind: "image", src: source, x: 10 },
          { id: "__proto__", kind: "svg", src: "<svg/>" },
        ],
      };

      const original = JSON.stringify(document);
      const prepared = prepareRevision(key, document);
      expect(prepared.assets.size).toBe(2);
      for (const [asset, uri] of prepared.assets)
        // eslint-disable-next-line no-await-in-loop
        if (!objects.has(asset)) await storage.put(asset, uri);
      // eslint-disable-next-line no-await-in-loop
      await storage.put(key, prepared.snapshot);
      // eslint-disable-next-line no-await-in-loop
      expect(await readRevision(storage, key)).toEqual(document);
      expect(JSON.stringify(document)).toBe(original);
      legacyBytes += Bun.gzipSync(original).length;
    }

    const bytes = [...objects.values()].reduce((sum, object) => sum + object.length, 0);
    expect(writes.filter((key) => key.includes("/assets/"))).toHaveLength(2);
    expect(bytes).toBeLessThan(legacyBytes * 0.1);
  });

  test("legacy full snapshots read unchanged and asset references cannot escape a file", async () => {
    const { storage } = memoryRevisionStorage();
    const key = "revisions/workspace/file/legacy.json.gz";
    const legacy = { format: "flies", nodes: [], revision: 12 };
    await storage.put(key, legacy);
    expect(await readRevision(storage, key)).toEqual(legacy);
    await storage.put(key, {
      format: "flies-storage",
      version: 1,
      document: { nodes: [] },
      assets: { bad: "../../secret" },
    });
    await expect(readRevision(storage, key)).rejects.toThrow("Invalid revision asset hash");
  });
});
