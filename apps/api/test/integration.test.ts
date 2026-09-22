import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { S3Client } from "bun";
import { eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ulid } from "ulid";

import { createApp } from "../src/app";
import { hash, type AuthProvider } from "../src/auth";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/db/client";
import { files, revisions, sessions, users, workspaces, loginAttempts } from "../src/db/schema";
import { ensureWorkspace, type Identity } from "../src/files";
import { readRevision } from "../src/revision-snapshot";
import { createStorage } from "../src/storage";
import { memoryRevisionStorage } from "./revision-storage";

const config = readConfig();
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL)
  throw new Error("Integration tests require the isolated TEST_DATABASE_URL as DATABASE_URL.");
config.S3_PREFIX = `tests/${crypto.randomUUID()}`;
const { db, client } = connectDatabase(config.DATABASE_URL);
const storage = createStorage(config);

const identities = ["alice", "bob"].map((name): Identity => ({
  id: `test_${name}_${crypto.randomUUID()}`,
  email: `${name}@example.com`,
  name,
}));

let available = true;
let uploadsFail = false;
let mfaCode = "123456";

const provisioned = new Map<string, string>();

const mfaFactors = new Map<
  string,
  { id: string; createdAt: string; challengeId: string; code: string }[]
>();

const provider: AuthProvider = {
  async ensureOrganization(workspace) {
    if (provisioned.has(workspace.id)) throw new Error("Duplicate provisioning");
    const id = `org_test_${workspace.id}`;
    provisioned.set(workspace.id, id);

    return id;
  },
  authorizationUrl: (state, _verifier, options) =>
    `https://example.com/authorize?state=${state}${options?.prompt ? `&prompt=${options.prompt}` : ""}`,
  async exchange(code) {
    const user = identities.find((u) => u.id === code);
    if (!user) throw new Error("Invalid code");

    return { user, sealedSession: user.id };
  },
  async verify(session) {
    const user = identities.find((u) => u.id === session);

    return available && user ? { user, sealedSession: session } : null;
  },
  async revoke() {},
  async listFactors(userId) {
    return (mfaFactors.get(userId) ?? []).map(({ id, createdAt }) => ({ id, createdAt }));
  },
  async enrollFactor(user) {
    if ((mfaFactors.get(user.id) ?? []).length)
      throw new HTTPException(409, { message: "Two-factor authentication is already on." });

    const factor = {
      id: `auth_factor_${ulid()}`,
      createdAt: new Date().toISOString(),
      challengeId: `auth_challenge_${ulid()}`,
      code: mfaCode,
    };

    mfaFactors.set(user.id, [factor]);

    return {
      factorId: factor.id,
      challengeId: factor.challengeId,
      qrCode: "data:image/png;base64,AQID",
      secret: "JBSWY3DPEHPK3PXP",
      uri: `otpauth://totp/Flies:${user.email}?secret=JBSWY3DPEHPK3PXP&issuer=Flies`,
    };
  },
  async verifyEnrollment({ userId, factorId, challengeId, code }) {
    const factor = (mfaFactors.get(userId) ?? []).find(
      (item) => item.id === factorId && item.challengeId === challengeId,
    );

    if (!factor) throw new HTTPException(404, { message: "Authenticator is not available." });

    return code === factor.code;
  },
  async deleteFactor(userId, factorId) {
    const current = mfaFactors.get(userId) ?? [];
    const next = current.filter((item) => item.id !== factorId);
    if (next.length === current.length)
      throw new HTTPException(404, { message: "Authenticator is not available." });
    mfaFactors.set(userId, next);
  },
};

const { app, auth } = createApp(
  db,
  {
    ...storage,
    put: (key, doc) => {
      if (uploadsFail) throw new Error("S3 unavailable");

      return storage.put(key, doc);
    },
  },
  config,
  provider,
);

let tokens: string[];
let fileId: string;

const request = (path: string, user = 0, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${tokens[user]}`,
      Origin: config.WEB_URL,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const snapshot = {
  name: "Integration design",
  nodes: [{ id: "frame", name: "Frame", x: 0, y: 0, width: 800, height: 600 }],
  theme: { tokens: [] },
};

beforeAll(async () => {
  tokens = await Promise.all(identities.map((user) => auth.createSession(user, user.id)));
}, 30_000);
afterAll(async () => {
  const owned = await db
    .select()
    .from(workspaces)
    .where(
      inArray(
        workspaces.ownerId,
        identities.map((u) => u.id),
      ),
    );

  const docs = await db
    .select()
    .from(files)
    .where(
      inArray(
        files.workspaceId,
        owned.map((w) => w.id),
      ),
    );

  await db.delete(revisions).where(
    inArray(
      revisions.fileId,
      docs.map((d) => d.id),
    ),
  );
  await db.delete(files).where(
    inArray(
      files.workspaceId,
      owned.map((w) => w.id),
    ),
  );
  await db.delete(sessions).where(
    inArray(
      sessions.userId,
      identities.map((u) => u.id),
    ),
  );
  await db.delete(workspaces).where(
    inArray(
      workspaces.ownerId,
      identities.map((u) => u.id),
    ),
  );
  await db.delete(users).where(
    inArray(
      users.id,
      identities.map((u) => u.id),
    ),
  );

  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  });

  const objects = await s3.list({ prefix: config.S3_PREFIX });
  await Promise.all((objects.contents ?? []).map((object) => s3.delete(object.key)));
  await client.close();
}, 30_000);
describe("Neon + Railway revision API", () => {
  test("failed organization provisioning preserves its ID and concurrent retries link once", async () => {
    const user = { id: `test_retry_${ulid()}`, name: "Retry", email: "retry@example.invalid" };
    identities.push(user);
    let externalId = "";
    let attempts = 0;

    const retryProvider = {
      async ensureOrganization(workspace: { id: string }) {
        attempts++;

        if (attempts === 1) {
          externalId = workspace.id;
          throw new Error("Provisioning interrupted after remote creation");
        }

        expect(workspace.id).toBe(externalId);

        return `org_test_${workspace.id}`;
      },
    };

    await expect(ensureWorkspace(db, user, retryProvider)).rejects.toThrow(
      "Provisioning interrupted",
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureWorkspace(db, user, retryProvider)),
    );

    expect(attempts).toBe(2);
    expect(new Set(results.map((w) => w.workosOrganizationId)).size).toBe(1);
  }, 20_000);
  test("authentication and CSRF reject untrusted requests", async () => {
    expect((await app.request("/api/files")).status).toBe(401);
    expect(
      (
        await app.request("/api/files", {
          method: "POST",
          headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  test("concurrent first logins create exactly one default workspace", async () => {
    const rows = await Promise.all(
      Array.from({ length: 4 }, () => ensureWorkspace(db, identities[0], provider)),
    );

    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(rows[0].workosOrganizationId).toBe(provisioned.get(rows[0].id)!);
  }, 20_000);
  test("create and read a real gzipped S3 revision", async () => {
    const response = await request("/api/files", 0, snapshot);
    expect(response.status).toBe(201);
    const file = await response.json();
    fileId = file.id;
    expect(file.revision).toBe(0);
    expect(file.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const read = await request(`/api/files/${fileId}`);
    expect(await read.json()).toEqual(file);
    expect(
      (await (await request("/api/files")).json()).files.map((f: { id: string }) => f.id),
    ).toContain(fileId);
  }, 30_000);
  test("other users cannot list, read, save, archive, or inspect revisions", async () => {
    expect((await (await request("/api/files", 1)).json()).files).toEqual([]);
    for (const path of [`/api/files/${fileId}`, `/api/files/${fileId}/revisions`])
      // eslint-disable-next-line no-await-in-loop
      expect((await request(path, 1)).status).toBe(404);
    expect(
      (
        await request(`/api/files/${fileId}/revisions`, 1, {
          ...snapshot,
          revision: 0,
          mutationId: ulid(),
        })
      ).status,
    ).toBe(404);
    expect((await request(`/api/files/${fileId}/archive`, 1, { archived: true })).status).toBe(404);
  }, 20_000);
  test("concurrent saves reject stale writers and retain immutable history", async () => {
    // oxlint-disable-next-line oxc/no-map-spread -- Each concurrent request needs its own snapshot.
    const payloads = [1, 2].map((n) => ({
      ...snapshot,
      name: `Save ${n}`,
      revision: 0,
      mutationId: ulid(),
    }));

    const responses = await Promise.all(
      payloads.map((p) => request(`/api/files/${fileId}/revisions`, 0, p)),
    );

    expect(responses.map((r) => r.status).toSorted()).toEqual([200, 409]);
    const winner = responses.findIndex((r) => r.status === 200);
    const saved = await responses[winner].json();
    expect(saved.revision).toBe(1);
    expect(
      await (await request(`/api/files/${fileId}/revisions`, 0, payloads[winner])).json(),
    ).toEqual(saved);
    const rows = await db.select().from(revisions).where(eq(revisions.fileId, fileId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.objectKey)).size).toBe(2);
    expect(
      (
        (await readRevision(storage, rows.find((r) => r.number === 0)!.objectKey)) as {
          name: string;
        }
      ).name,
    ).toBe(snapshot.name);
  }, 30_000);
  test("failed S3 writes preserve the previous revision and allow retry", async () => {
    uploadsFail = true;
    const payload = { ...snapshot, revision: 1, mutationId: ulid() };
    expect((await request(`/api/files/${fileId}/revisions`, 0, payload)).status).toBe(500);
    uploadsFail = false;
    expect((await (await request(`/api/files/${fileId}`)).json()).revision).toBe(1);
    expect((await request(`/api/files/${fileId}/revisions`, 0, payload)).status).toBe(200);
  }, 30_000);
  test("archive and restore stay scoped to the workspace", async () => {
    expect((await request(`/api/files/${fileId}/archive`, 0, { archived: true })).status).toBe(200);
    expect((await request(`/api/files/${fileId}`)).status).toBe(404);
    expect((await request(`/api/files/${fileId}/archive`, 0, { archived: false })).status).toBe(
      200,
    );
    expect((await request(`/api/files/${fileId}`)).status).toBe(200);
  }, 20_000);
  test("desktop callback requires browser state and verifier; completion is single use", async () => {
    const verifier = crypto.randomUUID().replaceAll("-", "") + "abcdefghijk";
    const response = await app.request(`/auth/login?desktop=${hash(verifier)}`);
    const state = new URL(response.headers.get("Location")!).searchParams.get("state")!;
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    const url = `/auth/callback?state=${state}&code=${identities[0].id}`;
    expect((await app.request(url)).status).toBe(400);
    expect((await app.request(url, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await app.request(url, { headers: { Cookie: cookie } })).status).toBe(400);
    const completed = await request("/auth/desktop/complete", 0, { verifier });
    expect((await completed.json()).token).toBeString();
    expect(
      (await (await request("/auth/desktop/complete", 0, { verifier })).json()).token,
    ).toBeNull();
    await db.delete(loginAttempts).where(eq(loginAttempts.state, state));
  }, 20_000);
  test("browser login returns to a file route and rejects external redirect targets", async () => {
    for (const requested of [`/files/${fileId}`, "//evil.example", "https://evil.example"]) {
      // eslint-disable-next-line no-await-in-loop
      const login = await app.request(`/auth/login?returnTo=${encodeURIComponent(requested)}`);
      const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
      const cookie = login.headers.get("Set-Cookie")!.split(";")[0];

      // eslint-disable-next-line no-await-in-loop
      const callback = await app.request(`/auth/callback?state=${state}&code=${identities[0].id}`, {
        headers: { Cookie: cookie },
      });

      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe(
        new URL(requested.startsWith("/files/") ? requested : "/recents", config.WEB_URL).href,
      );
    }
  }, 20_000);
  test("passkey sign-in returns to account settings and asks AuthKit to reauthenticate", async () => {
    const login = await app.request("/auth/login?returnTo=%2Fsettings%23account&passkey=1");
    expect(new URL(login.headers.get("Location")!).searchParams.get("prompt")).toBe("login");
    const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0];

    const callback = await app.request(`/auth/callback?state=${state}&code=${identities[0].id}`, {
      headers: { Cookie: cookie },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      new URL("/settings#account", config.WEB_URL).href,
    );
  }, 20_000);
  test("users can enroll, confirm, and remove an authenticator", async () => {
    expect((await (await request("/api/account/mfa")).json()).enrolled).toBe(false);
    const enrollment = await (await request("/api/account/mfa", 0, {})).json();

    expect(enrollment.qrCode.startsWith("data:image/png;base64,")).toBe(true);
    expect(enrollment.secret).toBe("JBSWY3DPEHPK3PXP");
    expect((await request("/api/account/mfa", 0, {})).status).toBe(409);
    expect(
      (
        await request("/api/account/mfa/verify", 0, {
          factorId: enrollment.factorId,
          challengeId: enrollment.challengeId,
          code: "000000",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/account/mfa/verify", 1, {
          factorId: enrollment.factorId,
          challengeId: enrollment.challengeId,
          code: "123456",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await (
          await request("/api/account/mfa/verify", 0, {
            factorId: enrollment.factorId,
            challengeId: enrollment.challengeId,
            code: "123456",
          })
        ).json()
      ).enrolled,
    ).toBe(true);
    expect((await (await request("/api/account/mfa")).json()).enrolled).toBe(true);
    expect((await (await request("/api/account/mfa/remove", 0, {})).json()).enrolled).toBe(false);
    expect((await (await request("/api/account/mfa")).json()).enrolled).toBe(false);
  });
  test("logout invalidates the local session", async () => {
    expect((await request("/auth/logout", 0, {})).status).toBe(200);
    expect((await request("/api/files")).status).toBe(401);
    available = false;
    expect((await request("/api/files", 1)).status).toBe(401);
  });
});

describe("Polar billing boundaries", () => {
  test("limits serialize, customer state refreshes, and signed webhooks revoke access", async () => {
    available = true;
    const { Webhook } = await import("standardwebhooks");
    const { mcpUsage, workspaceBilling } = await import("../src/db/schema");
    const { weekStart } = await import("../src/billing");

    const user = {
      id: `test_billing_${ulid()}`,
      name: "Billing",
      email: "billing@example.invalid",
    };

    identities.push(user);
    const secret = `whsec_${Buffer.from("test-billing-secret".repeat(2)).toString("base64")}`;

    const billingConfig = {
      ...config,
      POLAR_ACCESS_TOKEN: "test",
      POLAR_WEBHOOK_SECRET: secret,
      POLAR_PRO_PRODUCT_ID: "14e2d2c3-fa2d-4b26-a686-30efbebbcf1b",
      POLAR_ORGANIZATION_ID: "be8119a2-23a8-4edf-ab4c-5edd1ba71ccf",
    };

    let pro = false;
    let wrongOrganization = false;
    let checkoutInput: unknown;

    const instance = createApp(db, memoryRevisionStorage().storage, billingConfig, provider, {
      async state(workspaceId) {
        return {
          id: "customer",
          organizationId: wrongOrganization ? "other" : billingConfig.POLAR_ORGANIZATION_ID,
          externalId: workspaceId,
          activeSubscriptions: pro
            ? [
                {
                  id: "sub",
                  productId: billingConfig.POLAR_PRO_PRODUCT_ID,
                  status: "active",
                  currentPeriodEnd: new Date(Date.now() + 86400_000),
                  endsAt: null,
                },
              ]
            : [],
        };
      },
      async checkout(workspaceId, identity, seats) {
        checkoutInput = { workspaceId, identity, seats };

        return "https://polar.sh/checkout/test";
      },
      async portal() {
        return "https://polar.sh/portal/test";
      },
    });

    const token = await instance.auth.createSession(user, user.id);

    const call = (path: string, body?: unknown) =>
      instance.app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: config.WEB_URL,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const me = await (await call("/api/me")).json();
    const workspaceId = me.workspace.id;
    expect((await (await call("/api/billing")).json()).plan).toBe("free");
    expect(
      (await call("/api/billing/checkout", { seats: 2, workspaceId: "attacker" })).status,
    ).toBe(200);
    expect(checkoutInput).toEqual({ workspaceId, identity: user, seats: 2 });
    expect((await call("/api/billing/checkout", { seats: 0 })).status).toBe(400);

    const creates = await Promise.all(
      Array.from({ length: 8 }, () => call("/api/files", snapshot)),
    );

    expect(creates.filter((response) => response.status === 201)).toHaveLength(5);
    expect(creates.filter((response) => response.status === 403)).toHaveLength(3);
    const activeFiles = await (await call("/api/files")).json();
    const firstId = activeFiles.files[0].id;
    const secondId = activeFiles.files[1].id;
    expect((await call(`/api/files/${firstId}/archive`, { archived: true })).status).toBe(200);
    const replacement = await call("/api/files", snapshot);
    expect(replacement.status).toBe(201);
    expect((await call(`/api/files/${firstId}/archive`, { archived: false })).status).toBe(403);
    expect((await call(`/api/files/${secondId}/archive`, { archived: false })).status).toBe(200);
    expect((await call(`/api/files/${secondId}/archive`, { archived: true })).status).toBe(200);

    const restores = await Promise.all(
      [firstId, secondId].map((id) => call(`/api/files/${id}/archive`, { archived: false })),
    );

    expect(restores.filter((response) => response.status === 200)).toHaveLength(1);
    expect(restores.filter((response) => response.status === 403)).toHaveLength(1);
    await db.insert(mcpUsage).values({ workspaceId, week: weekStart(), calls: 299 });

    const consumes = await Promise.all(
      Array.from({ length: 4 }, () => call("/api/billing/mcp/consume", {})),
    );

    expect(consumes.filter((response) => response.status === 200)).toHaveLength(1);
    expect(consumes.filter((response) => response.status === 429)).toHaveLength(3);
    await expect(instance.billing.consumeMcp(workspaceId, true)).rejects.toThrow("requires Pro");
    await db
      .update(mcpUsage)
      .set({ week: new Date(0) })
      .where(eq(mcpUsage.workspaceId, workspaceId));
    expect((await (await call("/api/billing/mcp/consume", {})).json()).remaining).toBe(299);
    pro = true;
    const proStatus = await (await call("/api/billing/refresh", {})).json();
    expect(proStatus.plan).toBe("pro");
    expect(proStatus.limits.designFiles).toBeNull();
    expect((await call("/api/billing/checkout", { seats: 1 })).status).toBe(409);

    // Seed beyond the former Pro cap, then exercise both ways to add an active file.
    await db.insert(files).values(
      Array.from({ length: 250 }, () => ({
        id: ulid(),
        workspaceId,
        name: "Pro capacity fixture",
        revision: 0,
        objectKey: `${config.S3_PREFIX}/capacity/${ulid()}.json.gz`,
        nodeCount: 0,
        preview: [],
      })),
    );
    expect((await call("/api/files", snapshot)).status).toBe(201);
    expect((await call(`/api/files/${firstId}/archive`, { archived: true })).status).toBe(200);
    expect((await call(`/api/files/${firstId}/archive`, { archived: false })).status).toBe(200);
    expect((await instance.billing.consumeMcp(workspaceId, true)).enabled).toBe(true);
    pro = false;

    const event = JSON.stringify({
      type: "customer.state_changed",
      data: { external_id: workspaceId, organization_id: billingConfig.POLAR_ORGANIZATION_ID },
    });

    const now = new Date();

    const headers = {
      "webhook-id": "event_test",
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign("event_test", now, event),
      "Content-Type": "application/json",
    };

    expect(
      (await instance.app.request("/api/billing/webhook", { method: "POST", body: event })).status,
    ).toBe(403);

    // Concurrent retries are harmless and need no browser session or Origin.
    const deliveries = await Promise.all(
      [0, 1].map(() =>
        instance.app.request("/api/billing/webhook", { method: "POST", headers, body: event }),
      ),
    );

    expect(deliveries.map((response) => response.status)).toEqual([200, 200]);

    expect((await (await call("/api/billing")).json()).plan).toBe("free");
    expect((await call("/api/files", snapshot)).status).toBe(403);
    wrongOrganization = true;
    expect((await call("/api/billing/refresh", {})).status).toBe(502);
    // No cached entitlement is overwritten on upstream mismatch.
    expect(
      (
        await db
          .select()
          .from(workspaceBilling)
          .where(eq(workspaceBilling.workspaceId, workspaceId))
      )[0].proUntil,
    ).toBeNull();
  }, 30_000);
});

describe("workspace seats and invitations", () => {
  test("reserves the final seat atomically and enforces membership, ownership, and downgrades", async () => {
    available = true;

    const people = ["owner", "member", "other"].map((name) => ({
      id: `test_team_${ulid()}`,
      name,
      email: `${ulid()}@example.invalid`,
      emailVerified: true,
    }));

    identities.push(...people);
    let seats = 2;
    let deliveryFails = false;
    let deliveries = 0;

    const billingConfig = {
      ...config,
      POLAR_ACCESS_TOKEN: "test",
      POLAR_WEBHOOK_SECRET: "test",
      POLAR_PRO_PRODUCT_ID: "14e2d2c3-fa2d-4b26-a686-30efbebbcf1b",
      POLAR_ORGANIZATION_ID: "be8119a2-23a8-4edf-ab4c-5edd1ba71ccf",
    };

    const instance = createApp(
      db,
      storage,
      billingConfig,
      {
        ...provider,
        async invite() {
          if (deliveryFails) throw new Error("Delivery failed");
          deliveries++;

          return { id: ulid(), expiresAt: new Date(Date.now() + 86400_000) };
        },
        async acceptInvite() {},
        async revokeInvite() {},
        async removeMember() {},
      },
      {
        async state(workspaceId) {
          return {
            id: "customer",
            organizationId: "be8119a2-23a8-4edf-ab4c-5edd1ba71ccf",
            externalId: workspaceId,
            activeSubscriptions: seats
              ? [
                  {
                    id: "sub",
                    productId: "14e2d2c3-fa2d-4b26-a686-30efbebbcf1b",
                    status: "active",
                    seats,
                    endsAt: null,
                    currentPeriodEnd: new Date(Date.now() + 86400_000),
                  },
                ]
              : [],
          };
        },
        async checkout() {
          return "https://polar.sh/checkout/test";
        },
        async portal() {
          return "https://polar.sh/portal/test";
        },
      },
    );

    const teamTokens = await Promise.all(
      people.map((person) => instance.auth.createSession(person, person.id)),
    );

    const call = (path: string, person = 0, body?: unknown) =>
      instance.app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${teamTokens[person]}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const ownerWorkspace = (await (await call("/api/me")).json()).workspace.id;
    expect((await call("/api/workspaces/switch", 1, { id: ownerWorkspace })).status).toBe(403);
    deliveryFails = true;
    expect((await call("/api/workspaces/invitations", 0, { email: people[1].email })).status).toBe(
      500,
    );
    expect((await (await call("/api/workspaces/members")).json()).reserved).toBe(0);
    deliveryFails = false;

    const invites = await Promise.all(
      [1, 2].map((index) => call("/api/workspaces/invitations", 0, { email: people[index].email })),
    );

    expect(invites.map((response) => response.status).toSorted()).toEqual([201, 409]);
    expect(deliveries).toBe(1);
    const invitedIndex = invites[0].status === 201 ? 1 : 2;
    const otherIndex = invitedIndex === 1 ? 2 : 1;
    const invitation = await invites[invitedIndex - 1].json();
    const acceptPath = `/api/workspaces/invitations/${invitation.id}/accept`;
    expect((await call(acceptPath, otherIndex, {})).status).toBe(404);
    people[invitedIndex].emailVerified = false;
    expect((await call(acceptPath, invitedIndex, {})).status).toBe(403);
    people[invitedIndex].emailVerified = true;
    expect((await (await call("/api/workspaces", invitedIndex)).json()).invitations).toHaveLength(
      1,
    );
    seats = 1;
    expect((await call(acceptPath, invitedIndex, {})).status).toBe(409);
    seats = 2;
    expect((await call(acceptPath, invitedIndex, {})).status).toBe(200);
    expect((await call(acceptPath, invitedIndex, {})).status).toBe(404);
    expect(
      (await call("/api/workspaces/switch", invitedIndex, { id: ownerWorkspace })).status,
    ).toBe(200);
    expect((await (await call("/api/files", invitedIndex)).json()).workspace.id).toBe(
      ownerWorkspace,
    );
    expect((await call("/api/billing/portal", invitedIndex, {})).status).toBe(403);
    expect((await call("/api/billing/checkout", invitedIndex, { seats: 3 })).status).toBe(403);
    expect(
      (await call("/api/workspaces/invitations", invitedIndex, { email: people[otherIndex].email }))
        .status,
    ).toBe(403);
    expect(
      (await call("/api/workspaces/members/remove", invitedIndex, { userId: people[0].id })).status,
    ).toBe(403);
    expect((await call("/api/workspaces/members/remove", 0, { userId: people[0].id })).status).toBe(
      400,
    );
    seats = 0;
    await call("/api/billing/refresh", 0, {});
    expect(
      (await call("/api/workspaces/switch", invitedIndex, { id: ownerWorkspace })).status,
    ).toBe(403);
    expect((await call("/api/files", invitedIndex)).status).toBe(403);
    expect((await (await call("/api/me", invitedIndex)).json()).workspace.id).not.toBe(
      ownerWorkspace,
    );
    expect(
      (await call("/api/workspaces/invitations", 0, { email: people[otherIndex].email })).status,
    ).toBe(409);
    seats = 2;
    await call("/api/billing/refresh", 0, {});
    expect(
      (await call("/api/workspaces/members/remove", 0, { userId: people[invitedIndex].id })).status,
    ).toBe(200);
    expect(
      (await call("/api/workspaces/switch", invitedIndex, { id: ownerWorkspace })).status,
    ).toBe(403);

    const next = await (
      await call("/api/workspaces/invitations", 0, { email: people[otherIndex].email })
    ).json();

    expect((await call(`/api/workspaces/invitations/${next.id}/revoke`, 0, {})).status).toBe(200);
    expect(
      (await call(`/api/workspaces/invitations/${next.id}/accept`, otherIndex, {})).status,
    ).toBe(404);
    expect((await (await call("/api/workspaces/members")).json()).reserved).toBe(0);
  }, 60_000);
});
