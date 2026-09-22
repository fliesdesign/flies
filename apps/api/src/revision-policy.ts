import { HTTPException } from "hono/http-exception";
import { decodeTime } from "ulid";

import type { Entitlements } from "./billing";

export const FREE_RETENTION_MS = 60 * 60_000;
export const PRO_RETENTION_MS = 7 * 24 * FREE_RETENTION_MS;
export const OBJECT_DELETE_GRACE_MS = 5 * 60_000;
export const CLEANUP_INTERVAL_MS = 60_000;

export function revisionRetention(access: Entitlements) {
  return access.enabled && access.plan === "free" ? FREE_RETENTION_MS : PRO_RETENTION_MS;
}

// Once history expires, replaying its delta could silently apply the same edit
// twice. Existing mutations are looked up before this bounded retry check.
export function assertFreshMutation(id: string, access: Entitlements, now = Date.now()) {
  let timestamp: number;

  try {
    timestamp = decodeTime(id);
  } catch {
    throw new HTTPException(400, { message: "New save operations require a ULID mutationId." });
  }

  if (timestamp <= now - revisionRetention(access) || timestamp > now + OBJECT_DELETE_GRACE_MS)
    throw new HTTPException(409, {
      message:
        "This save operation expired. Reopen the file before retrying; your local edits are still in this tab.",
    });
}
