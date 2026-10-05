CREATE TABLE "access_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "access_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"access_token_hash" varchar(64) NOT NULL,
	"refresh_token_hash" varchar(64),
	"previous_refresh_hash" varchar(64),
	"kind" varchar(20) NOT NULL,
	"access_expires_at" timestamp (3) with time zone NOT NULL,
	"refresh_expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"last_used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_intents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mcp_intents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"question" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"conversation_id" bigint,
	"tool_name" varchar(100) NOT NULL,
	"args_json" jsonb NOT NULL,
	"success" boolean NOT NULL,
	"error_code" varchar(60),
	"duration_ms" integer NOT NULL,
	"result_bytes" integer DEFAULT 0 NOT NULL,
	"result_rows" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"result_hash" varchar(64),
	"origin" varchar(20) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_access_hash_unique" ON "access_tokens" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "access_tokens_refresh_hash_unique" ON "access_tokens" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "access_tokens_user_idx" ON "access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_intents_created_idx" ON "mcp_intents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_user_created_idx" ON "tool_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_conversation_idx" ON "tool_calls" USING btree ("conversation_id","id");