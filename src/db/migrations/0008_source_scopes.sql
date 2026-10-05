-- Sources registered before each got its own permission get one now
INSERT INTO "scopes" ("code", "description", "sensitive", "created_by")
SELECT 'sources.' || "code" || '.use', 'Usar las herramientas de la fuente ' || "name", true, "created_by"
FROM "sources"
ON CONFLICT ("code") DO NOTHING;
