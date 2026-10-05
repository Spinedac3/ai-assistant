CREATE TABLE "settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
