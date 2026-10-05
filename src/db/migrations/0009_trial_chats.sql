ALTER TABLE "conversations" ADD COLUMN "tool_name" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "trace" jsonb;