import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull(),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
export const workspaces = pgTable(
  "workspaces",
  {
    id: text().primaryKey(),
    ownerId: text()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    workosOrganizationId: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workspace_owner").on(t.ownerId),
    uniqueIndex("workspace_workos_organization").on(t.workosOrganizationId),
  ],
);
export const files = pgTable(
  "files",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    revision: integer().notNull(),
    objectKey: text().notNull(),
    nodeCount: integer().notNull(),
    preview: jsonb().$type<Record<string, unknown>[]>().notNull(),
    archived: boolean().default(false).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("files_workspace_updated").on(t.workspaceId, t.updatedAt),
    index("files_object_key").on(t.objectKey),
    check("file_revision_nonnegative", sql`${t.revision} >= 0`),
  ],
);
export const revisions = pgTable(
  "file_revisions",
  {
    id: text().primaryKey(),
    fileId: text()
      .notNull()
      .references(() => files.id),
    number: integer().notNull(),
    objectKey: text().notNull(),
    sha256: text().notNull(),
    byteLength: integer().notNull(),
    createdBy: text()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("file_revision_number").on(t.fileId, t.number),
    uniqueIndex("revision_object_key").on(t.objectKey),
    index("revision_created_file").on(t.createdAt, t.fileId),
  ],
);
// Objects are shared by revisions of one file. Unreferenced objects remain here
// until S3 deletion succeeds, so failures are retried after a restart.
export const revisionObjects = pgTable(
  "revision_objects",
  {
    key: text().primaryKey(),
    fileId: text().notNull(),
    byteLength: integer().notNull(),
    deleteAfter: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("revision_objects_cleanup").on(t.deleteAfter),
    index("revision_objects_file").on(t.fileId),
  ],
);
export const revisionObjectRefs = pgTable(
  "revision_object_refs",
  {
    revisionId: text()
      .notNull()
      .references(() => revisions.id, { onDelete: "cascade" }),
    objectKey: text()
      .notNull()
      .references(() => revisionObjects.key),
  },
  (t) => [
    uniqueIndex("revision_object_ref").on(t.revisionId, t.objectKey),
    index("revision_object_ref_key").on(t.objectKey),
  ],
);
// Committed before opening the save transaction. If the process dies during an
// upload, this durable marker lets cleanup reconcile just that file's directory.
export const revisionUploads = pgTable(
  "revision_uploads",
  {
    id: text().primaryKey(),
    fileId: text().notNull(),
    prefix: text().notNull(),
    cursor: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("revision_uploads_created").on(t.createdAt)],
);
export const sessions = pgTable("sessions", {
  tokenHash: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id),
  workspaceId: text().references(() => workspaces.id, { onDelete: "set null" }),
  sealedSession: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
export const loginAttempts = pgTable("login_attempts", {
  state: text().primaryKey(),
  verifier: text().notNull(),
  browserHash: text().notNull(),
  desktopChallenge: text(),
  returnPath: text().notNull().default("/recents"),
  sessionToken: text(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const workspaceBilling = pgTable("workspace_billing", {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  customerId: text(),
  subscriptionId: text(),
  seats: integer().notNull().default(1),
  proUntil: timestamp({ withTimezone: true }),
  checkedAt: timestamp({ withTimezone: true }).notNull(),
});

export const mcpUsage = pgTable("mcp_usage", {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  week: timestamp({ withTimezone: true }).notNull(),
  calls: integer().notNull().default(0),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workspace_member_user").on(t.workspaceId, t.userId)],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text().notNull(),
    providerId: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workspace_invitation_email").on(t.workspaceId, t.email)],
);
