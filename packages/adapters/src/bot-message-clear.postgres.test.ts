import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  clearThread,
  createDb,
  createThreadEvents,
  createThreadMessage,
  type PrismaClient,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import { reconcileBotMessageOutcome } from "./bot-outcome-reconciliation.js";
import { userProgressClientNonce } from "./user-progress.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("bot message outcomes across a conversation clear (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Clear test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Clear test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Clear test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = async (name: string) => {
      const created = await prisma.bot.create({
        data: { spaceId: id, userId: id, name, color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: created.id },
      });
      return { id: created.id, name, threadId: thread.id };
    };
    const sender = await bot("Planner");
    const recipient = await bot("Researcher");
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: sender.id,
        threadId: sender.threadId,
        prompt: "Plan",
        status: "running",
      },
    });
    const senderRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: sender.id,
        threadId: sender.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
    };
    const sent = await messageBot(
      deps,
      senderRun,
      { id: sender.id, name: sender.name },
      { bot_id: recipient.id, message: "Find the release date.", intent: "request" },
    );
    expect(sent).toMatchObject({ ok: true });
    const delegated = await prisma.run.findFirstOrThrow({
      where: { threadId: recipient.threadId, trigger: "bot_message" },
    });
    const notices = async () => {
      const messages = await prisma.message.findMany({
        where: { threadId: sender.threadId },
        orderBy: { seq: "asc" },
      });
      return messages
        .flatMap((message) => message.blocks as MessageBlock[])
        .filter((block) => block.kind === "bot_message_received");
    };
    const clear = () =>
      clearThread(prisma, { spaceId: id, threadId: recipient.threadId, botId: recipient.id });
    return { deps, sender, recipient, delegated, notices, clear };
  }

  it("tells the sender a delegated request stopped when the recipient's chat is cleared", async () => {
    const h = await setup();

    await h.clear();
    await reconcileBotMessageOutcome(h.deps, h.delegated.id);

    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "status",
        text: "Stopped. The chat was cleared.",
      }),
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: h.delegated.id } })).toMatchObject({
      status: "cancelled",
      botOutcomeReturnedAt: expect.any(Date),
    });
  });

  it("returns an outcome from a run snapshot read before clear", async () => {
    const h = await setup();
    await h.clear();

    expect(
      await returnBotMessageOutcome(
        h.deps,
        h.delegated,
        { id: h.recipient.id, name: h.recipient.name },
        "Stopped. The chat was cleared.",
        "status",
      ),
    ).toBe(true);
    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "status",
        text: "Stopped. The chat was cleared.",
      }),
    ]);
  });

  it("still returns a finished request's outcome when the chat is cleared before delivery", async () => {
    const h = await setup();
    await prisma.run.update({ where: { id: h.delegated.id }, data: { status: "completed" } });
    await createThreadMessage(prisma, {
      threadId: h.recipient.threadId,
      role: "bot",
      botId: h.recipient.id,
      runId: h.delegated.id,
      blocks: [{ kind: "text", text: "It ships in March." }],
    });

    await h.clear();
    await reconcileBotMessageOutcome(h.deps, h.delegated.id);

    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "status",
        text: "The delegated bot completed its turn, but its written answer was removed when the chat was cleared.",
      }),
    ]);
    expect(
      await prisma.message.findMany({
        where: { threadId: h.recipient.threadId },
        select: { blocks: true },
      }),
    ).toEqual([
      {
        blocks: [
          expect.objectContaining({
            kind: "bot_message_sent",
            intent: "status",
            toBotId: h.sender.id,
          }),
        ],
      },
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: h.delegated.id } })).toMatchObject({
      botMessageSource: { text: "", answerCleared: true },
    });
  });

  it("does not claim an answer was removed when a finished run wrote none", async () => {
    const h = await setup();
    await prisma.run.update({ where: { id: h.delegated.id }, data: { status: "completed" } });

    await h.clear();
    await reconcileBotMessageOutcome(h.deps, h.delegated.id);

    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "status",
        text: "The delegated bot completed its turn without a written summary.",
      }),
    ]);
  });

  it("does not claim an answer was removed when only progress was cleared", async () => {
    const h = await setup();
    await prisma.run.update({ where: { id: h.delegated.id }, data: { status: "completed" } });
    await createThreadMessage(prisma, {
      threadId: h.recipient.threadId,
      role: "bot",
      botId: h.recipient.id,
      runId: h.delegated.id,
      clientNonce: userProgressClientNonce(h.delegated.id),
      blocks: [{ kind: "text", text: "Checking the release calendar." }],
    });

    await h.clear();
    await reconcileBotMessageOutcome(h.deps, h.delegated.id);

    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "status",
        text: "The delegated bot completed its turn without a written summary.",
      }),
    ]);
  });

  it("does not replace an explicit result with a cancellation after clear", async () => {
    const h = await setup();
    await prisma.run.update({ where: { id: h.delegated.id }, data: { status: "running" } });
    expect(
      await messageBot(
        h.deps,
        h.delegated,
        { id: h.recipient.id, name: h.recipient.name },
        { bot_id: h.sender.id, message: "It ships in March.", intent: "result" },
      ),
    ).toMatchObject({ ok: true });
    expect(await h.notices()).toHaveLength(1);

    await h.clear();
    await reconcileBotMessageOutcome(h.deps, h.delegated.id);
    await returnBotMessageOutcome(
      h.deps,
      h.delegated,
      { id: h.recipient.id, name: h.recipient.name },
      "Stopped. The chat was cleared.",
      "status",
    );

    expect(await h.notices()).toEqual([
      expect.objectContaining({
        fromBotId: h.recipient.id,
        intent: "result",
        text: "It ships in March.",
      }),
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: h.delegated.id } })).toMatchObject({
      status: "cancelled",
      botOutcomeReturnedAt: expect.any(Date),
    });
  });
});
