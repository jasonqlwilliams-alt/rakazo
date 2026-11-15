ALTER TABLE "runs" ADD COLUMN "setupFailureCount" INTEGER NOT NULL DEFAULT 0,
                   ADD COLUMN "setupRetryAt" TIMESTAMP(3);
