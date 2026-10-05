CREATE TABLE "tool_definitions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_definitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"source_code" varchar(50) NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"spec" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_source_code_sources_code_fk" FOREIGN KEY ("source_code") REFERENCES "public"."sources"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definitions_name_unique" ON "tool_definitions" USING btree ("name");