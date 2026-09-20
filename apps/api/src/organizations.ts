import { NotFoundException, type WorkOS } from "@workos-inc/node";

import type { Identity } from "./files";

export interface OrganizationProvider {
  ensureOrganization(workspace: { id: string; name: string }, owner: Identity): Promise<string>;
}

export function workosOrganizations(workos: WorkOS): OrganizationProvider {
  return {
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
