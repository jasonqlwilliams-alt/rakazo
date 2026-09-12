CREATE TABLE "direct_threads" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "firstBotId" TEXT NOT NULL,
    "secondBotId" TEXT NOT NULL,
    "nextMessageSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "direct_threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "direct_threads_distinct_bots_check" CHECK ("firstBotId" < "secondBotId")
);

CREATE TABLE "direct_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "senderBotId" TEXT NOT NULL,
    "recipientBotId" TEXT NOT NULL,
    "clientNonce" TEXT NOT NULL,
    "recipientRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "direct_threads_spaceId_firstBotId_secondBotId_key"
ON "direct_threads"("spaceId", "firstBotId", "secondBotId");

CREATE INDEX "direct_threads_spaceId_idx" ON "direct_threads"("spaceId");
CREATE INDEX "direct_threads_firstBotId_idx" ON "direct_threads"("firstBotId");
CREATE INDEX "direct_threads_secondBotId_idx" ON "direct_threads"("secondBotId");

CREATE UNIQUE INDEX "direct_messages_threadId_seq_key"
ON "direct_messages"("threadId", "seq");

CREATE UNIQUE INDEX "direct_messages_threadId_clientNonce_key"
ON "direct_messages"("threadId", "clientNonce");

CREATE INDEX "direct_messages_threadId_seq_idx" ON "direct_messages"("threadId", "seq");
CREATE INDEX "direct_messages_recipientBotId_createdAt_idx"
ON "direct_messages"("recipientBotId", "createdAt");

ALTER TABLE "direct_threads" ADD CONSTRAINT "direct_threads_spaceId_fkey"
FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "direct_threads" ADD CONSTRAINT "direct_threads_firstBotId_fkey"
FOREIGN KEY ("firstBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "direct_threads" ADD CONSTRAINT "direct_threads_secondBotId_fkey"
FOREIGN KEY ("secondBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "direct_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
