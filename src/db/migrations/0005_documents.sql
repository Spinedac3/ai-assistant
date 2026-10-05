CREATE TABLE "document_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"doc_code" varchar(100) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"status" varchar(10) DEFAULT 'queued' NOT NULL,
	"chunks" integer,
	"error" text,
	"user_id" integer NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "document_jobs_status_idx" ON "document_jobs" USING btree ("status","created_at");