import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { configSchema } from "../src/config";
import { parseSnapshot } from "../src/files";
import { idSchema } from "../src/ids";

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
});
