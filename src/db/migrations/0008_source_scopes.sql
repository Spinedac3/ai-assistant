-- Sources registered before each got its own permission get one now, held by the admin role
INSERT INTO "scopes" ("code", "description", "sensitive", "created_by")
SELECT 'sources.' || "code" || '.use', 'Usar las herramientas de la fuente ' || "name", true, "created_by"
FROM "sources"
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_scopes" ("role_id", "scope_id")
SELECT "roles"."id", "scopes"."id"
FROM "roles" JOIN "scopes" ON "scopes"."code" LIKE 'sources.%.use'
WHERE "roles"."code" = 'admin'
ON CONFLICT DO NOTHING;
