CREATE TABLE "notices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sender_user_id" integer NOT NULL,
	"key" varchar(100) NOT NULL,
	"recipient_user_id" integer NOT NULL,
	"recipient_email" varchar(255) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notices_sender_key_unique" ON "notices" USING btree ("sender_user_id","key");--> statement-breakpoint
CREATE INDEX "notices_due_idx" ON "notices" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notices_recipient_idx" ON "notices" USING btree ("recipient_user_id","created_at");