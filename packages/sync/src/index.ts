import * as v from "valibot";

export const idSchema = v.union([
  v.pipe(v.string(), v.regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)),
  v.pipe(v.string(), v.uuid()),
]);

const entityId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

const field = v.pipe(
  v.string(),
  v.maxLength(100),
  v.check((key) => !["__proto__", "prototype", "constructor", "id"].includes(key)),
);

const safeRecord = v.pipe(
  v.unknown(),
  v.check(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Object.keys(value).some((key) => ["__proto__", "prototype", "constructor"].includes(key)),
  ),
  v.record(v.string(), v.unknown()),
);

const entity = v.strictObject({
  id: entityId,
  create: v.optional(safeRecord),
  set: v.optional(
    v.pipe(
      safeRecord,
      v.check((value) => !Object.hasOwn(value, "id")),
    ),
  ),
  unset: v.optional(v.pipe(v.array(field), v.maxLength(100))),
  remove: v.optional(v.literal(true)),
});

export const deltaSchema = v.strictObject({
  nodes: v.pipe(v.array(entity), v.maxLength(50_000)),
  tokens: v.pipe(v.array(entity), v.maxLength(10_000)),
  order: v.optional(
    v.pipe(
      v.array(entityId),
      v.maxLength(50_000),
      v.check((ids) => new Set(ids).size === ids.length),
    ),
  ),
  tokenOrder: v.optional(
    v.pipe(
      v.array(entityId),
      v.maxLength(10_000),
      v.check((ids) => new Set(ids).size === ids.length),
    ),
  ),
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
});
export const commitSchema = v.strictObject({ mutationId: idSchema, delta: deltaSchema });
const coordinate = v.pipe(v.number(), v.finite(), v.minValue(-1e8), v.maxValue(1e8));
export const presenceSchema = v.strictObject({
  cursor: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
  selection: v.pipe(v.array(entityId), v.maxLength(100)),
  activity: v.picklist(["viewing", "editing"]),
});
export type PresenceInput = v.InferOutput<typeof presenceSchema>;
export type Peer = PresenceInput & {
  connectionId: string;
  userId: string;
  name: string;
  color: string;
  updatedAt: number;
};
export type Commit = v.InferOutput<typeof commitSchema>;

export const SYNC_MESSAGE_BYTES = 512 * 1024;
export const SYNC_PROTOCOL = "flies-sync-v1";
const boundedString = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
export const grantSchema = v.strictObject({
  fileId: idSchema,
  workspaceId: idSchema,
  sessionHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  user: v.strictObject({ id: boundedString, name: v.pipe(v.string(), v.maxLength(100)) }),
  origin: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
export type SyncGrant = v.InferOutput<typeof grantSchema>;
export type SyncTicket = { enabled: true; ticket: string; socketUrl: string };

export function secureServiceUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Sync service URLs must be HTTPS origins (HTTP is allowed on loopback only).");

  return url.origin;
}

const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

export async function secretMatches(header: string | null | undefined, secret: string) {
  if (secret.length < 32 || !header?.startsWith("Bearer ")) return false;

  const [actual, expected] = await Promise.all([digest(header.slice(7)), digest(secret)]);
  let mismatch = 0;
  for (let index = 0; index < actual.length; index++) mismatch |= actual[index] ^ expected[index];

  return mismatch === 0;
}
