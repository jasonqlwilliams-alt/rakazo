import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { spawnBot } from "./child-bots.js";
import { MAX_PEER_NOTE_LENGTH, peerNotePrompt, sendPeerMessage } from "./peer-message.js";

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
}

interface MessageRow {
  id: string;
  threadId: string;
  role: string;
  blocks: Array<Record<string, unknown>>;
  runId?: string;
}

function createStore(bots: SeedBot[], seeded: Array<Omit<MessageRow, "id">> = []) {
  const messages: MessageRow[] = seeded.map((row, index) => ({ id: `seed-${index + 1}`, ...row }));
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
        const found = bots.find((bot) => bot.id === where.id && scoped(bot, where));
        return found ? row(found) : null;
      },
      findMany: async ({ where }: { where: Record<string, string> }) =>
        bots.filter((bot) => bot.name === where.name && scoped(bot, where)).map(row),
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
    on: (threadId: string) => messages.filter((message) => message.threadId === threadId),
  };
}

function send(
  store: ReturnType<typeof createStore>,
  input: Partial<Parameters<typeof sendPeerMessage>[1]> = {},
) {
  return sendPeerMessage(store.deps, {
    sender: ELEUSIS,
    runId: "run-eleusis",
    messageKey: "tool-call-1",
    name: "Thor",
    text: "CROSSCHAT-PROOF: hold the venue list until I confirm.",
    ...input,
  });
}

describe("peer message delivery", () => {
  it("writes one note on each thread and wakes only the target", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store);

    expect(result).toMatchObject({
      ok: true,
      toBotId: THOR.id,
      toName: "Thor",
      toThreadId: THOR.threadId,
    });

    const onThor = store.on(THOR.threadId);
    const onEleusis = store.on(ELEUSIS.threadId);
    expect(onThor).toHaveLength(1);
    expect(onEleusis).toHaveLength(1);
    expect(onThor[0]).toMatchObject({
      role: "system",
      blocks: [
        {
          kind: "agent_note",
          direction: "received",
          fromBotId: ELEUSIS.id,
          fromName: "Eleusis",
          toBotId: THOR.id,
          toName: "Thor",
          text: "CROSSCHAT-PROOF: hold the venue list until I confirm.",
        },
      ],
    });
    expect(onEleusis[0]).toMatchObject({
      role: "bot",
      runId: "run-eleusis",
      blocks: [{ kind: "agent_note", direction: "sent", toBotId: THOR.id, toName: "Thor" }],
    });

    // Same note text on both seats, and nothing else crosses.
    expect(onThor[0]?.blocks[0]?.text).toBe(onEleusis[0]?.blocks[0]?.text);

    // Only the receiver wakes; the sender already has its own turn.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({
      botId: THOR.id,
      threadId: THOR.threadId,
      status: "queued",
      trigger: "peer",
      clientNonce: "peer:tool-call-1",
    });
    expect(store.tasks).toHaveLength(1);
    expect(String(store.tasks[0]?.prompt)).toContain("Eleusis");
    expect(store.enqueue).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.enqueue.mock.calls[0])).toContain(String(store.runs[0]?.id));

    // Both seats update live.
    expect(store.append).toHaveBeenCalledTimes(2);
    expect(store.append.mock.calls.map(([event]) => event.threadId).sort()).toEqual(
      [ELEUSIS.threadId, THOR.threadId].sort(),
    );
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

    // `threads.send` cancels the bot's other queued runs. A peer note must not, or an
    // incoming note would silently kill what the user asked for.
    expect(store.runUpdateMany).not.toHaveBeenCalled();
  });

  it("copies nothing from the target's thread onto the sender's", async () => {
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

    await send(store);

    const senderThread = store.on(ELEUSIS.threadId);
    expect(senderThread).toHaveLength(beforeOnSender + 1);
    expect(JSON.stringify(senderThread)).not.toContain("THOR-PRIVATE");
    expect(JSON.stringify(store.on(THOR.threadId))).not.toContain("ELEUSIS-PRIVATE");
  });

  it("delivers a replayed tool call once", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const first = await send(store);
    const second = await send(store);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(store.runs).toHaveLength(1);
    expect(store.on(THOR.threadId)).toHaveLength(1);
    expect(store.enqueue).toHaveBeenCalledOnce();
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
      error: expect.stringContaining("cannot send a note to itself"),
    });
    expect(await send(store, { name: undefined, botId: ELEUSIS.id })).toMatchObject({
      error: expect.stringContaining("cannot send a note to itself"),
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

  it("requires a target and a note", async () => {
    const store = createStore([ELEUSIS, THOR]);

    expect(await send(store, { name: undefined, botId: undefined })).toMatchObject({
      error: expect.stringContaining("Pass bot_id"),
    });
    expect(await send(store, { text: "   " })).toMatchObject({
      error: expect.stringContaining("text is required"),
    });
  });

  it("refuses a note long enough to be a transcript", async () => {
    const store = createStore([ELEUSIS, THOR]);

    const result = await send(store, { text: "x".repeat(MAX_PEER_NOTE_LENGTH + 1) });

    expect(result).toMatchObject({ error: expect.stringContaining("not a transcript") });
    expect(store.runs).toHaveLength(0);
  });

  it("refuses a peer that has no thread to deliver to", async () => {
    const store = createStore([ELEUSIS, { ...THOR, threadId: null }]);

    expect(await send(store, { name: "Thor" })).toMatchObject({
      error: expect.stringContaining("no thread"),
    });
  });
});

describe("peer note prompt", () => {
  it("frames the note as a peer, never as the user", () => {
    const prompt = peerNotePrompt("Eleusis", "Thor", "hold the venue list");

    expect(prompt).toContain('Peer bot "Eleusis"');
    expect(prompt).toContain("This is not the user speaking");
    expect(prompt).toContain("hold the venue list");
    expect(prompt).toContain("send_to_bot");
  });
});
