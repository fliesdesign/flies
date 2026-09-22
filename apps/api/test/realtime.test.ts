import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import * as v from "valibot";

import { realtimeConfig } from "../src/config";
import { commitSchema, presenceSchema } from "../src/realtime/protocol";
import { SyncRedis, syncCipher } from "../src/realtime/redis";

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
  test("configuration requires complete Upstash credentials and secure endpoints", () => {
    const config = {
      API_URL: "https://api.example.com",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
      SYNC_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };

    expect(realtimeConfig({ API_URL: config.API_URL })).toBeNull();
    expect(realtimeConfig(config)).toEqual({
      url: config.UPSTASH_REDIS_REST_URL,
      token: config.UPSTASH_REDIS_REST_TOKEN,
      key: config.SYNC_ENCRYPTION_KEY,
    });
    for (const field of [
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "SYNC_ENCRYPTION_KEY",
    ])
      expect(() => realtimeConfig({ ...config, [field]: "" })).toThrow("Realtime needs");
    for (const url of [
      "redis://example.com",
      "http://example.com",
      "https://user:password@example.com",
    ])
      expect(() => realtimeConfig({ ...config, UPSTASH_REDIS_REST_URL: url })).toThrow(
        "must use HTTPS",
      );
    expect(() => realtimeConfig({ ...config, API_URL: "http://api.example.com" })).toThrow(
      "requires HTTPS",
    );
    expect(realtimeConfig({ ...config, API_URL: "http://localhost:3001" })).not.toBeNull();
  });
});

describe("Upstash subscription lifecycle", () => {
  test("upstream errors reject joins, notify active rooms, and release streams", async () => {
    const redis = new SyncRedis(
      "https://example.upstash.io",
      "test-token",
      randomBytes(32).toString("base64"),
    );

    const listeners = new Map<string, (value?: unknown) => void>();
    let stopped = 0;
    let disconnected = 0;

    const originalSubscribe = redis.client.subscribe;
    redis.client.subscribe = <TMessage>() =>
      ({
        on: (event: string, listener: (value?: unknown) => void) => {
          listeners.set(event, listener);
        },
        unsubscribe: async () => {
          stopped++;
        },
      }) as ReturnType<typeof redis.client.subscribe<TMessage>>;

    redis.onDisconnect = () => {
      disconnected++;
    };

    try {
      const joining = redis.subscribe("room", () => {});
      const rejected = joining.catch((error: Error) => error);
      listeners.get("error")!();
      expect(await rejected).toMatchObject({ message: "Sync subscription closed." });
      expect(stopped).toBe(1);
      expect(disconnected).toBe(1);

      const messages: unknown[] = [];
      const connected = redis.subscribe("room", (value) => messages.push(value));
      listeners.get("subscribe")!();
      const unsubscribe = await connected;
      listeners.get("message")!({
        message: { event: "sync", data: redis.cipher.seal({ type: "changed" }, "other-room") },
      });
      expect(messages).toEqual([]);
      listeners.get("message")!({
        message: { event: "sync", data: redis.cipher.seal({ type: "changed" }, "room") },
      });
      expect(messages).toEqual([{ type: "changed" }]);
      listeners.get("error")!();
      await unsubscribe();
      expect(stopped).toBe(2);
      expect(disconnected).toBe(2);
      await redis.close();
      await expect(redis.subscribe("room", () => {})).rejects.toThrow("stopped");
    } finally {
      await redis.close();
      redis.client.subscribe = originalSubscribe;
    }
  });
});
