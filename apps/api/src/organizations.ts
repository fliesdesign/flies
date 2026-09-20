import { NotFoundException, type WorkOS } from "@workos-inc/node";

import type { Identity } from "./files";

export interface OrganizationProvider {
  invite?(
    organizationId: string,
    email: string,
    inviterId: string,
  ): Promise<{ id: string; expiresAt: Date }>;
  acceptInvite?(invitationId: string, userId: string): Promise<void>;
  revokeInvite?(invitationId: string): Promise<void>;
  removeMember?(organizationId: string, userId: string): Promise<void>;
  ensureOrganization(workspace: { id: string; name: string }, owner: Identity): Promise<string>;
}

export function workosOrganizations(workos: WorkOS): OrganizationProvider {
  return {
    async invite(organizationId, email, inviterUserId) {
      const invitation = await workos.userManagement.sendInvitation({
        organizationId,
        email,
        inviterUserId,
        expiresInDays: 7,
      });

      return { id: invitation.id, expiresAt: new Date(invitation.expiresAt) };
    },
    async acceptInvite(id, userId) {
      const invitation = await workos.userManagement.getInvitation(id);
      if (invitation.state === "pending") await workos.userManagement.acceptInvitation(id);
      else if (invitation.state !== "accepted" || invitation.acceptedUserId !== userId)
        throw new Error("Invitation is not available");

      const memberships = await workos.userManagement.listOrganizationMemberships({
        organizationId: invitation.organizationId!,
        userId,
      });

      if (!memberships.data.some((member) => member.status === "active")) {
        await workos.userManagement.createOrganizationMembership({
          organizationId: invitation.organizationId!,
          userId,
        });
      }
    },
    async revokeInvite(id) {
      const invitation = await workos.userManagement.getInvitation(id);
      if (invitation.state === "pending") await workos.userManagement.revokeInvitation(id);
    },
    async removeMember(organizationId, userId) {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        organizationId,
        userId,
      });

      await Promise.all(
        memberships.data.map((membership) =>
          workos.userManagement.deleteOrganizationMembership(membership.id),
        ),
      );
    },
    async ensureOrganization(workspace, owner) {
      // A committed workspace ID survives failed provisioning and database retries.
      let organization;

      try {
        organization = await workos.organizations.getOrganizationByExternalId(workspace.id);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        organization = await workos.organizations.createOrganization(
          {
            name: workspace.name === "My workspace" ? `${owner.name}'s workspace` : workspace.name,
            externalId: workspace.id,
            metadata: { workspaceId: workspace.id, ownerId: owner.id },
          },
          { idempotencyKey: `flies-workspace-${workspace.id}` },
        );
      }

      const options = { organizationId: organization.id, userId: owner.id };
      const memberships = await workos.userManagement.listOrganizationMemberships(options);
      const membership = memberships.data[0];
      if (membership && membership.status !== "active")
        throw new Error("Workspace owner membership is not active");
      if (!membership) await workos.userManagement.createOrganizationMembership(options);

      return organization.id;
    },
  };
}
