import { describe, expect, test } from "bun:test";

import { Webhook } from "standardwebhooks";

import {
  assertImageLimits,
  BILLING_DISABLED,
  billingService,
  PLANS,
  proSubscription,
  verifyPolarWebhook,
  weekStart,
  type BillingState,
} from "../src/billing";
import { billingConfig } from "../src/config";
import type { Config } from "../src/config";
import type { Database } from "../src/db/client";
import type { Snapshot } from "../src/files";

const settings = {
  POLAR_ACCESS_TOKEN: "test",
  POLAR_WEBHOOK_SECRET: "test",
  POLAR_PRO_PRODUCT_ID: "14e2d2c3-fa2d-4b26-a686-30efbebbcf1b",
  POLAR_ORGANIZATION_ID: "be8119a2-23a8-4edf-ab4c-5edd1ba71ccf",
};

const snapshot = (src: string) => ({ nodes: [{ kind: "image", src }] }) as Snapshot;

describe("optional billing", () => {
  test("unset and blank environment values disable billing", () => {
    expect(billingConfig({})).toBeNull();
    expect(billingConfig({ POLAR_ACCESS_TOKEN: "", POLAR_WEBHOOK_SECRET: " " })).toBeNull();
    expect(billingConfig(settings)?.server).toBe("production");
    for (const key of Object.keys(settings))
      expect(() => billingConfig({ [key]: "test" })).toThrow("Incomplete Polar configuration");
    expect(() => billingConfig({ POLAR_SERVER: "sandbox" })).toThrow();
    expect(() => billingConfig({ ...settings, POLAR_PRO_PRODUCT_ID: "wrong" })).toThrow(
      "POLAR_PRO_PRODUCT_ID",
    );
  });
  test("disabled mode never touches Polar or billing tables and rejects checkout", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("Unexpected database access");
        },
      },
    ) as Database;

    const billing = billingService(db, {} as Config);
    expect(await billing.entitlements("any")).toEqual(BILLING_DISABLED);
    expect(await billing.consumeMcp("any", true)).toEqual({
      enabled: false,
      remaining: null,
      resetsAt: null,
    });
    expect(
      billing.checkout("any", { id: "a", name: "A", email: "a@example.com" }, 1),
    ).rejects.toThrow("Billing is disabled");
  });
  test("only an active, unexpired subscription to the configured product grants Pro", () => {
    const now = new Date("2026-09-20T12:00:00Z");

    const subscription = {
      id: "sub",
      productId: settings.POLAR_PRO_PRODUCT_ID,
      status: "active",
      currentPeriodEnd: new Date("2026-10-20T12:00:00Z"),
      endsAt: null,
    };

    const state: BillingState = {
      id: "customer",
      organizationId: settings.POLAR_ORGANIZATION_ID,
      activeSubscriptions: [subscription],
    };

    expect(proSubscription(state, settings.POLAR_PRO_PRODUCT_ID, now)?.id).toBe("sub");
    for (const change of [
      { productId: "other" },
      { status: "past_due" },
      { status: "trialing" },
      { currentPeriodEnd: now },
      { endsAt: now },
    ])
      expect(
        proSubscription(
          { ...state, activeSubscriptions: [{ ...subscription, ...change }] },
          settings.POLAR_PRO_PRODUCT_ID,
          now,
        ),
      ).toBeUndefined();
  });
  test("image caps apply to decoded bytes and disabled mode preserves old behavior", () => {
    const access = {
      enabled: true as const,
      plan: "free" as const,
      limits: { ...PLANS.free, imageUploadBytes: 3 },
    };

    expect(() =>
      assertImageLimits(snapshot("data:image/png;base64,YWJj"), access as never),
    ).not.toThrow();
    expect(() =>
      assertImageLimits(snapshot("data:image/png;base64,YWJjZA=="), access as never),
    ).toThrow("images up to");
    expect(() =>
      assertImageLimits(snapshot("data:image/png;base64,%%%="), access as never),
    ).toThrow("Invalid image");
    expect(() =>
      assertImageLimits(snapshot("https://example.com/image.png"), access as never),
    ).toThrow("embedded");
    expect(() =>
      assertImageLimits(snapshot("data:image/svg+xml,%E2%82%ACx"), access as never),
    ).toThrow("images up to");
    expect(() => assertImageLimits(snapshot("anything"), BILLING_DISABLED)).not.toThrow();
  });
  test("weekly allowance resets Monday at midnight UTC", () => {
    expect(weekStart(new Date("2026-09-20T23:59:59Z")).toISOString()).toBe(
      "2026-09-14T00:00:00.000Z",
    );
    expect(weekStart(new Date("2026-09-21T00:00:00Z")).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });
  test("standard and legacy signed webhooks work; forged, changed, and expired ones fail", () => {
    const secret = `whsec_${Buffer.from("a".repeat(32)).toString("base64")}`;
    const body = JSON.stringify({ type: "customer.state_changed", data: {} });
    const now = new Date();

    const headers = (key: string, time = now) => ({
      "webhook-id": "evt_test",
      "webhook-timestamp": String(Math.floor(time.getTime() / 1000)),
      "webhook-signature": new Webhook(key).sign("evt_test", time, body),
    });

    for (const key of [secret, Buffer.from(secret).toString("base64")]) {
      expect(verifyPolarWebhook(body, headers(key), secret)).toEqual(JSON.parse(body));
      expect(() => verifyPolarWebhook(body + " ", headers(key), secret)).toThrow("Invalid Polar");
      expect(() => verifyPolarWebhook(body, headers(key, new Date(0)), secret)).toThrow(
        "Invalid Polar",
      );
    }

    expect(() => verifyPolarWebhook(body, {}, secret)).toThrow("Invalid Polar");
  });
});
