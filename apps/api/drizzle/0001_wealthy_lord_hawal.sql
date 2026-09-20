CREATE TABLE "mcp_usage" (
	"workspaceId" text PRIMARY KEY NOT NULL,
	"week" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_billing" (
	"workspaceId" text PRIMARY KEY NOT NULL,
	"customerId" text,
	"subscriptionId" text,
	"proUntil" timestamp with time zone,
	"checkedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_billing" ADD CONSTRAINT "workspace_billing_workspaceId_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;