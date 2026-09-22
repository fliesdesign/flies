import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { configSchema } from "../src/config";
import { migrationConnectionString } from "../src/db/migrations";
import { parseSnapshot } from "../src/files";
import { idSchema } from "../src/ids";
import { totpCodeSchema } from "../src/mfa";

describe("API input validation", () => {
  test("accepts ULIDs and legacy UUIDs but rejects invalid file IDs", () => {
    for (const id of ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
      expect(v.safeParse(idSchema, id).success).toBe(true);
    for (const id of ["../secret", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", "01ARZ3NDEKTSV4RRFFQ69G5FAI"])
      expect(v.safeParse(idSchema, id).success).toBe(false);
  });
  test("rejects invalid geometry, duplicate IDs, and parent cycles", () => {
    const node = { id: "frame", name: "Frame", x: 0, y: 0, width: 100, height: 100 };

    for (const nodes of [
      [{ ...node, width: -1 }],
      [node, node],
      [{ ...node, parentId: "frame" }],
      [{ ...node, kind: "script" }],
    ]) {
      expect(() => parseSnapshot({ name: "Test", nodes })).toThrow();
    }
  });
  test("normalizes valid files and rejects missing names", () => {
    expect(parseSnapshot({ name: "  Test  ", nodes: [] })).toEqual({
      name: "Test",
      nodes: [],
      theme: { tokens: [] },
    });
    expect(() => parseSnapshot({ name: " ", nodes: [] })).toThrow();
  });
  test("configuration requires secrets and a valid database URL", () => {
    expect(v.safeParse(configSchema, {}).success).toBe(false);
  });
  test("migrations use direct Neon connections without altering other database hosts", () => {
    const pooled =
      "postgres://test:password@ep-example-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

    expect(migrationConnectionString(pooled)).toBe(pooled.replace("-pooler.", "."));
    const local = "postgres://test:password@localhost:5432/test";
    expect(migrationConnectionString(local)).toBe(local);
  });
  test("TOTP codes are exactly six digits", () => {
    expect(v.safeParse(totpCodeSchema, "123456").success).toBe(true);
    for (const code of ["12345", "1234567", "abcdef", "12 456", ""])
      expect(v.safeParse(totpCodeSchema, code).success).toBe(false);
  });
});
