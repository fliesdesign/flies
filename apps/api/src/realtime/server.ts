import { grantSchema, secureServiceUrl, type SyncGrant, type SyncTicket } from "@flies/sync";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import type { authService } from "../auth";
import type { billingService } from "../billing";
import type { Database } from "../db/client";
import { files as fileTable } from "../db/schema";
import type { fileService, Identity } from "../files";
import type { teamService } from "../teams";
import { commitSchema, type Commit } from "./protocol";

function makeGrant(
  fileId: string,
  workspaceId: string,
  user: Identity,
  sessionHash: string,
  origin: string,
): SyncGrant {
  return v.parse(grantSchema, {
    fileId,
    workspaceId,
    user: { id: user.id, name: user.name.slice(0, 100) },
    sessionHash,
    origin,
  });
}

/** The API owns authorization and durable writes; Cloudflare owns live connections. */
export function createRealtime({
  db,
  auth,
  teams,
  files,
  billing,
  origins,
  sync,
}: {
  db: Database;
  auth: ReturnType<typeof authService>;
  teams: ReturnType<typeof teamService>;
  files: ReturnType<typeof fileService>;
  billing: ReturnType<typeof billingService>;
  origins: Set<string>;
  sync: { url: string; secret: string };
}) {
  const serverUrl = secureServiceUrl(sync.url);

  async function request<T>(action: "ticket" | "changed" | "limit", body: unknown): Promise<T> {
    const response = await fetch(`${serverUrl}/internal/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sync.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok)
      throw new HTTPException(response.status === 429 ? 429 : 503, {
        message: "Sync service is unavailable. Retry shortly.",
      });

    return response.json() as Promise<T>;
  }

  async function authorize(grant: SyncGrant) {
    const session = await auth.validateSession(grant.sessionHash);
    if (!session || session.user.id !== grant.user.id)
      throw new HTTPException(401, { message: "Sign in again to reconnect." });
    if (!(await teams.access(grant.workspaceId, session.user.id)))
      throw new HTTPException(403, { message: "Workspace access was removed." });

    const [file] = await db
      .select({ revision: fileTable.revision })
      .from(fileTable)
      .where(
        and(
          eq(fileTable.id, grant.fileId),
          eq(fileTable.workspaceId, grant.workspaceId),
          eq(fileTable.archived, false),
        ),
      );

    if (!file) throw new HTTPException(404, { message: "This file is no longer available." });

    return { revision: file.revision };
  }

  async function changed(workspaceId: string, fileId: string, revision: number) {
    await request("changed", { workspaceId, fileId, revision });
  }

  async function commit(grant: SyncGrant, input: Commit) {
    await authorize(grant);

    const result = (await files.write(
      grant.workspaceId,
      grant.user.id,
      { name: "", nodes: [], theme: { tokens: [] } },
      { id: grant.fileId, revision: -1, mutationId: input.mutationId, delta: input.delta },
      await billing.entitlements(grant.workspaceId),
    )) as { revision: number };

    return { revision: result.revision, mutationId: input.mutationId };
  }

  return {
    authorize,
    commit,
    changed,
    async ticket(
      fileId: string,
      workspaceId: string,
      user: Identity,
      sessionHash: string,
      origin: string,
    ): Promise<SyncTicket> {
      if (!origins.has(origin)) throw new HTTPException(403);
      const access = makeGrant(fileId, workspaceId, user, sessionHash, origin);
      await authorize(access);
      const result = await request<{ ticket: string }>("ticket", access);

      return { enabled: true, ticket: result.ticket, socketUrl: `${serverUrl}/api/sync/socket` };
    },
    async change(
      fileId: string,
      workspaceId: string,
      user: Identity,
      sessionHash: string,
      input: unknown,
    ) {
      const access = makeGrant(fileId, workspaceId, user, sessionHash, serverUrl);
      await authorize(access);
      if (!(await request<{ allowed: boolean }>("limit", { userId: user.id })).allowed)
        throw new HTTPException(429, { message: "Too many edits. Retry shortly." });
      const result = await commit(access, v.parse(commitSchema, input));
      // A notification outage must not turn an already-persisted write into a failure.
      // Room alarms reconcile the database revision when the service recovers.
      await changed(workspaceId, fileId, result.revision).catch(() => {});

      return result;
    },
  };
}
