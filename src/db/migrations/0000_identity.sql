CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer,
	"level" varchar(10) DEFAULT 'info' NOT NULL,
	"event_code" varchar(80) NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"system_code" varchar(30),
	"ip_address" varchar(45),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_scopes" (
	"role_id" integer NOT NULL,
	"scope_id" integer NOT NULL,
	"granted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"granted_by" integer,
	CONSTRAINT "role_scopes_role_id_scope_id_pk" PRIMARY KEY("role_id","scope_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(50) NOT NULL,
	"description" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" integer
);
--> statement-breakpoint
CREATE TABLE "scopes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scopes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(100) NOT NULL,
	"description" varchar(255) NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" integer
);
--> statement-breakpoint
CREATE TABLE "user_extra_scopes" (
	"user_id" integer NOT NULL,
	"scope_id" integer NOT NULL,
	"granted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"granted_by" integer,
	"expires_at" timestamp (3) with time zone,
	"reason" varchar(500),
	CONSTRAINT "user_extra_scopes_user_id_scope_id_pk" PRIMARY KEY("user_id","scope_id")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_identities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"system_code" varchar(30) NOT NULL,
	"external_id" varchar(100) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"password_hash" text,
	"primary_role_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"tokens_revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" integer
);
--> statement-breakpoint
CREATE INDEX "audit_logs_event_idx" ON "audit_logs" USING btree ("event_code","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_code_unique" ON "roles" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "scopes_code_unique" ON "scopes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_system_external_unique" ON "user_identities" USING btree ("system_code","external_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));