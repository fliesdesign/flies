import { S3Client } from "bun";

import type { Config } from "./config";

export interface RevisionStorage {
  put(key: string, document: unknown): Promise<{ sha256: string; byteLength: number }>;
  get(key: string): Promise<unknown>;
}

export function createStorage(config: Config): RevisionStorage {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  });

  return {
    async put(key, document) {
      const body = Bun.gzipSync(JSON.stringify(document));
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      // The service generates a fresh ULID key for every attempt, never a mutable filename.
      await client.write(key, body, { type: "application/gzip" });

      return { sha256, byteLength: body.length };
    },
    async get(key) {
      const body = Bun.gunzipSync(new Uint8Array(await client.file(key).arrayBuffer()));

      return JSON.parse(new TextDecoder().decode(body));
    },
  };
}
