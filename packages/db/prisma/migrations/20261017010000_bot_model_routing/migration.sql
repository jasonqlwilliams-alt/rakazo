ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "modelRouting" BOOLEAN NOT NULL DEFAULT false;

-- A bot with no pinned model follows the router. An explicit provider and model stays pinned.
UPDATE "bots" SET "modelRouting" = true WHERE "modelProvider" IS NULL AND "modelId" IS NULL;
