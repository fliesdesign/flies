import { describe, expect, test } from "bun:test";

import { secretMatches } from "@flies/sync";
import * as v from "valibot";

import { realtimeConfig } from "../src/config";
import { commitSchema, presenceSchema } from "../src/realtime/protocol";

describe("sync security boundaries", () => {
  test("internal sync requests require the shared server secret", async () => {
    const secret = "a".repeat(32);
    expect(await secretMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(await secretMatches(`Bearer ${"b".repeat(32)}`, secret)).toBe(false);
    expect(await secretMatches(undefined, secret)).toBe(false);
    expect(await secretMatches("Bearer short", "short")).toBe(false);
  });
  test("presence cannot spoof identity and rejects unbounded coordinates", () => {
    expect(
      v.safeParse(presenceSchema, {
        cursor: { x: Infinity, y: 0 },
        selection: [],
        activity: "viewing",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(presenceSchema, {
        cursor: null,
        selection: [],
        activity: "viewing",
        userId: "owner",
      }).success,
    ).toBe(false);
  });
  test("deltas reject duplicate ordering, prototype fields, and invalid mutation IDs", () => {
    const mutationId = "01M30000000000000000000000";
    expect(
      v.safeParse(commitSchema, { mutationId, delta: { nodes: [], tokens: [], order: ["a", "a"] } })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(
        commitSchema,
        JSON.parse(
          `{"mutationId":"${mutationId}","delta":{"nodes":[{"id":"a","set":{"__proto__":{}}}],"tokens":[]}}`,
        ),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(commitSchema, { mutationId: "bad", delta: { nodes: [], tokens: [] } }).success,
    ).toBe(false);
  });
  test("configuration requires the Cloudflare sync origin and a shared secret", () => {
    const config = {
      API_URL: "https://api.example.com",
      SYNC_SERVER_URL: "https://sync.example.com",
      SYNC_SERVER_SECRET: "a".repeat(32),
    };

    expect(realtimeConfig({ API_URL: config.API_URL })).toBeNull();
    expect(realtimeConfig(config)).toEqual({
      url: config.SYNC_SERVER_URL,
      secret: config.SYNC_SERVER_SECRET,
    });
    for (const field of ["SYNC_SERVER_URL", "SYNC_SERVER_SECRET"])
      expect(() => realtimeConfig({ ...config, [field]: "" })).toThrow("Realtime needs");
    expect(() => realtimeConfig({ ...config, SYNC_SERVER_SECRET: "short" })).toThrow();
    for (const url of [
      "http://sync.example.com",
      "https://user:password@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
    ])
      expect(() => realtimeConfig({ ...config, SYNC_SERVER_URL: url })).toThrow("HTTPS origins");
    expect(() => realtimeConfig({ ...config, API_URL: "http://api.example.com" })).toThrow();
    expect(realtimeConfig({ ...config, SYNC_SERVER_URL: "http://127.0.0.1:8787" })).not.toBeNull();
  });
});
