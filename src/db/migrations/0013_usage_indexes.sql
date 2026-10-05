CREATE INDEX "message_ratings_created_idx" ON "message_ratings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_created_idx" ON "tool_calls" USING btree ("created_at");--> statement-breakpoint
UPDATE "scopes" SET "description" = 'Ver cuánto se usa el asistente (conteos, sin el contenido)' WHERE "code" = 'usage.read';
