import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { Realtime } from "@upstash/realtime";
import { Redis } from "@upstash/redis";
import { z } from "zod";

export function syncCipher(key: string) {
  const secret = Buffer.from(key, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== key)
    throw new Error("SYNC_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");

  return {
    topic(value: string) {
      return createHmac("sha256", secret).update(value).digest("hex");
    },
    seal(value: unknown, context: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, nonce);
      cipher.setAAD(Buffer.from(context));

      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);

      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    open<T>(value: string, context: string): T {
      const data = Buffer.from(value, "base64");
      if (data.length < 29) throw new Error("Invalid encrypted sync message.");
      const cipher = createDecipheriv("aes-256-gcm", secret, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      cipher.setAAD(Buffer.from(context));

      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8"),
      ) as T;
    },
  };
}

/** Redis sees opaque room names and authenticated ciphertext, including persisted presence. */
export class SyncRedis {
  readonly client: Redis;
  readonly cipher: ReturnType<typeof syncCipher>;
  private readonly prefix: string;
  private readonly subscriptions = new Set<() => Promise<void>>();
  private closed = false;
  onDisconnect?: () => void;

  constructor(url: string, token: string, key: string, namespace = "flies-sync-v2") {
    this.cipher = syncCipher(key);
    this.prefix = namespace;
    this.client = new Redis({ url, token, retry: false });
  }

  room(workspaceId: string, fileId: string) {
    return `${this.prefix}:room:${this.cipher.topic(`${workspaceId}:${fileId}`)}`;
  }

  private key(value: string) {
    return `${this.prefix}:${this.cipher.topic(value)}`;
  }

  async ticket(value: unknown) {
    const token = randomBytes(32).toString("base64url");
    const key = this.key(`ticket:${token}`);
    await this.client.set(key, this.cipher.seal(value, key), { ex: 30 });

    return token;
  }

  async consume<T>(token: string): Promise<T | null> {
    const key = this.key(`ticket:${token}`);
    const encrypted = await this.client.getdel<string>(key);

    return typeof encrypted === "string" ? this.cipher.open<T>(encrypted, key) : null;
  }

  async rateLimit(userId: string, bucket: string, limit: number, seconds: number) {
    const key = this.key(`rate:${userId}:${bucket}`);

    const count = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      [key],
      [seconds],
    );

    return Number(count) <= limit;
  }

  async publish(room: string, value: unknown) {
    // Keep only a bounded, short-lived encrypted event history. File revisions
    // remain authoritative, so reconnecting clients never replay stale cursors.
    const realtime = new Realtime({
      redis: this.client,
      schema: { sync: z.string() },
      history: { maxLength: 100, expireAfterSecs: 60 },
    });

    await realtime.channel(room).emit("sync", this.cipher.seal(value, room));
  }

  async subscribe(room: string, listener: (value: unknown) => void) {
    if (this.closed) throw new Error("Sync service is stopped.");
    // Consume Upstash Realtime envelopes over the REST SDK's SSE subscription.
    // Owning the lifecycle here lets upstream failures close browser sockets and
    // trigger their existing reconnect/reconciliation path.
    const subscriber = this.client.subscribe<{ event?: string; data?: unknown }>(room);
    let active = true;
    let rejectReady: ((error: Error) => void) | undefined;
    let timer: ReturnType<typeof setTimeout>;

    const unsubscribe = async () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      this.subscriptions.delete(unsubscribe);
      rejectReady?.(new Error("Sync subscription closed."));
      await subscriber.unsubscribe();
    };

    const failed = () => {
      if (!active) return;
      void unsubscribe();
      this.onDisconnect?.();
    };

    const touch = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(failed, milliseconds);
      timer.unref();
    };

    this.subscriptions.add(unsubscribe);

    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      subscriber.on("subscribe", () => {
        touch(30_000);
        resolve();
      });
    });

    subscriber.on("error", failed);
    subscriber.on("unsubscribe", failed);
    subscriber.on("message", ({ message }) => {
      if (!active) return;
      touch(30_000);
      if (message?.event !== "sync" || typeof message.data !== "string") return;

      try {
        listener(this.cipher.open(message.data, room));
      } catch {
        /* Reject tampered messages without logging their contents. */
      }
    });
    touch(5_000);
    await ready;

    return unsubscribe;
  }

  async presence(room: string, id: string, value: unknown) {
    const key = `${room}:peers`;
    const encrypted = this.cipher.seal(value, key);
    await this.client.eval(
      "local old=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[3]); for _,id in ipairs(old) do redis.call('HDEL',KEYS[1],id) end; redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[3]); redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1]); redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('EXPIRE',KEYS[1],60); redis.call('EXPIRE',KEYS[2],60); return 1",
      [key, `${key}:expiry`],
      [id, encrypted, Date.now(), Date.now() + 25000],
    );
  }

  async peers<T>(room: string): Promise<T[]> {
    const key = `${room}:peers`;
    const values = (await this.client.hvals(key)) as unknown[];

    return values.flatMap((value) => {
      try {
        return typeof value === "string" ? [this.cipher.open<T>(value, key)] : [];
      } catch {
        return [];
      }
    });
  }

  async leave(room: string, id: string) {
    await this.client.hdel(`${room}:peers`, id);
  }

  async lease(userId: string, id: string) {
    const key = this.key(`connections:${userId}`);

    const result = await this.client.eval(
      "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if not redis.call('ZSCORE',KEYS[1],ARGV[2]) and redis.call('ZCARD',KEYS[1])>=12 then return 0 end; redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]); redis.call('EXPIRE',KEYS[1],35); return 1",
      [key],
      [Date.now(), id, Date.now() + 30000],
    );

    return Number(result) === 1;
  }

  async release(userId: string, id: string) {
    await this.client.zrem(this.key(`connections:${userId}`), id);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.subscriptions].map((unsubscribe) => unsubscribe()));
  }
}
