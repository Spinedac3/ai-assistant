CREATE TABLE "export_files" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"file_name" varchar(150) NOT NULL,
	"rows" integer NOT NULL,
	"bytes" integer NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "export_files_expires_idx" ON "export_files" USING btree ("expires_at");