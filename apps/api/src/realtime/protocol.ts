import type { DocumentDelta } from "@flies/canvas/sync";
import * as v from "valibot";

import { idSchema } from "../ids";

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
export type Commit = { mutationId: string; delta: DocumentDelta };
