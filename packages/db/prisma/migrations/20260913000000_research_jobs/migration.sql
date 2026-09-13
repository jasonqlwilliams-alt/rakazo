CREATE TABLE "research_jobs" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "messageId" TEXT,
  "computerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "errorCode" TEXT,
  "receipt" JSONB,
  "artifactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "launchDispatched" BOOLEAN NOT NULL DEFAULT false,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "startedAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "wakeRunId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextPollAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "research_jobs_operationKey_key" ON "research_jobs"("operationKey");
CREATE INDEX "research_jobs_nextPollAt_idx" ON "research_jobs"("nextPollAt");
CREATE INDEX "research_jobs_spaceId_userId_id_idx" ON "research_jobs"("spaceId", "userId", "id");
-- One active research job per computer: the second start fails instead of racing the first.
CREATE UNIQUE INDEX "research_jobs_active_computer_key" ON "research_jobs"("computerId")
  WHERE "status" IN ('queued', 'running');

CREATE TABLE "space_research_settings" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "settings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_research_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_research_settings_spaceId_key" ON "space_research_settings"("spaceId");
ALTER TABLE "space_research_settings"
  ADD CONSTRAINT "space_research_settings_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
