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
CREATE TABLE "sources" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(50) NOT NULL,
	"name" varchar(200) NOT NULL,
	"engine" varchar(10) NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer NOT NULL,
	"database" varchar(128) NOT NULL,
	"username" varchar(128) NOT NULL,
	"sealed_password" text NOT NULL,
	"time_zone" varchar(64),
	"tls" boolean DEFAULT true NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "export_files_expires_idx" ON "export_files" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_code_unique" ON "sources" USING btree ("code");