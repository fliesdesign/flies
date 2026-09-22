import type { RevisionStorage } from "./storage";

type Document = { nodes: { id: string; kind?: string; src?: string }[] };
type StoredSnapshot = {
  format: "flies-storage";
  version: 1;
  document: Document;
  assets: Record<string, string>;
};

const directory = (key: string) => key.slice(0, key.lastIndexOf("/"));
const assetKey = (key: string, hash: string) => `${directory(key)}/assets/${hash}.json.gz`;

/** Keep image bytes once per file; snapshots contain only geometry and hashes. */
export function prepareRevision<T extends Document>(key: string, document: T) {
  const assets = new Map<string, string>();
  const references: Record<string, string> = Object.create(null);
  const hashes = new Map<string, string>();

  // oxlint-disable-next-line oxc/no-map-spread -- Keep caller-owned nodes immutable.
  const nodes = document.nodes.map((node) => {
    if ((node.kind !== "image" && node.kind !== "svg") || !node.src) return node;
    let hash = hashes.get(node.src);

    if (!hash) {
      hash = new Bun.CryptoHasher("sha256").update(node.src).digest("hex");
      hashes.set(node.src, hash);
    }

    references[node.id] = hash;
    assets.set(assetKey(key, hash), node.src);

    return { ...node, src: "" };
  });

  const snapshot: StoredSnapshot = {
    format: "flies-storage",
    version: 1,
    document: { ...document, nodes },
    assets: references,
  };

  return { snapshot, assets };
}

export async function readRevision(storage: RevisionStorage, key: string): Promise<unknown> {
  const value = await storage.get(key);
  if (
    !value ||
    typeof value !== "object" ||
    !("format" in value) ||
    value.format !== "flies-storage"
  )
    return value; // Existing full-document gzip revisions remain readable.

  const snapshot = value as StoredSnapshot;
  if (snapshot.version !== 1) throw new Error("Unsupported revision storage version.");
  const sources = new Map<string, string>();
  const hashes = [...new Set(Object.values(snapshot.assets))];

  // Bound read fan-out for documents with many images.
  for (let offset = 0; offset < hashes.length; offset += 4) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      hashes.slice(offset, offset + 4).map(async (hash) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid revision asset hash.");
        const source = await storage.get(assetKey(key, hash));
        if (typeof source !== "string") throw new Error("Missing revision asset.");
        sources.set(hash, source);
      }),
    );
  }

  return {
    ...snapshot.document,
    // oxlint-disable-next-line oxc/no-map-spread -- Hydration must not mutate cached storage values.
    nodes: snapshot.document.nodes.map((node) => {
      const hash = Object.hasOwn(snapshot.assets, node.id) ? snapshot.assets[node.id] : undefined;

      return hash ? { ...node, src: sources.get(hash)! } : node;
    }),
  };
}
