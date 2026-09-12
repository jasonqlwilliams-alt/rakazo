import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { DirectMessageBlock } from "@rakazo/contracts";
import { DIRECT_MESSAGE_MAX_LENGTH } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const MAX_DIRECT_MESSAGE_LENGTH = DIRECT_MESSAGE_MAX_LENGTH;

export interface PeerMessageDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

export interface PeerMessageInput {
  sender: {
    id: string;
    name: string;
    spaceId: string;
    userId: string;
  };
  /** Stable per-tool-call key, so a replayed send does not wake the peer twice. */
  messageKey: string;
  botId?: string;
  name?: string;
  text: string;
}

export interface PeerMessageResult {
  ok: true;
  toBotId: string;
  toName: string;
  directThreadId: string;
  messageId: string;
  seq: number;
  role: "bot";
  kind: "direct_message";
  direction: "received";
  peerRunId: string;
  duplicate?: true;
}

/**
 * Send a direct message from one bot to an existing peer bot in the same space.
 *
 * Stores the message once in a peer-to-peer thread, distinct from either bot's
 * user thread, and wakes the target without copying either user's conversation.
 */
export async function sendPeerMessage(
  deps: PeerMessageDeps,
  input: PeerMessageInput,
): Promise<{ error: string } | PeerMessageResult> {
  const text = input.text.trim();
  if (!text) {
    return { error: "text is required — send the direct message you want the other bot to read." };
  }
  if (text.length > MAX_DIRECT_MESSAGE_LENGTH) {
    return {
      error: `text is ${text.length} characters; keep a direct message under ${MAX_DIRECT_MESSAGE_LENGTH}. Send a short message, not a transcript.`,
    };
  }

  const target = await resolvePeer(deps.prisma, input);
  if ("error" in target) return target;

  const block: DirectMessageBlock = {
    kind: "direct_message",
    fromBotId: input.sender.id,
    fromName: input.sender.name,
    toBotId: target.id,
    toName: target.name,
    text,
    direction: "received",
  };
  const firstBotId = input.sender.id < target.id ? input.sender.id : target.id;
  const secondBotId = input.sender.id < target.id ? target.id : input.sender.id;
  const directMessageNonce = `${input.sender.id}:${input.messageKey}`;
  const runNonce = `peer:${input.sender.id}:${target.id}:${input.messageKey}`;

  let committed: Awaited<ReturnType<typeof persistDirectMessage>>;
  try {
    committed = await deps.prisma.$transaction((tx) =>
      persistDirectMessage(tx, {
        spaceId: input.sender.spaceId,
        firstBotId,
        secondBotId,
        senderBotId: input.sender.id,
        recipientBotId: target.id,
        recipientThreadId: target.threadId,
        recipientUserId: target.userId,
        directMessageNonce,
        runNonce,
        block,
        prompt: directMessagePrompt(input.sender.name, target.name, text),
      }),
    );
  } catch (error) {
    const thread = await deps.prisma.directThread.findUnique({
      where: {
        spaceId_firstBotId_secondBotId: {
          spaceId: input.sender.spaceId,
          firstBotId,
          secondBotId,
        },
      },
    });
    if (!thread) throw error;
    const winner = await deps.prisma.directMessage.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: thread.id,
          clientNonce: directMessageNonce,
        },
      },
    });
    if (!winner) throw error;
    committed = { thread, message: winner, duplicate: true };
  }

  if (!committed.duplicate) {
    await deps.jobs
      .enqueue(runContinueJob(committed.message.recipientRunId))
      .catch((error) => getLogger().error("peer message enqueue", error));
  }

  return delivered(target, committed.thread.id, committed.message, committed.duplicate);
}

interface PersistDirectMessageInput {
  spaceId: string;
  firstBotId: string;
  secondBotId: string;
  senderBotId: string;
  recipientBotId: string;
  recipientThreadId: string;
  recipientUserId: string;
  directMessageNonce: string;
  runNonce: string;
  block: DirectMessageBlock;
  prompt: string;
}

async function persistDirectMessage(
  tx: Prisma.TransactionClient,
  input: PersistDirectMessageInput,
) {
  const thread = await tx.directThread.upsert({
    where: {
      spaceId_firstBotId_secondBotId: {
        spaceId: input.spaceId,
        firstBotId: input.firstBotId,
        secondBotId: input.secondBotId,
      },
    },
    create: {
      spaceId: input.spaceId,
      firstBotId: input.firstBotId,
      secondBotId: input.secondBotId,
    },
    update: {},
  });
  const existing = await tx.directMessage.findUnique({
    where: {
      threadId_clientNonce: {
        threadId: thread.id,
        clientNonce: input.directMessageNonce,
      },
    },
  });
  if (existing) return { thread, message: existing, duplicate: true as const };

  const sequence = await tx.directThread.update({
    where: { id: thread.id },
    data: { nextMessageSeq: { increment: 1 } },
    select: { nextMessageSeq: true },
  });
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.recipientBotId,
      threadId: input.recipientThreadId,
      userId: input.recipientUserId,
      prompt: input.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.recipientBotId,
      threadId: input.recipientThreadId,
      taskId: task.id,
      userId: input.recipientUserId,
      status: "queued",
      trigger: "peer",
      clientNonce: input.runNonce,
    },
  });
  const message = await tx.directMessage.create({
    data: {
      threadId: thread.id,
      seq: sequence.nextMessageSeq - 1,
      role: "bot",
      blocks: [input.block] as Prisma.InputJsonValue,
      senderBotId: input.senderBotId,
      recipientBotId: input.recipientBotId,
      clientNonce: input.directMessageNonce,
      recipientRunId: run.id,
    },
  });
  return { thread, message, duplicate: false as const };
}

export function directMessagePrompt(fromName: string, toName: string, text: string) {
  return [
    `Peer bot "${fromName}" sent you a direct message. This is not the user speaking.`,
    "",
    text,
    "",
    `Answer as ${toName}. You cannot see ${fromName}'s user conversation and must not ask for it. If ${fromName} needs a reply, use send_to_bot to send one back.`,
  ].join("\n");
}

interface ResolvedPeer {
  id: string;
  name: string;
  threadId: string;
  userId: string;
}

function delivered(
  target: ResolvedPeer,
  directThreadId: string,
  message: { id: string; seq: number; recipientRunId: string },
  duplicate?: boolean,
): PeerMessageResult {
  return {
    ok: true,
    ...(duplicate ? { duplicate: true as const } : {}),
    toBotId: target.id,
    toName: target.name,
    directThreadId,
    messageId: message.id,
    seq: message.seq,
    role: "bot",
    kind: "direct_message",
    direction: "received",
    peerRunId: message.recipientRunId,
  };
}

async function resolvePeer(
  prisma: PrismaClient,
  input: PeerMessageInput,
): Promise<{ error: string } | ResolvedPeer> {
  const botId = input.botId?.trim();
  const name = input.name?.trim();
  if (!botId && !name) return { error: "Pass bot_id or the peer bot's exact name." };

  // Every lookup is scoped to this bot's own space and user, so a bot id from
  // another space simply does not resolve.
  const scope = { spaceId: input.sender.spaceId, userId: input.sender.userId } as const;

  if (botId) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, ...scope, archivedAt: null },
      include: { thread: true },
    });
    if (!bot) {
      return {
        error: `No bot with id ${botId} in this space. send_to_bot only reaches bots that already exist here; it never creates one.`,
      };
    }
    if (name && name !== bot.name) {
      return {
        error: `bot_id ${botId} is "${bot.name}", not "${name}". Refusing to guess which bot you meant.`,
      };
    }
    return finishResolve(bot, input);
  }

  const matches = await prisma.bot.findMany({
    where: { name, ...scope, archivedAt: null },
    include: { thread: true },
  });
  if (matches.length === 0) {
    return {
      error: `No bot named "${name}" in this space. Names are exact and case-sensitive. send_to_bot never creates a bot.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `More than one bot is named "${name}": ${matches.map((bot) => bot.id).join(", ")}. Pass bot_id.`,
    };
  }
  return finishResolve(matches[0]!, input);
}

function finishResolve(
  bot: { id: string; name: string; userId: string; thread: { id: string } | null },
  input: PeerMessageInput,
): { error: string } | ResolvedPeer {
  if (bot.id === input.sender.id) {
    return { error: "A bot cannot send a direct message to itself." };
  }
  if (!bot.thread) return { error: `Bot "${bot.name}" has no execution thread.` };
  return { id: bot.id, name: bot.name, threadId: bot.thread.id, userId: bot.userId };
}
