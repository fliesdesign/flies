import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { RedisClient } from "bun";

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
  readonly client: RedisClient;
  private readonly subscriber: RedisClient;
  readonly cipher: ReturnType<typeof syncCipher>;
  private readonly prefix: string;
  private ready: Promise<void> | null = null;
  onDisconnect?: () => void;
  constructor(url: string, key: string, namespace = "flies-sync-v1") {
    this.cipher = syncCipher(key);
    this.prefix = namespace;
    const options = { connectionTimeout: 5000, enableOfflineQueue: false, maxRetries: 10 };
    this.client = new RedisClient(url, options);
    this.subscriber = new RedisClient(url, options);
    // Bun Redis exposes callback properties, not EventTarget listeners.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    this.subscriber.onclose = () => this.onDisconnect?.();
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    this.client.onclose = () => this.onDisconnect?.();
  }

  connect() {
    if (this.client.connected && this.subscriber.connected) return Promise.resolve();

    return (this.ready ??= Promise.all([
      this.client.connected ? undefined : this.client.connect(),
      this.subscriber.connected ? undefined : this.subscriber.connect(),
    ])
      .then(() => undefined)
      .finally(() => {
        this.ready = null;
      }));
  }

  room(workspaceId: string, fileId: string) {
    return `${this.prefix}:room:${this.cipher.topic(`${workspaceId}:${fileId}`)}`;
  }

  private key(value: string) {
    return `${this.prefix}:${this.cipher.topic(value)}`;
  }

  async ticket(value: unknown) {
    await this.connect();
    const token = randomBytes(32).toString("base64url");
    const key = this.key(`ticket:${token}`);
    await this.client.send("SET", [key, this.cipher.seal(value, key), "EX", "30"]);

    return token;
  }

  async consume<T>(token: string): Promise<T | null> {
    await this.connect();
    const key = this.key(`ticket:${token}`);
    const encrypted = await this.client.send("GETDEL", [key]);

    return typeof encrypted === "string" ? this.cipher.open<T>(encrypted, key) : null;
  }

  async rateLimit(userId: string, bucket: string, limit: number, seconds: number) {
    await this.connect();
    const key = this.key(`rate:${userId}:${bucket}`);

    const count = await this.client.send("EVAL", [
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      "1",
      key,
      String(seconds),
    ]);

    return Number(count) <= limit;
  }

  async publish(room: string, value: unknown) {
    await this.connect();
    await this.client.publish(room, this.cipher.seal(value, room));
  }

  async subscribe(room: string, listener: (value: unknown) => void) {
    await this.connect();

    const callback = (message: string) => {
      try {
        listener(this.cipher.open(message, room));
      } catch {
        /* Reject tampered messages without logging their contents. */
      }
    };

    await this.subscriber.subscribe(room, callback);

    return () => this.subscriber.unsubscribe(room, callback);
  }

  async presence(room: string, id: string, value: unknown) {
    const key = `${room}:peers`;
    const encrypted = this.cipher.seal(value, key);
    await this.client.send("EVAL", [
      "local old=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[3]); for _,id in ipairs(old) do redis.call('HDEL',KEYS[1],id) end; redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[3]); redis.call('ZADD',KEYS[2],ARGV[4],ARGV[1]); redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('EXPIRE',KEYS[1],60); redis.call('EXPIRE',KEYS[2],60); return 1",
      "2",
      key,
      `${key}:expiry`,
      id,
      encrypted,
      String(Date.now()),
      String(Date.now() + 25000),
    ]);
  }

  async peers<T>(room: string): Promise<T[]> {
    const key = `${room}:peers`;
    const values = (await this.client.send("HVALS", [key])) as string[];

    return values.flatMap((value) => {
      try {
        return [this.cipher.open<T>(value, key)];
      } catch {
        return [];
      }
    });
  }

  async leave(room: string, id: string) {
    await this.client.send("HDEL", [`${room}:peers`, id]);
  }

  async lease(userId: string, id: string) {
    const key = this.key(`connections:${userId}`);

    const result = await this.client.send("EVAL", [
      "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if not redis.call('ZSCORE',KEYS[1],ARGV[2]) and redis.call('ZCARD',KEYS[1])>=12 then return 0 end; redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]); redis.call('EXPIRE',KEYS[1],35); return 1",
      "1",
      key,
      String(Date.now()),
      id,
      String(Date.now() + 30000),
    ]);

    return Number(result) === 1;
  }

  async release(userId: string, id: string) {
    await this.client.send("ZREM", [this.key(`connections:${userId}`), id]);
  }

  close() {
    this.client.close();
    this.subscriber.close();
  }
}
