import type { MessageBlock } from "@rakazo/contracts";
import { createThreadMessage, type PrismaClient, type ThreadEvents } from "@rakazo/db";
import type { DiscordBotRecord, DiscordTurnStore, RunWaiter } from "./rakazo-bots.js";
import type { DiscordCorrelation } from "./types.js";

export function createPrismaDiscordTurnStore(
  prisma: PrismaClient,
  events: ThreadEvents,
): DiscordTurnStore {
  return {
    async findActiveBot(query) {
      if (query.id) {
        const byId = await prisma.bot.findFirst({
          where: { id: query.id, spaceId: query.workspaceId, archivedAt: null },
          include: { thread: true },
        });
        if (byId?.thread) return toBotRecord(byId);
      }
      const byName = await prisma.bot.findFirst({
        where: { spaceId: query.workspaceId, name: query.name, archivedAt: null },
        include: { thread: true },
      });
      return byName?.thread ? toBotRecord(byName) : null;
    },
    async findRunByClientNonce(workspaceId, clientNonce) {
      const run = await prisma.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: workspaceId, clientNonce } },
      });
      if (!run) return null;
      const latest = await prisma.event.findFirst({
        where: { threadId: run.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      return {
        id: run.id,
        threadId: run.threadId,
        botId: run.botId,
        status: run.status,
        error: run.error,
        afterSeq: latest?.seq ?? 0,
      };
    },
    async createDiscordTurn(input) {
      const message = await createThreadMessage(prisma, {
        threadId: input.bot.threadId,
        role: "system",
        blocks: [
          {
            kind: "meta",
            text: `Discord ${input.speaker} request · ${eventRef(input.correlation)}`,
          },
          { kind: "text", text: input.prompt },
        ],
      });
      const requestEvent = await events.append({
        spaceId: input.workspaceId,
        threadId: input.bot.threadId,
        botId: input.bot.id,
        type: "thread.message.created",
        payload: {
          messageId: message.id,
          role: "system",
          blocks: message.blocks,
        },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: input.workspaceId,
          botId: input.bot.id,
          threadId: input.bot.threadId,
          userId: input.bot.userId,
          prompt: input.prompt,
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: input.workspaceId,
          botId: input.bot.id,
          threadId: input.bot.threadId,
          taskId: task.id,
          userId: input.bot.userId,
          status: "queued",
          trigger: "discord",
          clientNonce: input.clientNonce,
        },
      });
      return { runId: run.id, afterSeq: requestEvent.seq };
    },
    async getRun(runId) {
      const run = await prisma.run.findUnique({ where: { id: runId } });
      return run
        ? {
            id: run.id,
            threadId: run.threadId,
            botId: run.botId,
            status: run.status,
            error: run.error,
          }
        : null;
    },
    async getBotReplyText(runId) {
      const messages = await prisma.message.findMany({
        where: { runId, role: "bot" },
        orderBy: { seq: "desc" },
        take: 5,
      });
      for (const message of messages) {
        const text = blocksToPlainText(message.blocks);
        if (text) return text;
      }
      return null;
    },
  };
}

export function createEventRunWaiter(events: ThreadEvents, store: DiscordTurnStore): RunWaiter {
  return {
    async wait(input) {
      const already = await store.getRun(input.runId);
      const early = asWaitOutcome(already?.status);
      if (early && early !== "timeout") return early;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      const onOuterAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        for await (const event of events.follow(
          input.threadId,
          input.afterSeq,
          controller.signal,
        )) {
          if (event.runId !== input.runId) continue;
          if (event.type === "run.completed") return "completed";
          if (event.type === "run.failed") return "failed";
          if (event.type === "run.cancelled") return "cancelled";
          if (event.type === "run.waiting_input") return "waiting_input";
          if (event.type === "computer.takeover.requested") return "waiting_takeover";
        }
        const latest = await store.getRun(input.runId);
        return asWaitOutcome(latest?.status) ?? "timeout";
      } catch {
        const latest = await store.getRun(input.runId);
        return asWaitOutcome(latest?.status) ?? "timeout";
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}

function toBotRecord(bot: {
  id: string;
  name: string;
  userId: string;
  spaceId: string;
  thread: { id: string } | null;
}): DiscordBotRecord {
  return {
    id: bot.id,
    name: bot.name,
    userId: bot.userId,
    workspaceId: bot.spaceId,
    threadId: bot.thread!.id,
  };
}

function eventRef(correlation: DiscordCorrelation): string {
  return correlation.eventKind === "interaction"
    ? `discord:interaction:${correlation.interactionId ?? correlation.eventId}`
    : `discord:message:${correlation.messageId ?? correlation.eventId}`;
}

function blocksToPlainText(blocks: unknown): string {
  const parsed = Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
  return parsed
    .map((block) => {
      if (block.kind === "text" || block.kind === "meta" || block.kind === "progress") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function asWaitOutcome(
  status: string | undefined,
):
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_input"
  | "waiting_takeover"
  | "timeout"
  | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "waiting_input") return "waiting_input";
  if (status === "waiting_takeover") return "waiting_takeover";
  return undefined;
}
