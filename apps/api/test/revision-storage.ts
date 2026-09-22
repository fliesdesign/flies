import type { RevisionStorage } from "../src/storage";

export function memoryRevisionStorage() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const writes: string[] = [];
  const deletes: string[] = [];
  const failures = { put: false, delete: false };

  const storage: RevisionStorage = {
    async put(key, document) {
      writes.push(key);
      if (failures.put) throw new Error("Upload failed");
      const bytes = Bun.gzipSync(JSON.stringify(document));
      objects.set(key, bytes);

      return {
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
      };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`Missing object: ${key}`);

      return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
    },
    async delete(key) {
      if (failures.delete) throw new Error("Delete failed");
      deletes.push(key);
      objects.delete(key);
    },
    async list(prefix, after) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (!after || key > after))
        .toSorted();

      return {
        objects: keys.slice(0, 100).map((key) => ({ key, byteLength: objects.get(key)!.length })),
        truncated: keys.length > 100,
      };
    },
  };

  return { storage, objects, writes, deletes, failures };
}
