import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { spawnBot } from "./child-bots.js";
import { directMessagePrompt, MAX_DIRECT_MESSAGE_LENGTH, sendPeerMessage } from "./peer-message.js";

vi.mock("./child-bots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./child-bots.js")>();
  return { ...actual, spawnBot: vi.fn(actual.spawnBot) };
});

const ELEUSIS = {
  id: "bot-eleusis",
  name: "Eleusis",
  workspaceId: "workspace-450778",
  userId: "user-1",
  threadId: "thread-eleusis",
};
const THOR = {
  id: "bot-thor",
  name: "Thor",
  workspaceId: "workspace-450778",
  userId: "user-1",
  threadId: "thread-thor",
};

interface SeedBot {
  id: string;
  name: string;
  workspaceId: string;
  userId: string;
  threadId: string | null;
  archivedAt?: Date | null;
}

interface MessageRow {
  id: string;
  threadId: string;
  role: string;
  blocks: Array<Record<string, unknown>>;
  runId?: string;
}

interface DirectThreadRow {
  id: string;
  workspaceId: string;
  firstBotId: string;
  secondBotId: string;
  nextMessageSeq: number;
}

interface DirectMessageRow {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Array<Record<string, unknown>>;
  senderBotId: string;
  recipientBotId: string;
  clientNonce: string;
  recipientRunId: string;
}

function createStore(bots: SeedBot[], seeded: Array<Omit<MessageRow, "id">> = []) {
  const messages: MessageRow[] = seeded.map((row, index) => ({ id: `seed-${index + 1}`, ...row }));
  const directThreads: DirectThreadRow[] = [];
  const directMessages: DirectMessageRow[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  // The sender is already mid-turn when it calls the tool. Kept out of `runs` so the
  // ids this store hands out stay run-1, run-2, ... for the delivery assertions.
  const callerRuns: Array<Record<string, unknown>> = [
    { id: "run-eleusis", workspaceId: ELEUSIS.workspaceId, status: "running" },
  ];
  const seqByThread = new Map<string, number>();
  const botCreate = vi.fn();
  const runUpdateMany = vi.fn();
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn().mockResolvedValue(undefined);

  const row = (bot: SeedBot) => ({ ...bot, thread: bot.threadId ? { id: bot.threadId } : null });
  const scoped = (bot: SeedBot, where: { workspaceId?: string; userId?: string }) =>
    bot.workspaceId === where.workspaceId && bot.userId === where.userId;

  const tx = {
    thread: {
      update: async ({ where }: { where: { id: string } }) => {
        const next = (seqByThread.get(where.id) ?? 0) + 1;
        seqByThread.set(where.id, next);
        return { nextMessageSeq: next };
      },
    },
    message: {
      create: async ({ data }: { data: Omit<MessageRow, "id"> }) => {
        const created = { id: `msg-${messages.length + 1}`, ...data };
        messages.push(created);
        return created;
      },
    },
    directThread: {
      upsert: async ({
        where,
        create,
      }: {
        where: {
          workspaceId_firstBotId_secondBotId: {
            workspaceId: string;
            firstBotId: string;
            secondBotId: string;
          };
        };
        create: Omit<DirectThreadRow, "id" | "nextMessageSeq">;
      }) => {
        const key = where.workspaceId_firstBotId_secondBotId;
        const found = directThreads.find(
          (thread) =>
            thread.workspaceId === key.workspaceId &&
            thread.firstBotId === key.firstBotId &&
            thread.secondBotId === key.secondBotId,
        );
        if (found) return found;
        const created = {
          id: `direct-thread-${directThreads.length + 1}`,
          nextMessageSeq: 0,
          ...create,
        };
        directThreads.push(created);
        return created;
      },
      update: async ({ where }: { where: { id: string } }) => {
        const thread = directThreads.find((candidate) => candidate.id === where.id)!;
        thread.nextMessageSeq += 1;
        return thread;
      },
    },
    directMessage: {
      findUnique: async ({
        where,
      }: {
        where: { threadId_clientNonce: { threadId: string; clientNonce: string } };
      }) =>
        directMessages.find(
          (message) =>
            message.threadId === where.threadId_clientNonce.threadId &&
            message.clientNonce === where.threadId_clientNonce.clientNonce,
        ) ?? null,
      create: async ({ data }: { data: Omit<DirectMessageRow, "id"> }) => {
        const created = { id: `direct-message-${directMessages.length + 1}`, ...data };
        directMessages.push(created);
        return created;
      },
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(created);
        return created;
      },
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `run-${runs.length + 1}`, ...data };
        runs.push(created);
        return created;
      },
      // createThreadMessageInTransaction checks the writing run is not cancelled.
      findUnique: async ({ where }: { where: { id: string } }) =>
        [...runs, ...callerRuns].find((run) => run.id === where.id) ?? null,
    },
  };

  const prisma = {
    bot: {
      create: botCreate,
      findFirst: async ({ where }: { where: Record<string, string> }) => {
        const found = bots.find(
          (bot) =>
            bot.id === where.id &&
            scoped(bot, where) &&
            (where.archivedAt === null ? !bot.archivedAt : true),
        );
        return found ? row(found) : null;
      },
      findMany: async ({ where }: { where: Record<string, string> }) =>
        bots
          .filter(
            (bot) =>
              bot.name === where.name &&
              scoped(bot, where) &&
              (where.archivedAt === null ? !bot.archivedAt : true),
          )
          .map(row),
    },
    run: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_clientNonce: { workspaceId: string; clientNonce: string } };
      }) =>
        runs.find(
          (run) =>
            run.clientNonce === where.workspaceId_clientNonce.clientNonce &&
            run.workspaceId === where.workspaceId_clientNonce.workspaceId,
        ) ?? null,
      updateMany: runUpdateMany,
    },
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaClient;

  return {
    deps: {
      prisma,
      jobs: { enqueue } as unknown as JobPublisher,
      events: { append } as unknown as ThreadEvents,
    },
    messages,
    tasks,
    runs,
    botCreate,
    runUpdateMany,
    enqueue,
    append,
    directThreads,
    directMessages,
    on: (threadId: string) => messages.filter((message) => message.threadId === threadId),
  };
}

function send(
  store: ReturnType<typeof createStore>,
  input: Partial<Parameters<typeof sendPeerMessage>[1]> = {},
) {
  return sendPeerMessage(store.deps, {
    sender: ELEUSIS,
    messageKey: "tool-call-1",
    name: "Thor",
    text: "CROSSCHAT-PROOF: hold the venue list until I confirm.",
    ...input,
  });
}

describe("peer message delivery", () => {
  it("stores one bot-authored DM in a peer thread and wakes only the target", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store);

    expect(result).toMatchObject({
      ok: true,
      toBotId: THOR.id,
      toName: "Thor",
      directThreadId: "direct-thread-1",
      messageId: "direct-message-1",
      seq: 0,
      role: "bot",
      kind: "direct_message",
      direction: "received",
    });

    expect(store.directThreads).toEqual([
      expect.objectContaining({
        id: "direct-thread-1",
        workspaceId: ELEUSIS.workspaceId,
        firstBotId: ELEUSIS.id,
        secondBotId: THOR.id,
      }),
    ]);
    expect(store.directMessages).toHaveLength(1);
    expect(store.directMessages[0]).toMatchObject({
      threadId: "direct-thread-1",
      seq: 0,
      role: "bot",
      senderBotId: ELEUSIS.id,
      recipientBotId: THOR.id,
      blocks: [
        {
          kind: "direct_message",
          direction: "received",
          fromBotId: ELEUSIS.id,
          fromName: "Eleusis",
          toBotId: THOR.id,
          toName: "Thor",
          text: "CROSSCHAT-PROOF: hold the venue list until I confirm.",
        },
      ],
    });
    expect(store.on(THOR.threadId)).toHaveLength(0);
    expect(store.on(ELEUSIS.threadId)).toHaveLength(0);

    // Only the receiver wakes; the sender already has its own turn.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({
      botId: THOR.id,
      threadId: THOR.threadId,
      status: "queued",
      trigger: "peer",
      clientNonce: "peer:bot-eleusis:bot-thor:tool-call-1",
    });
    expect(store.tasks).toHaveLength(1);
    expect(String(store.tasks[0]?.prompt)).toContain("Eleusis");
    expect(store.enqueue).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.enqueue.mock.calls[0])).toContain(String(store.runs[0]?.id));
    expect(store.append).not.toHaveBeenCalled();
  });

  it("never creates a bot and never routes through spawn_bot", async () => {
    const store = createStore([ELEUSIS, THOR]);

    await send(store);

    expect(store.botCreate).not.toHaveBeenCalled();
    expect(vi.mocked(spawnBot)).not.toHaveBeenCalled();
  });

  it("does not cancel the target's queued work", async () => {
    const store = createStore([ELEUSIS, THOR]);

    await send(store);

    // `threads.send` cancels the bot's other queued runs. A peer DM must not, or an
    // incoming message would silently kill what the user asked for.
    expect(store.runUpdateMany).not.toHaveBeenCalled();
  });

  it("copies neither user thread into the direct thread", async () => {
    const store = createStore(
      [ELEUSIS, THOR],
      [
        {
          threadId: THOR.threadId,
          role: "user",
          blocks: [{ kind: "text", text: "THOR-PRIVATE-1 the invoice numbers" }],
        },
        {
          threadId: THOR.threadId,
          role: "bot",
          blocks: [{ kind: "text", text: "THOR-PRIVATE-2 here they are" }],
        },
        {
          threadId: ELEUSIS.threadId,
          role: "user",
          blocks: [{ kind: "text", text: "ELEUSIS-PRIVATE-1" }],
        },
      ],
    );
    const beforeOnSender = store.on(ELEUSIS.threadId).length;
    const beforeOnTarget = store.on(THOR.threadId).length;

    await send(store);

    expect(store.on(ELEUSIS.threadId)).toHaveLength(beforeOnSender);
    expect(store.on(THOR.threadId)).toHaveLength(beforeOnTarget);
    expect(JSON.stringify(store.directMessages)).not.toContain("THOR-PRIVATE");
    expect(JSON.stringify(store.directMessages)).not.toContain("ELEUSIS-PRIVATE");
  });

  it("delivers a replayed tool call once", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const first = await send(store);
    const second = await send(store);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(store.runs).toHaveLength(1);
    expect(store.directMessages).toHaveLength(1);
    expect(store.enqueue).toHaveBeenCalledOnce();
  });

  it("reuses the canonical peer thread for the reverse direction", async () => {
    const store = createStore([ELEUSIS, THOR]);

    await send(store);
    await sendPeerMessage(store.deps, {
      sender: THOR,
      messageKey: "tool-call-2",
      botId: ELEUSIS.id,
      text: "The venue list is still on hold.",
    });

    expect(store.directThreads).toHaveLength(1);
    expect(store.directMessages).toMatchObject([
      { seq: 0, senderBotId: ELEUSIS.id, recipientBotId: THOR.id },
      { seq: 1, senderBotId: THOR.id, recipientBotId: ELEUSIS.id },
    ]);
  });
});

describe("peer resolution", () => {
  it("resolves by bot id", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store, { name: undefined, botId: THOR.id });

    expect(result).toMatchObject({ ok: true, toBotId: THOR.id, toName: "Thor" });
  });

  it("resolves by exact name and rejects a near miss", async () => {
    const store = createStore([ELEUSIS, THOR]);

    expect(await send(store, { name: "Thor" })).toMatchObject({ ok: true, toBotId: THOR.id });
    expect(await send(store, { name: "thor", messageKey: "tool-call-2" })).toMatchObject({
      error: expect.stringContaining("No bot named"),
    });
  });

  it("refuses when bot_id and name point at different bots", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store, { botId: THOR.id, name: "Flux" });

    expect(result).toMatchObject({ error: expect.stringContaining('is "Thor", not "Flux"') });
    expect(store.runs).toHaveLength(0);
  });

  it("refuses an unknown peer instead of creating one", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store, { name: "Nobody" });

    expect(result).toMatchObject({ error: expect.stringContaining("never creates a bot") });
    expect(store.botCreate).not.toHaveBeenCalled();
    expect(store.runs).toHaveLength(0);
  });

  it("refuses an ambiguous name and lists the ids", async () => {
    const twin = { ...THOR, id: "bot-thor-2", threadId: "thread-thor-2" };
    const store = createStore([ELEUSIS, THOR, twin]);

    const result = await send(store, { name: "Thor" });

    expect(result).toMatchObject({ error: expect.stringContaining("More than one bot") });
    expect(String((result as { error: string }).error)).toContain(THOR.id);
    expect(String((result as { error: string }).error)).toContain(twin.id);
    expect(store.runs).toHaveLength(0);
  });

  it("refuses a self-send", async () => {
    const store = createStore([ELEUSIS, THOR]);

    expect(await send(store, { name: "Eleusis" })).toMatchObject({
      error: expect.stringContaining("cannot send a direct message to itself"),
    });
    expect(await send(store, { name: undefined, botId: ELEUSIS.id })).toMatchObject({
      error: expect.stringContaining("cannot send a direct message to itself"),
    });
    expect(store.runs).toHaveLength(0);
  });

  it("cannot reach a bot in another workspace, by id or by name", async () => {
    const foreign = {
      id: "bot-foreign",
      name: "Thor",
      workspaceId: "workspace-27224",
      userId: "user-2",
      threadId: "thread-foreign",
    };
    const store = createStore([ELEUSIS, foreign]);

    expect(await send(store, { name: "Thor" })).toMatchObject({
      error: expect.stringContaining("No bot named"),
    });
    expect(await send(store, { name: undefined, botId: foreign.id })).toMatchObject({
      error: expect.stringContaining("in this workspace"),
    });
    expect(store.on(foreign.threadId)).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });

  it("requires a target and a message", async () => {
    const store = createStore([ELEUSIS, THOR]);

    expect(await send(store, { name: undefined, botId: undefined })).toMatchObject({
      error: expect.stringContaining("Pass bot_id"),
    });
    expect(await send(store, { text: "   " })).toMatchObject({
      error: expect.stringContaining("text is required"),
    });
  });

  it("refuses a message long enough to be a transcript", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store, { text: "x".repeat(MAX_DIRECT_MESSAGE_LENGTH + 1) });

    expect(result).toMatchObject({ error: expect.stringContaining("not a transcript") });
    expect(store.runs).toHaveLength(0);
  });

  it("refuses a peer that has no execution thread", async () => {
    const store = createStore([ELEUSIS, { ...THOR, threadId: null }]);

    expect(await send(store, { name: "Thor" })).toMatchObject({
      error: expect.stringContaining("no execution thread"),
    });
  });

  it("refuses an archived peer", async () => {
    const store = createStore([ELEUSIS, { ...THOR, archivedAt: new Date(0) }]);

    expect(await send(store, { botId: THOR.id, name: undefined })).toMatchObject({
      error: expect.stringContaining("No bot with id"),
    });
    expect(store.directMessages).toHaveLength(0);
    expect(store.runs).toHaveLength(0);
  });
});

describe("direct message prompt", () => {
  it("frames the message as peer-authored, never as the user", () => {
    const prompt = directMessagePrompt("Eleusis", "Thor", "hold the venue list");

    expect(prompt).toContain('Peer bot "Eleusis"');
    expect(prompt).toContain("This is not the user speaking");
    expect(prompt).toContain("hold the venue list");
    expect(prompt).toContain("send_to_bot");
  });
});
