import type { BotMessageIntent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  returnBotMessageOutcome,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [] },
    );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.senderRunning === false ? null : { id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    bot: {
      findFirst: vi.fn().mockResolvedValue(options.targetArchived ? null : { id: "bot-target" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
  };
  let transactionAttempts = 0;
  const prisma = {
    bot: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ],
        ),
    },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
  };
}

describe("messaging another bot", () => {
  it("delivers into the target's own chat and wakes it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
        }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(
      harness.tx.thread.update.mock.calls.filter(
        ([call]) => (call as { data?: { unread?: boolean } }).data?.unread,
      ),
    ).toHaveLength(2);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("tells the sender to continue independent work", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "ping",
    });
    expect(sent.ok && sent.note).toContain("async");
    expect(sent.ok && sent.note).toContain("Continue independent work");
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not inherit a request reply link when messaging another bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-other",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not inherit a request reply link for an FYI to the requester", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-target",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 1 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });
});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("loads peer context directly from the source message", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "b",
              fromBotName: "B",
              text: "late FYI",
              intent: "fyi",
            },
          ],
          replyTo: {
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "b",
                toBotName: "B",
                text: "check Gmail",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;
    expect(await loadBotMessageContext(prisma, "message-old")).toMatchObject({
      intent: "fyi",
      repliesToRequest: true,
    });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "message-old" } }),
    );
  });
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: { id: "message-1" } });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(harness.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    );
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("treats a delivery-key unique conflict as a replay", async () => {
    const harness = deps({ uniqueConflictOnCommit: true });
    // After both retries miss and the loser hits P2002, the winner is visible.
    (harness.deps.prisma.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "message-winner",
    });

    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  it("returns an outcome after its JSON reply address was deleted", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "deleted-request",
        },
      ],
    });
    harness.tx.$queryRaw.mockResolvedValue([]);
    harness.tx.message.create.mockImplementation(async ({ data }) => {
      if (data.replyToMessageId)
        throw Object.assign(new Error("Foreign key constraint violated"), { code: "P2003" });
      return { id: "reply", seq: 1 };
    });
    await expect(
      returnBotMessageOutcome(
        harness.deps,
        { ...run, sourceMessageId: "source" },
        sender,
        "Finished.",
      ),
    ).resolves.toBe(true);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyToMessageId: undefined }) }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.message.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          clientNonce: `bot-message-outbound:auto-outcome:${run.id}`,
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["completed", "failed"] } }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed"] },
        OR: [{ botOutcomeReturnedAt: null }, { botOutcomeFailedAt: { not: null } }],
      },
      data: {
        botOutcomeReturnedAt: expect.any(Date),
        botOutcomeFailedAt: null,
        botOutcomeNextAttemptAt: null,
      },
    });
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});

function reconciliationHarness() {
  const source = {
    kind: "bot_message_received",
    fromBotId: "bot-target",
    fromBotName: "Coordinator",
    text: "research this",
    hop: 1,
    intent: "request" as BotMessageIntent | undefined,
  };
  const harness = deps({ hopBlocks: [source] });
  const terminal = {
    ...run,
    sourceMessageId: "source" as string | null,
    trigger: "bot_message",
    status: "completed",
    error: null,
    bot: { name: sender.name },
    botOutcomeReturnedAt: null as Date | null,
    botOutcomeAttempts: 0,
    botOutcomeNextAttemptAt: null as Date | null,
    botOutcomeFailedAt: null as Date | null,
    botOutcomeError: null as string | null,
  };
  const deliveries: Array<{
    threadId: string;
    clientNonce?: string;
    runId?: string;
    role: string;
    blocks: unknown;
    spaceId: string;
    userId: string;
  }> = [];
  const lookup = harness.tx.message.findUnique.getMockImplementation()!;
  harness.tx.message.findUnique.mockImplementation(async (args) => {
    const key = args.where?.threadId_clientNonce as
      | { threadId: string; clientNonce: string }
      | undefined;
    if (!key) return lookup(args);
    return deliveries.some(
      (message) => message.threadId === key.threadId && message.clientNonce === key.clientNonce,
    )
      ? { id: "committed-message" }
      : null;
  });
  Object.assign(harness.deps.prisma.message, {
    findFirst: vi.fn(async ({ where }) =>
      deliveries.some(
        (message) =>
          message.clientNonce === where.clientNonce &&
          (!where.thread?.spaceId || message.spaceId === where.thread.spaceId) &&
          (!where.thread?.userId || message.userId === where.thread.userId),
      )
        ? { id: "committed-message" }
        : null,
    ),
    findMany: vi.fn(async ({ where }) =>
      deliveries.filter(
        (message) =>
          (!where.threadId || message.threadId === where.threadId) &&
          (!where.runId || message.runId === where.runId) &&
          (!where.role || message.role === where.role),
      ),
    ),
  });
  let receipts = 0;
  const applyRunUpdate = ({
    where,
    data,
  }: {
    where: Record<string, any>;
    data: Record<string, any>;
  }) => {
    if (where.status?.in && !where.status.in.includes(terminal.status)) return { count: 0 };
    if (where.OR && terminal.botOutcomeReturnedAt && !terminal.botOutcomeFailedAt)
      return { count: 0 };
    if (where.botOutcomeReturnedAt === null && terminal.botOutcomeReturnedAt) return { count: 0 };
    if (where.botOutcomeFailedAt === null && terminal.botOutcomeFailedAt) return { count: 0 };
    if (
      typeof where.botOutcomeAttempts === "number" &&
      where.botOutcomeAttempts !== terminal.botOutcomeAttempts
    )
      return { count: 0 };
    if (where.botOutcomeError === null && terminal.botOutcomeError) return { count: 0 };
    if (
      where.botOutcomeNextAttemptAt !== undefined &&
      where.botOutcomeNextAttemptAt?.getTime() !== terminal.botOutcomeNextAttemptAt?.getTime()
    )
      return { count: 0 };
    if (data.botOutcomeError) receipts++;
    for (const [key, value] of Object.entries(data)) {
      if (key === "botOutcomeAttempts" && typeof value === "object") terminal.botOutcomeAttempts++;
      else Object.assign(terminal, { [key]: value });
    }
    return { count: 1 };
  };
  const updateMany = vi.fn(async (args) => applyRunUpdate(args));
  const transaction = vi.fn(async (fn: (client: typeof harness.tx) => unknown) => {
    const start = harness.tx.message.create.mock.calls.length;
    const updateStart = harness.tx.run.updateMany.mock.calls.length;
    const result = await fn(harness.tx);
    for (const [args] of harness.tx.run.updateMany.mock.calls.slice(updateStart)) {
      applyRunUpdate(args);
    }
    for (const [{ data }] of harness.tx.message.create.mock.calls.slice(start)) {
      deliveries.push({ ...data, spaceId: run.spaceId, userId: run.userId });
    }
    return result;
  });
  Object.assign(harness.deps.prisma, {
    $transaction: transaction,
    run: {
      updateMany,
      findFirst: vi.fn(async () =>
        terminal.botOutcomeReturnedAt ||
        terminal.botOutcomeFailedAt ||
        (terminal.botOutcomeNextAttemptAt && terminal.botOutcomeNextAttemptAt > new Date())
          ? null
          : { ...terminal },
      ),
      findMany: vi.fn(async ({ where }) => {
        if (where.trigger !== "bot_message" || terminal.botOutcomeReturnedAt) return [];
        if (where.botOutcomeFailedAt === null && terminal.botOutcomeFailedAt) return [];
        if (
          where.OR &&
          terminal.botOutcomeNextAttemptAt &&
          terminal.botOutcomeNextAttemptAt > new Date()
        )
          return [];
        return [{ ...terminal }];
      }),
    },
    routine: { findMany: vi.fn(async () => [{ id: "routine-1", nextRunAt: new Date() }]) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  });

  const handlers = createBackgroundJobHandlers({
    ...harness.deps,
    executor: { continueRun: vi.fn(async () => undefined) },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  return {
    ...harness,
    source,
    terminal,
    deliveries,
    updateMany,
    transaction,
    receipts: () => receipts,
    reconcile: () => handlers["run.continue"]({ runId: terminal.id }),
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("outcome reconciliation persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("skips a permanent sequence conflict once across reconciliation restarts", async () => {
    vi.useFakeTimers();
    const harness = reconciliationHarness();
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const diagnostic = `Unique constraint failed on threadId, seq. ${"diagnostic detail ".repeat(1_000)}`;
    harness.tx.message.create.mockRejectedValue(
      Object.assign(new Error(diagnostic), {
        code: "P2002",
        meta: { target: ["threadId", "seq"] },
        clientVersion: "test-version",
      }),
    );
    for (let tick = 0; tick < 10; tick++) {
      await createJobReconciler(harness.deps).reconcileOnce();
      await harness.reconcile();
      vi.setSystemTime(Date.now() + 10 * 60_000);
    }
    expect(harness.tx.message.create).toHaveBeenCalledTimes(1);
    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeAttempts).toBe(1);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    const receipts = sink.events.filter((event) => event.receipt === `bot-outcome:${run.id}`);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.error?.message).toBe(diagnostic);
    expect(receipts[0]?.prismaError).toMatchObject({
      code: "P2002",
      meta: { target: ["threadId", "seq"] },
      clientVersion: "test-version",
    });
    expect(harness.terminal.botOutcomeError).toBe("P2002");
    expect(harness.receipts()).toBe(1);
    expect(
      harness.enqueue.mock.calls.filter(([job]) => job.name === "routine.wakeup"),
    ).toHaveLength(10);
  });

  it("bounds other create failures before marking them skipped", async () => {
    vi.useFakeTimers();
    const harness = reconciliationHarness();
    harness.tx.message.create.mockRejectedValue(
      Object.assign(new Error("Connection lost"), { code: "P1017" }),
    );
    for (let tick = 0; tick < 10; tick++) {
      await harness.reconcile();
      vi.setSystemTime(Date.now() + 60_000);
    }
    expect(harness.tx.message.create).toHaveBeenCalledTimes(3);
    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.receipts()).toBe(1);
  });

  it("does not recover a rolled-back outbound receipt after an inbound sequence conflict", async () => {
    const harness = reconciliationHarness();
    harness.tx.message.create
      .mockResolvedValueOnce({ id: "outbound", seq: 1 })
      .mockRejectedValueOnce(Object.assign(new Error("Sequence conflict"), { code: "P2002" }));

    await harness.reconcile();
    await harness.reconcile();

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.terminal.botOutcomeAttempts).toBe(1);
    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeError).toBe("P2002");
    expect(harness.receipts()).toBe(1);
  });

  it("waits for backoff, recovers a transient failure, and never delivers again", async () => {
    vi.useFakeTimers();
    const harness = reconciliationHarness();
    harness.tx.message.create.mockRejectedValueOnce(
      Object.assign(new Error("Foreign key constraint violated"), { code: "P2003" }),
    );
    await harness.reconcile();
    expect(harness.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "run.continue", availableAt: new Date(Date.now() + 30_000) }),
    );
    vi.setSystemTime(Date.now() + 29_999);
    await harness.reconcile();
    expect(harness.tx.message.create).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await harness.reconcile();
    await harness.reconcile();
    expect(harness.tx.message.create).toHaveBeenCalledTimes(3);
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeFailedAt).toBeNull();
    expect(harness.terminal.botOutcomeAttempts).toBe(2);
    expect(harness.receipts()).toBe(1);
  });

  it("lets a committed late success supersede an expired recovery lease", async () => {
    const harness = reconciliationHarness();
    harness.tx.message.create.mockImplementationOnce(async () => {
      harness.terminal.botOutcomeFailedAt = new Date();
      return { id: "late-reply", seq: 1 };
    });
    await harness.reconcile();
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeFailedAt).toBeNull();
    expect(harness.terminal.botOutcomeNextAttemptAt).toBeNull();
  });

  it("replays a committed outcome when its returned marker was lost", async () => {
    const harness = reconciliationHarness();
    const lookup = harness.tx.message.findUnique.getMockImplementation()!;
    harness.tx.message.findUnique.mockImplementation(async (args) =>
      args.where?.threadId_clientNonce ? { id: "committed-inbound" } : lookup(args),
    );
    await harness.reconcile();
    await harness.reconcile();
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("recognizes the outbound receipt even when the inbound history was cleared", async () => {
    const harness = reconciliationHarness();
    const lookup = harness.tx.message.findUnique.getMockImplementation()!;
    harness.tx.message.findUnique.mockImplementation(async (args) => {
      const key = args.where?.threadId_clientNonce as
        | { threadId: string; clientNonce: string }
        | undefined;
      if (!key) return lookup(args);
      return key.threadId === run.threadId &&
        key.clientNonce === `bot-message-outbound:auto-outcome:${run.id}`
        ? { id: "committed-outbound" }
        : null;
    });
    await harness.reconcile();
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeFailedAt).toBeNull();
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("claims one attempt when two queue deliveries race", async () => {
    const harness = reconciliationHarness();
    await Promise.all([harness.reconcile(), harness.reconcile()]);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(harness.terminal.botOutcomeAttempts).toBe(1);
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
  });

  it("dead-letters an expired final claim after a worker crash", async () => {
    vi.useFakeTimers();
    const harness = reconciliationHarness();
    harness.terminal.botOutcomeAttempts = 3;
    harness.terminal.botOutcomeNextAttemptAt = new Date(Date.now() + 300_000);
    await harness.reconcile();
    expect(harness.terminal.botOutcomeFailedAt).toBeNull();
    vi.setSystemTime(Date.now() + 300_000);
    await harness.reconcile();
    await harness.reconcile();
    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeError).toBe("attempts_exhausted");
    expect(harness.receipts()).toBe(1);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.terminal.botOutcomeAttempts).toBe(3);
    expect(harness.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it.each(["delivery", "exhaustion"])(
    "commits outcome success when %s finishes first after an empty recovery read",
    async (first) => {
      vi.useFakeTimers();
      const harness = reconciliationHarness();
      harness.terminal.botOutcomeAttempts = 3;
      harness.terminal.botOutcomeNextAttemptAt = new Date(Date.now() + 300_000);
      const deliveryReady = barrier();
      const releaseDelivery = barrier();
      const recoveryRead = barrier();
      const releaseExhaustion = barrier();
      const commit = harness.transaction.getMockImplementation()!;
      harness.transaction.mockImplementation(async (fn) => {
        await commit(async (tx) => {
          const result = await fn(tx);
          deliveryReady.release();
          await releaseDelivery.promise;
          return result;
        });
        throw new Error("Worker crashed after commit");
      });
      const crashed = expect(
        returnBotMessageOutcome(harness.deps, harness.terminal, sender, "Finished.", "status"),
      ).rejects.toThrow("Worker crashed after commit");
      await deliveryReady.promise;
      expect(harness.deliveries).toHaveLength(0);
      expect(harness.terminal.botOutcomeReturnedAt).toBeNull();

      const readMessages = vi.mocked(harness.deps.prisma.message.findMany);
      const read = readMessages.getMockImplementation()!;
      readMessages.mockImplementationOnce(async (args) => {
        const messages = await read(args);
        recoveryRead.release();
        await releaseExhaustion.promise;
        return messages;
      });
      vi.setSystemTime(Date.now() + 300_000);
      const exhaustion = harness.reconcile();
      await recoveryRead.promise;
      if (first === "delivery") {
        releaseDelivery.release();
        await crashed;
        releaseExhaustion.release();
        await exhaustion;
      } else {
        releaseExhaustion.release();
        await exhaustion;
        expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
        releaseDelivery.release();
        await crashed;
      }
      await harness.reconcile();

      expect(harness.deliveries).toHaveLength(2);
      expect(harness.terminal.status).toBe("completed");
      expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeFailedAt).toBeNull();
      expect(harness.terminal.botOutcomeNextAttemptAt).toBeNull();
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.transaction).toHaveBeenCalledOnce();
      expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
      expect(harness.tx.run.create).toHaveBeenCalledOnce();
      expect(harness.enqueue).not.toHaveBeenCalled();
      expect(harness.receipts()).toBe(first === "exhaustion" ? 1 : 0);
    },
  );

  it.each(["marker write", "transaction commit"])(
    "rolls back automatic delivery when the %s fails on the final attempt",
    async (failure) => {
      const harness = reconciliationHarness();
      harness.terminal.botOutcomeAttempts = 2;
      const error = Object.assign(new Error("Database unavailable"), { code: "P1017" });
      if (failure === "marker write") {
        harness.tx.run.updateMany.mockRejectedValueOnce(error);
      } else {
        harness.transaction.mockImplementationOnce(async (fn) => {
          await fn(harness.tx);
          throw error;
        });
      }

      await harness.reconcile();
      await harness.reconcile();

      expect(harness.deliveries).toHaveLength(0);
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeError).toBe("P1017");
      expect(harness.receipts()).toBe(1);
      expect(harness.transaction).toHaveBeenCalledOnce();
      expect(harness.notify).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["status", "result", "fyi", "absent"] as const).flatMap((source) => [
      { source, crashed: false },
      { source, crashed: true },
    ]),
  )(
    "completes a no-reply $source outcome after a final crash: $crashed",
    async ({ source, crashed }) => {
      vi.useFakeTimers();
      const harness = reconciliationHarness();
      if (source === "absent") harness.terminal.sourceMessageId = null;
      else harness.source.intent = source;
      harness.terminal.botOutcomeAttempts = crashed ? 3 : 2;
      if (crashed) {
        harness.terminal.botOutcomeNextAttemptAt = new Date(Date.now() + 300_000);
        await harness.reconcile();
        expect(harness.terminal.botOutcomeReturnedAt).toBeNull();
        vi.setSystemTime(Date.now() + 300_000);
      } else {
        const update = harness.updateMany.getMockImplementation()!;
        let failed = false;
        harness.updateMany.mockImplementation(async (args) => {
          if (args.data.botOutcomeReturnedAt && args.data.botOutcomeFailedAt === null && !failed) {
            failed = true;
            throw Object.assign(new Error("Completion marker unavailable"), { code: "P1017" });
          }
          return update(args);
        });
      }

      await harness.reconcile();
      await harness.reconcile();

      expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeFailedAt).toBeNull();
      expect(harness.terminal.botOutcomeNextAttemptAt).toBeNull();
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.receipts()).toBe(crashed ? 0 : 1);
      expect(harness.deliveries).toHaveLength(0);
      expect(harness.transaction).not.toHaveBeenCalled();
      expect(harness.tx.run.create).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(["request", "question", undefined] as const)(
    "retains the reply obligation for source intent %s after exhaustion",
    async (intent) => {
      const harness = reconciliationHarness();
      harness.source.intent = intent;
      harness.terminal.botOutcomeAttempts = 3;

      await harness.reconcile();

      expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeError).toBe("attempts_exhausted");
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.transaction).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    { surviving: "both", clearedSource: false },
    { surviving: "inbound", clearedSource: false },
    { surviving: "inbound", clearedSource: true },
    { surviving: "outbound", clearedSource: true },
  ])(
    "recovers a legacy final-attempt crash with $surviving receipts and cleared source: $clearedSource",
    async ({ surviving, clearedSource }) => {
      vi.useFakeTimers();
      const harness = reconciliationHarness();
      harness.terminal.botOutcomeAttempts = 3;
      harness.terminal.botOutcomeNextAttemptAt = new Date(Date.now() + 300_000);
      const delivered = await messageBot(
        harness.deps,
        harness.terminal,
        sender,
        {
          bot_id: "bot-target",
          message: "Finished.",
          intent: "status",
          deliveryKey: `auto-outcome:${run.id}`,
        },
        { allowTerminalSource: true },
      );
      expect(delivered.ok).toBe(true);
      expect(harness.deliveries).toHaveLength(2);
      harness.terminal.botOutcomeReturnedAt = null;
      harness.terminal.botOutcomeNextAttemptAt = new Date(Date.now() + 300_000);
      if (surviving !== "both") {
        const clearedThread = surviving === "outbound" ? "thread-target" : run.threadId;
        harness.deliveries.splice(
          harness.deliveries.findIndex((message) => message.threadId === clearedThread),
          1,
        );
      }
      if (clearedSource) harness.terminal.sourceMessageId = null;
      vi.mocked(harness.deps.prisma.bot.findMany).mockResolvedValue([]);

      await harness.reconcile();
      expect(harness.terminal.botOutcomeReturnedAt).toBeNull();
      vi.setSystemTime(Date.now() + 300_000);
      await harness.reconcile();
      await harness.reconcile();

      expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeFailedAt).toBeNull();
      expect(harness.terminal.botOutcomeNextAttemptAt).toBeNull();
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.terminal.botOutcomeError).toBeNull();
      expect(harness.receipts()).toBe(0);
      expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
      expect(harness.deps.prisma.$transaction).toHaveBeenCalledOnce();
      expect(harness.tx.run.create).toHaveBeenCalledOnce();
      expect(harness.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { markerFailures: 1, delivery: "automatic" },
    { markerFailures: 2, delivery: "automatic" },
    { markerFailures: 1, delivery: "explicit" },
    { markerFailures: 2, delivery: "explicit" },
  ])(
    "recovers a legacy $delivery result after $markerFailures final completion-marker failures",
    async ({ markerFailures, delivery }) => {
      vi.useFakeTimers();
      const harness = reconciliationHarness();
      harness.terminal.botOutcomeAttempts = 2;
      harness.terminal.status = "running";
      const delivered = await messageBot(harness.deps, harness.terminal, sender, {
        bot_id: "bot-target",
        message: "Finished.",
        intent: delivery === "explicit" ? "result" : "status",
        deliveryKey: delivery === "explicit" ? "execution-1" : `auto-outcome:${run.id}`,
      });
      expect(delivered.ok).toBe(true);
      harness.terminal.status = "completed";
      const update = harness.updateMany.getMockImplementation()!;
      let failuresLeft = markerFailures;
      harness.updateMany.mockImplementation(async (args) => {
        if (
          args.data.botOutcomeReturnedAt &&
          args.data.botOutcomeFailedAt === null &&
          failuresLeft > 0
        ) {
          failuresLeft--;
          throw Object.assign(new Error("Completion marker unavailable"), { code: "P1017" });
        }
        return update(args);
      });

      if (markerFailures === 1) {
        await harness.reconcile();
      } else {
        await expect(harness.reconcile()).rejects.toThrow("Completion marker unavailable");
        expect(harness.terminal.botOutcomeReturnedAt).toBeNull();
        expect(harness.terminal.botOutcomeFailedAt).toBeNull();
        await harness.reconcile();
        vi.setSystemTime(Date.now() + 300_000);
        await harness.reconcile();
      }
      await harness.reconcile();

      expect(failuresLeft).toBe(0);
      expect(harness.deliveries).toHaveLength(2);
      expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(harness.terminal.botOutcomeFailedAt).toBeNull();
      expect(harness.terminal.botOutcomeNextAttemptAt).toBeNull();
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.terminal.botOutcomeError).toBe("P1017");
      expect(harness.receipts()).toBe(1);
      expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
      expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(
        delivery === "explicit" ? 1 : 2,
      );
      expect(harness.tx.run.create).toHaveBeenCalledOnce();
      expect(harness.enqueue).toHaveBeenCalledOnce();
      expect(
        harness.updateMany.mock.calls.some(([{ data }]) => data.botOutcomeFailedAt instanceof Date),
      ).toBe(false);
    },
  );

  it.each([
    { spaceId: "other-workspace", userId: run.userId },
    { spaceId: run.spaceId, userId: "other-user" },
  ])("ignores an inbound receipt owned by $spaceId/$userId", async (owner) => {
    const harness = reconciliationHarness();
    harness.terminal.botOutcomeAttempts = 3;
    harness.deliveries.push({
      threadId: "thread-other",
      clientNonce: `bot-message:auto-outcome:${run.id}`,
      role: "user",
      blocks: [],
      ...owner,
    });

    await harness.reconcile();
    await harness.reconcile();

    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeError).toBe("attempts_exhausted");
    expect(harness.terminal.botOutcomeAttempts).toBe(3);
    expect(harness.receipts()).toBe(1);
    expect(harness.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { label: "interim status", intent: "status" },
    { label: "another recipient", toBotId: "bot-other" },
    { label: "another run", runId: "run-other" },
    { label: "another thread", threadId: "thread-other" },
  ])("does not recover an explicit result from $label", async (other) => {
    const harness = reconciliationHarness();
    harness.terminal.botOutcomeAttempts = 3;
    harness.deliveries.push({
      threadId: other.threadId ?? run.threadId,
      runId: other.runId ?? run.id,
      clientNonce: "bot-message-outbound:execution-1",
      role: "bot",
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: other.toBotId ?? "bot-target",
          intent: other.intent ?? "result",
          text: "An update.",
        },
      ],
      spaceId: run.spaceId,
      userId: run.userId,
    });

    await harness.reconcile();
    await harness.reconcile();

    expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
    expect(harness.terminal.botOutcomeError).toBe("attempts_exhausted");
    expect(harness.terminal.botOutcomeAttempts).toBe(3);
    expect(harness.receipts()).toBe(1);
    expect(harness.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the retry durable when enqueue fails", async () => {
    vi.useFakeTimers();
    const harness = reconciliationHarness();
    harness.tx.message.create.mockRejectedValueOnce(new Error("create failed"));
    harness.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(harness.reconcile()).rejects.toThrow("queue unavailable");
    expect(harness.terminal.botOutcomeAttempts).toBe(1);
    await harness.reconcile();
    expect(harness.tx.message.create).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_000);
    await createJobReconciler(harness.deps).reconcileOnce();
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: run.id } }),
    );
    await harness.reconcile();
    expect(harness.terminal.botOutcomeReturnedAt).toBeInstanceOf(Date);
  });

  it("bounds transcript read errors and unavailable recipients too", async () => {
    vi.useFakeTimers();
    for (const failure of ["transcript", "recipient"]) {
      const harness = reconciliationHarness();
      if (failure === "transcript")
        vi.mocked(harness.deps.prisma.message.findMany).mockImplementation(async (args) => {
          if (args?.where?.role === "bot") throw new Error("read failed");
          return [];
        });
      else vi.mocked(harness.deps.prisma.bot.findMany).mockResolvedValue([]);
      for (let tick = 0; tick < 4; tick++) {
        await harness.reconcile();
        vi.setSystemTime(Date.now() + 60_000);
      }
      expect(harness.terminal.botOutcomeAttempts).toBe(3);
      expect(harness.terminal.botOutcomeFailedAt).toBeInstanceOf(Date);
      expect(harness.receipts()).toBe(1);
      expect(harness.tx.message.create).not.toHaveBeenCalled();
    }
  });
});
