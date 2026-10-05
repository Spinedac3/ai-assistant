CREATE TABLE "conversations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"title" varchar(200),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"msg_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" integer
);
--> statement-breakpoint
CREATE TABLE "message_ratings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_ratings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"stars" integer NOT NULL,
	"comment" varchar(2000),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" bigint NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd_millionths" integer,
	"model" varchar(60),
	"finish_reason" varchar(40),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"user_id" integer NOT NULL,
	"window_type" varchar(10) NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"msg_count" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_millionths" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_user_id_window_type_window_start_pk" PRIMARY KEY("user_id","window_type","window_start")
);
--> statement-breakpoint
CREATE INDEX "conversations_user_last_idx" ON "conversations" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_ratings_message_user_unique" ON "message_ratings" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","id");