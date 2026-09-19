-- Reply address is per inbound message so interleaved roots keep their own thread.
ALTER TABLE "external_messages" ADD COLUMN "conversationId" TEXT;

UPDATE "external_messages" AS message
SET "conversationId" = conversation."conversationId"
FROM "external_conversations" AS conversation
WHERE message."externalConversationId" = conversation.id
  AND message."conversationId" IS NULL;

ALTER TABLE "external_messages" ALTER COLUMN "conversationId" SET NOT NULL;
