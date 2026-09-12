ALTER TABLE "runs"
  ADD COLUMN "botOutcomeAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "botOutcomeNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "botOutcomeFailedAt" TIMESTAMP(3),
  ADD COLUMN "botOutcomeError" TEXT;
