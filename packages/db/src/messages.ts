import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Leading label the transcript importer puts on an archival record's `meta` block, as in
 * "Source: Grok · transcript <id> · record 37440/37440". Matching the prefix rather than the
 * whole string keeps it working whether the importer writes "Grok" or "Grokbot".
 */
const ARCHIVAL_SOURCE_PREFIX = "Source: Grok";

/**
 * Excludes imported Grokbot transcript from a run's recent history.
 *
 * Grokbot and Rakazo are separate products with separate memory, and an imported Grokbot
 * transcript is an archive of the former, not something the seat said here. It is written
 * into the live thread at the newest `seq`, so without this every seat's 200-message window
 * filled with old Grokbot conversation and the seat's actual recent Rakazo work fell out of
 * the window entirely -- measured at 200 of 200 on seven seats and 198 of 200 on the eighth.
 *
 * The records stay imported, source-labelled and queryable; they just do not count as the
 * recent conversation. A seat that genuinely needs its Grokbot history reads it from durable
 * memory, where the same history lives as `log/` documents.
 */
export function archivalHistoryExclusion() {
  return {
    NOT: {
      AND: [
        { blocks: { path: ["0", "kind"], equals: "meta" } },
        { blocks: { path: ["0", "text"], string_starts_with: ARCHIVAL_SOURCE_PREFIX } },
      ],
    },
  };
}
/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...archivalHistoryExclusion(),
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      botId: true,
      runId: true,
      blocks: true,
      createdAt: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, botId: true, blocks: true } },
    },
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Terminal echo after the run is already cancelled. Every other write stays rejected. */
  allowCancelledRun?: boolean;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) =>
      createThreadMessageInTransaction(tx, input),
    ),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      nextMessageSeq: { increment: 1 },
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  await assertRunCanWriteHistory(tx, input.runId, { allowCancelled: input.allowCancelledRun });
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
  options?: { allowCancelled?: boolean },
): Promise<{ status: string; startedAt: Date | null } | undefined> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true, startedAt: true },
  });
  if (!run || (run.status === "cancelled" && !options?.allowCancelled)) {
    throw new RunHistoryWriteError();
  }
  return run;
}

/**
 * run.cancelled is recorded by the path that cancelled the run, after the row
 * already reads cancelled — where the liveness assert above would reject it.
 * The event must name its run (clients key off it) and the row must already be
 * cancelled, so it can never announce a cancellation nothing committed.
 */
export async function assertRunIsCancelled(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<void> {
  if (!runId) throw new RunHistoryWriteError();
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status !== "cancelled") {
    throw new RunHistoryWriteError();
  }
}
