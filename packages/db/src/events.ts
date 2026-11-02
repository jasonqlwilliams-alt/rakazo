import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  type BotSecretDestination,
  encodeLoginSecret,
  LoginSecretValue,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
  type ProductEvent,
  type RunDelegation,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  botMessageContext,
  callIdFromClientNonce,
  isApprovalAskBlock,
  isConversationalRun,
  isDelegatedRun,
  isSecretAskBlock,
  isUserProgressClientNonce,
  messagingChannelId,
  resolveAskChoice,
  runTakesSteering,
  sanitizeJsonValue,
  THREAD_CLEARED_RUN_MESSAGE,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import type { RunComputerWork } from "./computers.js";
import { findRunComputerWork } from "./computers.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Terminal echo after the run is already cancelled. Every other event stays rejected. */
  allowCancelledRun?: boolean;
}

export interface ThreadEvents {
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(threadId: string, seq: number): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
  /** Refuse unless the thread's next message seq still equals this. */
  expectedNextMessageSeq?: number;
  /** Refuse while a run, cloud agent, or research job is still active in the thread. */
  ifIdle?: boolean;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  /** The new generation; the cleared conversation belongs to the previous one. */
  historyCompactionGeneration: number;
  /** Sandbox work of the cancelled runs, for the caller to stop after commit. */
  computerWork: RunComputerWork;
  /** Screen control leases the cancelled takeovers held; the caller revokes each one. */
  takeoverControls: TakeoverControl[];
}

export interface TakeoverControl {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  controlLeaseId: string;
  controlBotId: string | null;
}

export class ThreadClearPreconditionError extends Error {
  constructor(readonly reason: "changed" | "busy") {
    super(
      reason === "changed"
        ? "The conversation changed since it was read."
        : "The conversation still has work in progress.",
    );
    this.name = "ThreadClearPreconditionError";
  }
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        markUnread?: boolean;
      }
    | { outcome: "failed"; error: string }
  );

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: string;
  /** Identifies a spoken answer as part of a live voice call. */
  clientNonce?: string;
  /** Only for a login card; `answer` carries its password. */
  username?: string;
}

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** Bind a webhook delivery to the routine that opted in to unattended tools. */
  routineId?: string;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
  /** Model every routine in an inbound delivery agreed on. */
  modelPin?: {
    modelProvider: string;
    modelId: string;
    thinkingLevel: string | null;
  };
  /**
   * A verified delegated request. Its message always starts its own run, which carries the
   * delegation, and never steers or waits behind another run.
   */
  delegation?: RunDelegation;
  /** Id for the task this message starts, so a delegated request's task is its request id. */
  taskId?: string;
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export interface RunSecretWriter {
  withPrepared?<T>(
    prisma: PrismaClient,
    input: AnswerRunInput,
    commit: (writer: RunSecretWriter) => Promise<T>,
  ): Promise<T>;
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: { catchUpMs?: number; runSecretWriter?: RunSecretWriter } = {},
): ThreadEvents {
  return {
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    append: (input) => appendEvent(prisma, input, realtime),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: (threadId, seq) => notifyRealtime(realtime, threadId, seq),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      data: { unread: false },
      select: { nextMessageSeq: true },
    });
    // The row lock above serializes sends, launches, and research starts against this check.
    if (
      input.expectedNextMessageSeq !== undefined &&
      thread.nextMessageSeq !== input.expectedNextMessageSeq
    ) {
      throw new ThreadClearPreconditionError("changed");
    }
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: input.threadId,
        ...(input.groupId ? {} : { botId: input.botId }),
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: {
        id: true,
        taskId: true,
        botId: true,
        status: true,
        leaseFence: true,
        bot: {
          select: {
            computer: {
              select: { id: true, scope: true },
            },
          },
        },
      },
    });
    if (input.ifIdle && (activeRuns.length > 0 || (await hasActiveThreadJob(tx, input.threadId)))) {
      throw new ThreadClearPreconditionError("busy");
    }
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const dedicatedComputerWork = activeRuns.flatMap((run) => {
      const computer = run.bot.computer;
      if (computer?.scope !== "dedicated" || run.status !== "waiting_takeover") return [];
      return [
        {
          computerId: computer.id,
          botId: run.botId,
          runId: run.id,
          fence: run.leaseFence,
        },
      ];
    });
    await keepBotMessageSenders(tx, input.threadId);
    await cancelRunsInTransaction(tx, activeRuns, now);
    // A delegated request the clear stops still owes its sender an outcome.
    await tx.run.updateMany({
      where: { id: { in: runIds }, trigger: "bot_message" },
      data: { error: THREAD_CLEARED_RUN_MESSAGE },
    });
    for (const { computerId, botId, runId, fence } of dedicatedComputerWork) {
      // This hold lasts five minutes even if screen release is still waiting.
      const expiresAt = new Date(now.getTime() + 5 * 60_000);
      await tx.computerExecutionLease.upsert({
        where: { computerId_botId: { computerId, botId } },
        create: { computerId, botId, runId, fence, expiresAt },
        update: { runId, fence, expiresAt },
      });
    }
    const computerWork = await findRunComputerWork(tx, runIds);
    const takeoverControls = await releaseTakeovers(tx, runIds);
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    const cleared = await tx.thread.update({
      where: { id: input.threadId },
      data: {
        // nextMessageSeq is not reset, so mark every deleted message as already compacted.
        // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
        // to null, immediately re-fire on the fresh conversation).
        ...(thread.nextMessageSeq > 0
          ? { historyCompactedUpToSeq: thread.nextMessageSeq - 1 }
          : {}),
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
      },
      select: { historyCompactionGeneration: true },
    });
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: cleared.historyCompactionGeneration,
      computerWork,
      takeoverControls,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  return { ...committed, event: mapProductEvent(committed.event) };
}

async function hasActiveThreadJob(tx: Prisma.TransactionClient, threadId: string) {
  const [agent, research] = await Promise.all([
    tx.cloudAgent.findFirst({ where: { threadId, status: "running" }, select: { id: true } }),
    tx.researchJob.findFirst({
      where: { threadId, status: { in: ["queued", "running"] } },
      select: { id: true },
    }),
  ]);
  return Boolean(agent || research);
}

/**
 * Deleting the thread's messages nulls each run's sourceMessageId. Keep who sent each
 * delegated request whose outcome is still owed, without the request text, so that outcome
 * still reaches its sender.
 */
async function keepBotMessageSenders(tx: Prisma.TransactionClient, threadId: string) {
  const owed = await tx.run.findMany({
    where: {
      threadId,
      trigger: "bot_message",
      botOutcomeReturnedAt: null,
      botOutcomeFailedAt: null,
      sourceMessageId: { not: null },
    },
    select: { id: true, status: true, sourceMessage: { select: { blocks: true } } },
  });
  for (const run of owed) {
    const blocks = MessageBlockSchema.array().safeParse(run.sourceMessage?.blocks);
    const context = blocks.success ? botMessageContext(blocks.data) : undefined;
    if (!context) continue;
    const sent = await tx.message.findMany({
      where: { threadId, runId: run.id },
      select: { role: true, blocks: true, clientNonce: true },
    });
    const explicitResult = sent.some((message) => {
      const parsed = MessageBlockSchema.array().safeParse(message.blocks);
      return (
        parsed.success &&
        parsed.data.some(
          (block) =>
            block.kind === "bot_message_sent" &&
            block.toBotId === context.fromBotId &&
            block.intent === "result",
        )
      );
    });
    const answerCleared =
      run.status === "completed" &&
      sent.some(
        (message) =>
          message.role === "bot" &&
          !isUserProgressClientNonce(message.clientNonce) &&
          Array.isArray(message.blocks) &&
          (message.blocks as MessageBlock[]).some(
            (block) => block.kind === "text" && block.text.trim().length > 0,
          ),
      );
    await tx.run.update({
      where: { id: run.id },
      data: {
        botMessageSource: {
          ...context,
          text: "",
          ...(answerCleared ? { answerCleared: true } : {}),
        },
        ...(explicitResult ? { botOutcomeReturnedAt: new Date() } : {}),
      },
    });
  }
}

/**
 * Unbind screen control from the cancelled takeovers. A row with a control lease keeps the
 * lease id, with input denied, until the caller revokes it on the provider; if that fails,
 * control expiry still finds the lease and retries.
 */
async function releaseTakeovers(
  tx: Prisma.TransactionClient,
  runIds: string[],
): Promise<TakeoverControl[]> {
  if (runIds.length === 0) return [];
  const bound = await tx.computer.findMany({
    where: { controlRunId: { in: runIds } },
    select: {
      id: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      controlLeaseId: true,
      controlBotId: true,
    },
  });
  await tx.computer.updateMany({
    where: { controlRunId: { in: runIds }, controlLeaseId: null },
    data: {
      controlHolder: "none",
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  await tx.computer.updateMany({
    where: { controlRunId: { in: runIds }, controlLeaseId: { not: null } },
    data: { controlHolder: "none", controlRunId: null, controlLeaseExpiresAt: new Date() },
  });
  return bound.flatMap(({ controlLeaseId, ...computer }) =>
    controlLeaseId ? [{ ...computer, controlLeaseId }] : [],
  );
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
      include: { sourceRuns: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!message) return null;
    const created = message.sourceRuns[0];
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      const createRun = input.createRun !== false;
      // Include the creation intro. It has no tools, so it must not absorb the message, and a
      // second run would overlap it on a dedicated computer. Pending steering waits for the
      // continuation that starts when the intro finishes.
      // A delegated request never steers or waits behind another run: either would put it
      // under that run's authority.
      const activeRuns =
        createRun && !input.allowParallelRun && !input.delegation
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: ["running", "queued", "leased", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true, trigger: true, delegation: true },
            })
          : [];
      // Steer a conversational run when there is one; a routine, webhook, intro, or delegated
      // turn only holds the queue.
      const busy = activeRuns.find(runTakesSteering) ?? activeRuns[0] ?? null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            ...(input.taskId ? { id: input.taskId } : {}),
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
            routineId: input.routineId,
            ...(input.delegation ? { delegation: input.delegation } : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                  modelPinned: true,
                }
              : {}),
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        const held = !runTakesSteering(busy);
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            // Keep messaging on the hold so the later run is mirrored back to that app.
            runId: held ? null : busy.id,
            ...(held && input.trigger === "messaging" ? { originTrigger: "messaging" } : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                }
              : {}),
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks: input.blocks,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
        },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: {
        id: true,
        trigger: true,
        delegation: true,
        sourceMessage: { select: { blocks: true } },
      },
    });
    // A delegated run takes no steering: the owner's messages keep the owner's authority.
    if (!run || run.trigger === "created" || isDelegatedRun(run)) return [];
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const directMessage = run.trigger === "messaging" && !channelId;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR: isConversationalRun(run.trigger)
          ? [pendingWhere, { runId: input.runId }]
          : [{ runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : directMessage
              ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
              : {}),
        },
      },
      include: { message: { select: { blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
    }));
  });
}

async function findPendingAsk(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const messages = await tx.message.findMany({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
    orderBy: { seq: "desc" },
    take: 50,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const pendingAsk = parsed.data.find(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    if (pendingAsk?.kind === "ask") return { messageId: message.id, pendingAsk };
  }
  return null;
}

async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
): Promise<{ threadId: string; seq: number } | null> {
  // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
  // concurrent clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: { botId: true, userId: true, checkpoint: true },
  });
  if (!run) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  if (pendingAsk?.kind !== "ask") return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  const secretAsk = isSecretAskBlock(pendingAsk);
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk ? resolveAskChoice(input.answer, pendingAsk.actions) : undefined;
  if (secretAsk && !runSecretWriter) return null;
  if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
  const loginAsk = secretAsk && pendingAsk.credential?.auth.type === "login";
  // A username belongs only to a login card, which cannot be saved without one.
  if (loginAsk !== Boolean(input.username?.trim())) return null;
  const login = loginAsk
    ? LoginSecretValue.safeParse({ username: input.username!.trim(), password: input.answer })
    : undefined;
  if (login && !login.success) return null;
  let approvalEffect: { id: string; kind: string } | null = null;
  let approvalUserId: string | null = null;

  if (approvalAsk) {
    if (!pendingAsk.actions?.some((action) => action.id === input.answer)) return null;
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect) return null;
    if (input.answer === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalUserId = input.answeredByUserId;
    }
  }

  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      ...(choiceAsk ? { checkpoint: null } : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (selectedChoice?.id ?? input.answer);
  const callId = callIdFromClientNonce(input.clientNonce);
  const recordsCallUtterance = Boolean(callId && !secretAsk);

  // Give spoken answers the same durable, call-scoped user utterance as other voice turns.
  // Secret asks stay out of message history; the call UI requires those answers on screen.
  if (recordsCallUtterance) {
    const blocks = [{ kind: "text" as const, text: input.answer }];
    const utterance = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "user",
      blocks,
      botId: run.botId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: utterance.id, role: "user", blocks, callId },
    });
  }

  if (approvalAsk) {
    const allowed = input.answer === "allow" || input.answer === "always";
    await tx.externalEffect.update({
      where: { id: approvalEffect!.id },
      data: { status: allowed ? "approved" : "denied" },
    });
    if (input.answer === "always") {
      await tx.actionApprovalRule.upsert({
        where: {
          spaceId_createdByUserId_effect_matchKind_matchValue: {
            spaceId: input.spaceId,
            createdByUserId: approvalUserId!,
            effect: "always_allow",
            matchKind: "tool",
            matchValue: approvalEffect!.kind,
          },
        },
        create: {
          spaceId: input.spaceId,
          createdByUserId: approvalUserId!,
          effect: "always_allow",
          matchKind: "tool",
          matchValue: approvalEffect!.kind,
        },
        update: {},
      });
    }
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login?.success ? encodeLoginSecret(login.data) : input.answer,
      tx,
    });
    await tx.externalEffect.updateMany({
      where: {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential ? { result: { credentialSaved: pendingAsk.credential } } : {}),
      },
    });
  } else {
    const resumeLabel = selectedChoice
      ? resumeChoiceLabel(selectedChoice, run.checkpoint)
      : undefined;
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: {
        prompt: selectedChoice
          ? `Selected choice ${selectedChoice.id}: ${resumeLabel}`
          : input.answer,
      },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  }

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return { threadId: updated.threadId, seq: updated.seq };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
): Promise<boolean> {
  const commit = (writer = runSecretWriter) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) =>
      commitAnswerRunInput(tx, input, writer),
    );
  const committed = runSecretWriter?.withPrepared
    ? await runSecretWriter.withPrepared(prisma, input, commit)
    : await commit();

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/** Answer a waiting question ask with composer free-text. Approval and secret cards stay on the card path. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
  },
): Promise<{ threadId: string; seq: number } | null> {
  const answer = input.answer.trim();
  if (!answer) return null;
  const found = await findPendingAsk(tx, input);
  if (!found) return null;
  if (isApprovalAskBlock(found.pendingAsk) || isSecretAskBlock(found.pendingAsk)) return null;
  return commitAnswerRunInput(tx, { ...input, messageId: found.messageId, answer });
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: input.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: message.id, role: "bot", blocks: input.blocks },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: {},
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const now = new Date();
    // Serialize with concurrent computer/takeover grants that mutate the same row.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
    );
    const marked = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq };
  });

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        spaceId: input.spaceId,
        controlBotId: input.botId,
        controlLeaseId: input.leaseId,
        controlRunId: input.runId,
      },
      data: {
        controlHolder: input.holder,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (cleared.count !== 1) return null;

    const checkpoint =
      input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
    const resumed = input.runId
      ? await tx.run.updateMany({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            status: "waiting_takeover",
          },
          data: {
            status: "queued",
            checkpoint,
          },
        })
      : { count: 0 };
    // A steered continue may already hold the run as leased/running. Stamp the
    // checkpoint without stealing the lease so the worker can restore tools.
    const stamped =
      input.runId && resumed.count !== 1
        ? await tx.run.updateMany({
            where: {
              id: input.runId,
              spaceId: input.spaceId,
              botId: input.botId,
              status: { in: ["leased", "running"] },
            },
            data: { checkpoint },
          })
        : { count: 0 };
    const runId = resumed.count === 1 || stamped.count === 1 ? input.runId : null;

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return { threadId: null, seq: null, runId };
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: bot.thread.id,
      botId: input.botId,
      runId: runId ?? undefined,
      type: "computer.takeover.released",
      payload: {
        holder: input.holder,
        leaseId: input.leaseId,
        reason: input.reason,
      },
    });
    return { threadId: event.threadId, seq: event.seq, runId };
  });

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  // Concurrent writers in one thread (group members, bot messages) can deadlock on the thread row.
  const event = await withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) => appendEventInTransaction(tx, input)),
  );
  const productEvent = mapProductEvent(event);
  await notifyRealtime(realtime, event.threadId, event.seq);
  return productEvent;
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{ threadId: string; seq: number; continuationRunId: string | null } | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: { startedAt: Date | null } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    if (input.outcome === "completed") {
      const completedBlocks = completedRunBlocks(input.blocks, writableRun?.startedAt ?? null, now);
      if (completedBlocks.length > 0) {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: input.threadId,
          role: "bot",
          blocks: completedBlocks,
          botId: input.botId,
          runId: input.runId,
          markUnread: input.markUnread,
        });
        await appendEventInTransaction(tx, {
          spaceId: input.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          type: "thread.message.created",
          runId: input.runId,
          payload: { messageId: message.id, role: "bot", blocks: completedBlocks },
        });
      }
    }
    const lastEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload: input.outcome === "completed" ? {} : { error: input.error },
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    } else {
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    const continuationRunId = await createPendingSteeringRun(tx, input);
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId };
  });
}

/** Queue one follow-up when this bot still has unclaimed steering and no live run. */
export async function createPendingSteeringRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and a direct chat are not answered together.
  const origin = steeringOrigin(pending[0]!);
  const batch = pending.filter((item) => steeringOrigin(item) === origin);
  const source = batch.at(-1)!;
  const modelPin = continuationModelPin(batch);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: batch[0]!.userId,
      prompt: "Respond to the user's steering context.",
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: batch[0]!.userId,
      status: "queued",
      trigger: origin === "app" ? "follow_up" : "messaging",
      sourceMessageId: source.message.id,
      ...(modelPin ?? {}),
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

function continuationModelPin(
  batch: ReadonlyArray<{
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  }>,
) {
  const first = batch[0];
  if (!first?.modelProvider || !first.modelId) return null;
  const agreed = batch.every(
    (item) =>
      item.modelProvider === first.modelProvider &&
      item.modelId === first.modelId &&
      (item.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  if (!agreed) return null;
  return {
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    thinkingLevel: first.thinkingLevel ?? null,
    modelPinned: true,
  };
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger !== "messaging") return "app";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "dm";
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  // run.cancelled is appended after the run row already reads cancelled, so it
  // asserts the terminal status where every other event needs a writable run.
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else {
    await assertRunCanWriteHistory(tx, input.runId, { allowCancelled: input.allowCancelledRun });
  }
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  return tx.event.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
}

async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}
