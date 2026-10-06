CREATE TABLE "pdf_conversions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"status" varchar(10) DEFAULT 'queued' NOT NULL,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"pages_total" integer,
	"markdown" text,
	"suggested" jsonb,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE INDEX "pdf_conversions_user_idx" ON "pdf_conversions" USING btree ("user_id","created_at");