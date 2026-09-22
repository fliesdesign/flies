CREATE TABLE "revision_object_refs" (
	"revisionId" text NOT NULL,
	"objectKey" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"fileId" text NOT NULL,
	"byteLength" integer NOT NULL,
	"deleteAfter" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "revision_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"fileId" text NOT NULL,
	"prefix" text NOT NULL,
	"cursor" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revision_object_refs" ADD CONSTRAINT "revision_object_refs_revisionId_file_revisions_id_fk" FOREIGN KEY ("revisionId") REFERENCES "public"."file_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_object_refs" ADD CONSTRAINT "revision_object_refs_objectKey_revision_objects_key_fk" FOREIGN KEY ("objectKey") REFERENCES "public"."revision_objects"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_object_ref" ON "revision_object_refs" USING btree ("revisionId","objectKey");--> statement-breakpoint
CREATE INDEX "revision_object_ref_key" ON "revision_object_refs" USING btree ("objectKey");--> statement-breakpoint
CREATE INDEX "revision_objects_cleanup" ON "revision_objects" USING btree ("deleteAfter");--> statement-breakpoint
CREATE INDEX "revision_objects_file" ON "revision_objects" USING btree ("fileId");--> statement-breakpoint
CREATE INDEX "revision_uploads_created" ON "revision_uploads" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "files_object_key" ON "files" USING btree ("objectKey");--> statement-breakpoint
CREATE INDEX "revision_created_file" ON "file_revisions" USING btree ("createdAt","fileId");