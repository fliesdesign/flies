import { and, asc, eq, gt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ulid } from "ulid";

import type { billingService } from "./billing";
import type { Database } from "./db/client";
import {
  sessions,
  users,
  workspaceBilling,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "./db/schema";
import type { Identity } from "./files";
import type { OrganizationProvider } from "./organizations";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function roster(tx: Database | Transaction, workspaceId: string) {
  const members = await tx
    .select({ id: workspaceMembers.id, userId: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id));

  const invitations = await tx
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        gt(workspaceInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(workspaceInvitations.createdAt), asc(workspaceInvitations.id));

  return { members, invitations };
}

// Call after refreshing billing and locking the workspace. Read the cache under
// that same lock so competing invitations cannot reserve the final seat twice.
async function capacity(tx: Transaction, workspaceId: string, enabled: boolean) {
  if (!enabled) return null;

  const [cached] = await tx
    .select()
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, workspaceId));

  return cached?.proUntil && cached.proUntil > new Date() ? cached.seats : 1;
}

export function teamService(
  db: Database,
  billing: ReturnType<typeof billingService>,
  provider: OrganizationProvider,
) {
  async function owner(workspaceId: string, userId: string) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace || workspace.ownerId !== userId)
      throw new HTTPException(403, {
        message: "Only the workspace owner can manage members and billing.",
      });

    return workspace;
  }

  async function access(workspaceId: string, userId: string) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) return null;
    if (workspace.ownerId === userId) return workspace;
    const { members } = await roster(db, workspaceId);
    const position = members.findIndex((member) => member.userId === userId);
    if (position < 0) return null;
    const plan = await billing.entitlements(workspaceId);
    if (plan.enabled && position >= (plan.seats ?? 1) - 1) return null;

    if (workspace.name === "My workspace") {
      const [workspaceOwner] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, workspace.ownerId));

      return { ...workspace, name: `${workspaceOwner.name}'s workspace` };
    }

    return workspace;
  }

  return {
    owner,
    access,
    async list(user: Identity) {
      const owned = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id));

      const memberships = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id));

      const joined = await Promise.all(
        memberships.map((member) => access(member.workspaceId, user.id)),
      );

      const invitations = user.emailVerified
        ? await db
            .select({
              id: workspaceInvitations.id,
              workspaceName: sql<string>`case when ${workspaces.name} = 'My workspace' then ${users.name} || ${"'s workspace"} else ${workspaces.name} end`,
              expiresAt: workspaceInvitations.expiresAt,
            })
            .from(workspaceInvitations)
            .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
            .innerJoin(users, eq(users.id, workspaces.ownerId))
            .where(
              and(
                eq(workspaceInvitations.email, user.email.toLowerCase()),
                gt(workspaceInvitations.expiresAt, new Date()),
              ),
            )
        : [];

      return {
        workspaces: [...owned, ...joined.filter((item) => item !== null)].map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          ownerId: workspace.ownerId,
        })),
        invitations,
      };
    },
    async switch(workspaceId: string, userId: string, sessionHash: string) {
      const workspace = await access(workspaceId, userId);
      if (!workspace)
        throw new HTTPException(403, {
          message: "This workspace is unavailable or has no paid seat for you.",
        });
      await db.update(sessions).set({ workspaceId }).where(eq(sessions.tokenHash, sessionHash));

      return { id: workspace.id, name: workspace.name, ownerId: workspace.ownerId };
    },
    async details(workspaceId: string, userId: string) {
      const plan = await billing.entitlements(workspaceId, true);
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      const [workspaceOwner] = await db.select().from(users).where(eq(users.id, workspace.ownerId));
      const { members, invitations } = await roster(db, workspaceId);
      const seats = plan.enabled ? (plan.seats ?? 1) : null;

      return {
        owner: workspace.ownerId === userId,
        seats,
        used: members.length + 1,
        reserved: invitations.length,
        members: [
          {
            userId: workspaceOwner.id,
            name: workspaceOwner.name,
            email: workspaceOwner.email,
            role: "owner",
            active: true,
          },
          ...members.map((member, index) => ({
            userId: member.userId,
            name: member.name,
            email: member.email,
            role: "member",
            active: seats === null || index < seats - 1,
          })),
        ],
        invitations: invitations.map(({ id, email, expiresAt }) => ({ id, email, expiresAt })),
      };
    },
    async invite(workspaceId: string, user: Identity, email: string) {
      await owner(workspaceId, user.id);
      if (!provider.invite)
        throw new HTTPException(503, { message: "Invitation delivery is unavailable." });
      const plan = await billing.entitlements(workspaceId, true);

      return db.transaction(async (tx) => {
        const [workspace] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for("update");

        const { members, invitations } = await roster(tx, workspaceId);
        if (
          email === user.email.toLowerCase() ||
          members.some((member) => member.email.toLowerCase() === email) ||
          invitations.some((invite) => invite.email === email)
        )
          throw new HTTPException(409, {
            message: "This person is already a member or has a pending invitation.",
          });
        const seats = await capacity(tx, workspaceId, plan.enabled);
        if (seats !== null && members.length + 1 + invitations.length >= seats)
          throw new HTTPException(409, {
            message:
              "All paid seats are in use. Add seats in Billing or revoke a pending invitation first.",
          });
        if (!workspace.workosOrganizationId)
          throw new HTTPException(503, { message: "Workspace setup is not complete." });
        const invitation = await provider.invite!(workspace.workosOrganizationId, email, user.id);
        await tx
          .delete(workspaceInvitations)
          .where(
            and(
              eq(workspaceInvitations.workspaceId, workspaceId),
              eq(workspaceInvitations.email, email),
            ),
          );
        const id = ulid();
        await tx.insert(workspaceInvitations).values({
          id,
          workspaceId,
          email,
          providerId: invitation.id,
          expiresAt: invitation.expiresAt,
        });

        return { id, email, expiresAt: invitation.expiresAt };
      });
    },
    async accept(id: string, user: Identity) {
      if (!user.emailVerified)
        throw new HTTPException(403, {
          message: "Verify your email before accepting an invitation.",
        });

      const [invitation] = await db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.id, id));

      if (
        !invitation ||
        invitation.email !== user.email.toLowerCase() ||
        invitation.expiresAt <= new Date()
      )
        throw new HTTPException(404, { message: "Invitation not found or expired." });
      const plan = await billing.entitlements(invitation.workspaceId, true);

      return db.transaction(async (tx) => {
        await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, invitation.workspaceId))
          .for("update");
        const { members, invitations } = await roster(tx, invitation.workspaceId);
        const position = invitations.findIndex((item) => item.id === id);
        const seats = await capacity(tx, invitation.workspaceId, plan.enabled);
        if (position < 0)
          throw new HTTPException(404, { message: "Invitation not found or expired." });
        if (seats !== null && members.length + 1 + position >= seats)
          throw new HTTPException(409, {
            message: "The workspace has no available paid seat. Ask the owner to add seats.",
          });
        if (!provider.acceptInvite)
          throw new HTTPException(503, { message: "Invitation acceptance is unavailable." });
        await provider.acceptInvite(invitation.providerId, user.id);
        await tx
          .insert(workspaceMembers)
          .values({ id: ulid(), workspaceId: invitation.workspaceId, userId: user.id });
        await tx.delete(workspaceInvitations).where(eq(workspaceInvitations.id, id));

        return { workspaceId: invitation.workspaceId };
      });
    },
    async revoke(workspaceId: string, userId: string, id: string) {
      await owner(workspaceId, userId);
      await db.transaction(async (tx) => {
        await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");

        const [invitation] = await tx
          .select()
          .from(workspaceInvitations)
          .where(
            and(eq(workspaceInvitations.id, id), eq(workspaceInvitations.workspaceId, workspaceId)),
          );

        if (!invitation) throw new HTTPException(404);
        await provider.revokeInvite?.(invitation.providerId);
        await tx.delete(workspaceInvitations).where(eq(workspaceInvitations.id, id));
      });
    },
    async remove(workspaceId: string, userId: string, memberId: string) {
      const workspace = await owner(workspaceId, userId);
      if (memberId === userId)
        throw new HTTPException(400, { message: "The workspace owner cannot be removed." });
      await db.transaction(async (tx) => {
        await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
        if (workspace.workosOrganizationId)
          await provider.removeMember?.(workspace.workosOrganizationId, memberId);
        await tx
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, memberId),
            ),
          );
      });
    },
  };
}
