import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { configSchema } from "../src/config";
import { parseSnapshot } from "../src/files";

describe("API input validation", () => {
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
