import { Polar } from "@polar-sh/sdk";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { Webhook } from "standardwebhooks";
import * as v from "valibot";

import { billingConfig, type Config } from "./config";
import type { Database } from "./db/client";
import { mcpUsage, workspaceBilling, workspaces } from "./db/schema";
import type { Identity, Snapshot } from "./files";

export const PLANS = {
  free: {
    designFiles: 5,
    imageUploadBytes: 30_000_000,
    mcpCallsPerWeek: 300,
    publicMcp: false,
    teamWorkspace: false,
    commercialUse: false,
    shareLinks: false,
  },
  pro: {
    designFiles: 250,
    imageUploadBytes: 250_000_000,
    mcpCallsPerWeek: 500_000,
    publicMcp: true,
    teamWorkspace: true,
    commercialUse: true,
    shareLinks: true,
  },
} as const;
export type Plan = keyof typeof PLANS;
export type Entitlements =
  | { enabled: false; plan: null; limits: null }
  | { enabled: true; plan: Plan; limits: (typeof PLANS)[Plan]; seats?: number };
export const BILLING_DISABLED: Entitlements = { enabled: false, plan: null, limits: null };

export type BillingState = {
  id: string;
  organizationId: string;
  externalId?: string | null;
  activeSubscriptions: {
    id: string;
    productId: string;
    status: string;
    currentPeriodEnd: Date;
    endsAt: Date | null;
    seats?: number | null;
  }[];
};
export interface BillingProvider {
  state(workspaceId: string): Promise<BillingState | null>;
  checkout(workspaceId: string, user: Identity, seats: number): Promise<string>;
  portal(workspaceId: string): Promise<string>;
}

export function polarProvider(
  config: NonNullable<ReturnType<typeof billingConfig>>,
  webUrl: string,
  polar = new Polar({ accessToken: config.accessToken, server: config.server }),
): BillingProvider {
  return {
    async state(workspaceId) {
      try {
        const state = await polar.customers.getStateExternal(
          { externalId: workspaceId },
          { timeoutMs: 8000 },
        );

        const sub = proSubscription(state, config.productId);

        if (sub) {
          const detail = await polar.subscriptions.get({ id: sub.id }, { timeoutMs: 8000 });

          return {
            ...state,
            activeSubscriptions: state.activeSubscriptions.map((item) =>
              item.id === sub.id ? { ...item, seats: detail.seats } : item,
            ),
          };
        }

        return state;
      } catch (error) {
        if (error instanceof ResourceNotFound) return null;
        throw error;
      }
    },
    async checkout(workspaceId, user, seats) {
      const checkout = await polar.checkouts.create({
        products: [config.productId],
        externalCustomerId: workspaceId,
        customerEmail: user.email,
        customerName: user.name,
        seats,
        successUrl: `${webUrl}/recents?billing=success`,
        returnUrl: `${webUrl}/recents`,
        metadata: { workspace_id: workspaceId },
      });

      return checkout.url;
    },
    async portal(workspaceId) {
      const customer = await polar.customers.getExternal(
        { externalId: workspaceId },
        { timeoutMs: 8000 },
      );

      if (customer.organizationId !== config.organizationId || customer.externalId !== workspaceId)
        throw new HTTPException(502, {
          message: "Billing customer does not match this workspace.",
        });

      let memberId: string | undefined;

      if (customer.type === "team") {
        // The route authorizes the workspace owner before requesting this session.
        // Polar team customers require an explicit owner member to manage billing.
        const members = await polar.members.listMembers(
          { customerId: customer.id, role: "owner", limit: 1 },
          { timeoutMs: 8000 },
        );

        const owner = members.result.items.find(
          (member) => member.customerId === customer.id && member.role === "owner",
        );

        if (!owner)
          throw new HTTPException(409, {
            message: "Billing account has no owner. Contact support to restore billing access.",
          });
        memberId = owner.id;
      }

      const session = await polar.customerSessions.create(
        { customerId: customer.id, memberId, returnUrl: `${webUrl}/recents` },
        { timeoutMs: 8000 },
      );

      return session.customerPortalUrl;
    },
  };
}

export function proSubscription(state: BillingState | null, productId: string, now = new Date()) {
  return state?.activeSubscriptions.find(
    (sub) =>
      sub.productId === productId &&
      sub.status === "active" &&
      sub.currentPeriodEnd > now &&
      (!sub.endsAt || sub.endsAt > now),
  );
}

export function weekStart(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

  return start;
}

export function assertImageLimits(snapshot: Snapshot, entitlements: Entitlements) {
  if (!entitlements.enabled) return;

  for (const node of snapshot.nodes) {
    if (node.kind !== "image" && node.kind !== "svg") continue;
    const comma = node.src.indexOf(",");
    if (!node.src.startsWith("data:") || comma < 0)
      throw new HTTPException(400, { message: "Images must be embedded data URLs." });
    const header = node.src.slice(0, comma);
    const payload = node.src.slice(comma + 1);
    let bytes: number;

    if (header.endsWith(";base64")) {
      if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
        throw new HTTPException(400, { message: "Invalid image encoding." });
      bytes =
        (payload.length * 3) / 4 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
    } else {
      try {
        bytes = new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
      } catch {
        throw new HTTPException(400, { message: "Invalid image encoding." });
      }
    }

    if (bytes > entitlements.limits.imageUploadBytes)
      throw new HTTPException(413, {
        message: `Your ${entitlements.plan} plan allows images up to ${entitlements.limits.imageUploadBytes / 1_000_000} MB.`,
      });
  }
}

// Current Polar secrets use Standard Webhooks; older endpoints used the whole
// secret as a UTF-8 HMAC key. Both verifiers enforce signatures and timestamp age.
export function verifyPolarWebhook(
  body: string,
  headers: Record<string, string>,
  secret: string,
): unknown {
  for (const key of [secret, Buffer.from(secret).toString("base64")]) {
    try {
      return new Webhook(key).verify(body, headers);
    } catch {
      /* Try the legacy key. */
    }
  }

  throw new HTTPException(403, { message: "Invalid Polar webhook signature." });
}

export function billingService(db: Database, config: Config, injected?: BillingProvider) {
  const settings = billingConfig(config);

  const provider = settings
    ? (injected ?? polarProvider(settings, config.WEB_URL.replace(/\/$/, "")))
    : null;

  function requireBilling() {
    if (!provider || !settings) throw new HTTPException(503, { message: "Billing is disabled." });

    return provider;
  }

  async function entitlements(workspaceId: string, refresh = false): Promise<Entitlements> {
    if (!settings || !provider) return BILLING_DISABLED;

    return db.transaction(async (tx) => {
      // Also serializes webhook invalidation, avoiding stale cache writes.
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");

      if (!workspace) throw new HTTPException(404, { message: "Workspace not found." });

      let [cached] = await tx
        .select()
        .from(workspaceBilling)
        .where(eq(workspaceBilling.workspaceId, workspaceId));

      if (refresh || !cached || Date.now() - cached.checkedAt.getTime() >= 60_000) {
        const state = await provider.state(workspaceId);
        if (
          state &&
          (state.organizationId !== settings.organizationId || state.externalId !== workspaceId)
        )
          throw new HTTPException(502, {
            message: "Billing customer does not match this workspace.",
          });
        const sub = proSubscription(state, settings.productId);

        const values = {
          workspaceId,
          customerId: state?.id ?? null,
          subscriptionId: sub?.id ?? null,
          seats: sub && Number.isSafeInteger(sub.seats) && sub.seats! > 0 ? sub.seats! : 1,
          proUntil: sub
            ? new Date(Math.min(sub.currentPeriodEnd.getTime(), sub.endsAt?.getTime() ?? Infinity))
            : null,
          checkedAt: new Date(),
        };

        [cached] = await tx
          .insert(workspaceBilling)
          .values(values)
          .onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: values })
          .returning();
      }

      const plan = cached.proUntil && cached.proUntil.getTime() > Date.now() ? "pro" : "free";

      return { enabled: true, plan, limits: PLANS[plan], seats: plan === "pro" ? cached.seats : 1 };
    });
  }

  return {
    entitlements,
    async checkout(workspaceId: string, user: Identity, seats: number) {
      const gateway = requireBilling();
      const current = await entitlements(workspaceId, true);
      if (current.plan === "pro")
        throw new HTTPException(409, {
          message: "Use the billing portal to manage your existing subscription.",
        });

      return gateway.checkout(workspaceId, user, seats);
    },
    async portal(workspaceId: string) {
      return requireBilling().portal(workspaceId);
    },
    async webhook(body: string, headers: Record<string, string>) {
      requireBilling();

      const event = v.parse(
        v.object({ type: v.string(), data: v.unknown() }),
        verifyPolarWebhook(body, headers, settings!.webhookSecret),
      );

      if (event.type !== "customer.state_changed") return;

      const state = v.parse(
        v.object({ organization_id: v.string(), external_id: v.nullable(v.string()) }),
        event.data,
      );

      if (state.organization_id !== settings!.organizationId || !state.external_id) return;
      const workspaceId = state.external_id;
      await db.transaction(async (tx) => {
        await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
        await tx
          .update(workspaceBilling)
          .set({ checkedAt: new Date(0) })
          .where(eq(workspaceBilling.workspaceId, workspaceId));
      });
      // Refetch authoritative state on next use; duplicate or out-of-order events
      // cannot re-grant revoked access or overwrite a newer subscription.
    },
    async consumeMcp(workspaceId: string, publicAccess: boolean) {
      const access = await entitlements(workspaceId);
      if (!access.enabled) return { enabled: false, remaining: null, resetsAt: null };
      if (publicAccess && !access.limits.publicMcp)
        throw new HTTPException(403, { message: "Public MCP access requires Pro." });
      const week = weekStart();

      const [usage] = await db
        .insert(mcpUsage)
        .values({ workspaceId, week, calls: 1 })
        .onConflictDoUpdate({
          target: mcpUsage.workspaceId,
          set: {
            week,
            calls: sql`case when ${mcpUsage.week} = ${week} then ${mcpUsage.calls} + 1 else 1 end`,
          },
          setWhere: sql`${mcpUsage.week} <> ${week} or ${mcpUsage.calls} < ${access.limits.mcpCallsPerWeek}`,
        })
        .returning();

      if (!usage) throw new HTTPException(429, { message: "Weekly MCP call limit reached." });

      return {
        enabled: true,
        remaining: access.limits.mcpCallsPerWeek - usage.calls,
        resetsAt: new Date(week.getTime() + 7 * 86400_000).toISOString(),
      };
    },
  };
}
