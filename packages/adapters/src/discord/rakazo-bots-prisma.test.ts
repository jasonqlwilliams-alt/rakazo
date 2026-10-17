import { describe, expect, it, vi } from "vitest";
import { createEventRunWaiter, createPrismaDiscordTurnStore } from "./rakazo-bots-prisma.js";
import type { DiscordCorrelation } from "./types.js";

const correlation: DiscordCorrelation = {
  eventId: "interaction-1",
  eventKind: "interaction",
  interactionId: "interaction-1",
  guildId: "g",
  channelId: "c",
};

const bot = {
  id: "flux-id",
  name: "Flux",
  userId: "owner-1",
  workspaceId: "ws",
  threadId: "thread-flux",
};

/**
 * A thread carries two independent counters. Messages advance far more slowly than
 * events, so a cursor taken from one is meaningless to the other.
 */
function fakeThread(options: { historicalEvents: number }) {
  const log: Array<{ seq: number; type: string; runId?: string }> = [];
  for (let i = 0; i < options.historicalEvents; i += 1) {
    log.push({ seq: i, type: "thread.message.created" });
  }
  let nextMessageSeq = 3;
  const scanned: number[] = [];

  const prisma = {
    thread: { update: vi.fn() },
    event: {
      findFirst: vi.fn(async ({ orderBy }: { orderBy: { seq: "asc" | "desc" } }) => {
        if (log.length === 0) return null;
        const sorted = [...log].sort((a, b) => a.seq - b.seq);
        return orderBy.seq === "desc" ? sorted[sorted.length - 1] : sorted[0];
      }),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    run: {
      create: vi.fn(async () => ({ id: "run-1" })),
      findUnique: vi.fn(async () => ({
        id: "run-1",
        threadId: bot.threadId,
        botId: bot.id,
        status: "queued",
        error: null,
      })),
    },
    message: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const events = {
    async append() {
      const seq = log.length;
      log.push({ seq, type: "thread.message.created" });
      return { seq, id: `event-${seq}`, type: "thread.message.created" };
    },
    async *follow(_threadId: string, cursor: number) {
      for (const event of log.filter((row) => row.seq > cursor)) {
        scanned.push(event.seq);
        yield event as never;
      }
    },
  };

  return {
    log,
    scanned,
    prisma,
    events,
    messageSeq: () => nextMessageSeq,
    createMessage: () => {
      const seq = nextMessageSeq;
      nextMessageSeq += 1;
      return { id: `message-${seq}`, seq, blocks: [] };
    },
    completeRun() {
      log.push({ seq: log.length, type: "run.completed", runId: "run-1" });
    },
  };
}

async function turnStoreFor(thread: ReturnType<typeof fakeThread>) {
  const { createThreadMessage } = await import("@rakazo/db");
  vi.mocked(createThreadMessage).mockImplementation(async () => thread.createMessage() as never);
  return createPrismaDiscordTurnStore(thread.prisma as never, thread.events as never);
}

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createThreadMessage: vi.fn(),
}));

describe("discord turn store cursor", () => {
  it("returns the appended event's seq so the waiter does not rescan thread history", async () => {
    const thread = fakeThread({ historicalEvents: 40 });
    const store = await turnStoreFor(thread);

    const created = await store.createDiscordTurn({
      workspaceId: "ws",
      bot,
      speaker: "flux",
      prompt: "harbor status",
      clientNonce: "discord:interaction-1:flux",
      correlation,
    });

    expect(created.afterSeq).toBe(40);
    expect(created.afterSeq).not.toBe(thread.messageSeq() - 1);

    thread.completeRun();
    const waiter = createEventRunWaiter(thread.events as never, store);
    const outcome = await waiter.wait({
      threadId: bot.threadId,
      runId: created.runId,
      afterSeq: created.afterSeq,
      timeoutMs: 1000,
    });

    expect(outcome).toBe("completed");
    expect(thread.scanned).toEqual([41]);
  });

  it("scans the whole history when handed a message-counter cursor", async () => {
    const thread = fakeThread({ historicalEvents: 40 });
    const store = await turnStoreFor(thread);
    const created = await store.createDiscordTurn({
      workspaceId: "ws",
      bot,
      speaker: "flux",
      prompt: "harbor status",
      clientNonce: "discord:interaction-1:flux",
      correlation,
    });
    thread.completeRun();

    const waiter = createEventRunWaiter(thread.events as never, store);
    await waiter.wait({
      threadId: bot.threadId,
      runId: created.runId,
      afterSeq: 3,
      timeoutMs: 1000,
    });

    expect(thread.scanned.length).toBeGreaterThan(30);
  });

  it("resumes a duplicate delivery from the thread's current cursor, not from zero", async () => {
    const thread = fakeThread({ historicalEvents: 40 });
    const store = await turnStoreFor(thread);
    await store.createDiscordTurn({
      workspaceId: "ws",
      bot,
      speaker: "flux",
      prompt: "harbor status",
      clientNonce: "discord:interaction-1:flux",
      correlation,
    });

    const existing = await store.findRunByClientNonce("ws", "discord:interaction-1:flux");
    expect(existing?.afterSeq).toBe(40);

    thread.completeRun();
    const waiter = createEventRunWaiter(thread.events as never, store);
    const outcome = await waiter.wait({
      threadId: bot.threadId,
      runId: "run-1",
      afterSeq: existing?.afterSeq ?? 0,
      timeoutMs: 1000,
    });

    expect(outcome).toBe("completed");
    expect(thread.scanned).toEqual([41]);
  });
});
