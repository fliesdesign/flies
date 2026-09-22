import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import * as v from "valibot";

import { realtimeConfig } from "../src/config";
import { commitSchema, presenceSchema } from "../src/realtime/protocol";
import { syncCipher } from "../src/realtime/redis";

describe("sync security boundaries", () => {
  test("AES-GCM hides payload and rejects tampering or another room", () => {
    const cipher = syncCipher(randomBytes(32).toString("base64"));
    const value = { user: "private-user", cursor: { x: 12, y: 44 } };
    const first = cipher.seal(value, "room1");
    expect(cipher.seal(value, "room1")).not.toBe(first);
    expect(first).not.toContain("private-user");
    expect(cipher.open<typeof value>(first, "room1")).toEqual(value);
    expect(() => cipher.open(first, "room2")).toThrow();
    const bytes = Buffer.from(first, "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(() => cipher.open(bytes.toString("base64"), "room1")).toThrow();
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
  test("configuration allows Redis with or without TLS on any host", () => {
    const key = randomBytes(32).toString("base64");
    expect(realtimeConfig({ API_URL: "https://api.example.com" })).toBeNull();

    for (const url of [
      "redis://redis.example.com",
      "redis://redis.railway.internal:6379",
      "redis://localhost:6379",
      "redis://192.168.1.10:6379",
      "redis://[::1]:6379",
      "redis://user:password@redis.example.com:6379/1",
      "rediss://redis.example.com",
    ]) {
      expect(
        realtimeConfig({
          API_URL: "https://api.example.com",
          REDIS_URL: url,
          SYNC_ENCRYPTION_KEY: key,
        }),
      ).toEqual({ url, key });
    }

    expect(() =>
      realtimeConfig({
        API_URL: "https://api.example.com",
        REDIS_URL: "https://redis.example.com",
        SYNC_ENCRYPTION_KEY: key,
      }),
    ).toThrow("Redis URL must use redis:// or rediss://.");
    expect(() =>
      realtimeConfig({
        API_URL: "http://api.example.com",
        REDIS_URL: "rediss://redis.example.com",
        SYNC_ENCRYPTION_KEY: key,
      }),
    ).toThrow();
  });
});
