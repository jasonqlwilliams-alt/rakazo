import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  createThreadMessage,
  createThreadMessageInTransaction,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

/**
 * A note is a log line, not a transcript. Anything longer is almost certainly an
 * attempt to paste a conversation into another bot's thread, which this verb refuses.
 */
export const MAX_PEER_NOTE_LENGTH = 2_000;

export interface PeerMessageDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
}

export interface PeerMessageInput {
  sender: {
    id: string;
    name: string;
    threadId: string;
    workspaceId: string;
    userId: string;
  };
  /** The run the sending bot is in. Attributes the sender's own log line. */
  runId: string;
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
  toThreadId: string;
  peerRunId: string;
  duplicate?: true;
}

/**
 * Send a note from one bot to an existing peer bot in the same workspace.
 *
 * Writes one compact `agent_note` on each thread and wakes the target on its own
 * thread. It never creates, reparents, or deletes a bot, and it never copies any
 * other message between the two threads.
 */
export async function sendPeerMessage(
  deps: PeerMessageDeps,
  input: PeerMessageInput,
): Promise<{ error: string } | PeerMessageResult> {
  const text = input.text.trim();
  if (!text) return { error: "text is required — send the note you want the other bot to read." };
  if (text.length > MAX_PEER_NOTE_LENGTH) {
    return {
      error: `text is ${text.length} characters; keep a note under ${MAX_PEER_NOTE_LENGTH}. Send a short note, not a transcript.`,
    };
  }

  const target = await resolvePeer(deps.prisma, input);
  if ("error" in target) return target;

  const note = {
    fromBotId: input.sender.id,
    fromName: input.sender.name,
    toBotId: target.id,
    toName: target.name,
    text,
  } as const;
  const received: MessageBlock = { ...note, kind: "agent_note", direction: "received" };
  const sent: MessageBlock = { ...note, kind: "agent_note", direction: "sent" };

  const clientNonce = `peer:${input.messageKey}`;
  const alreadySent = await deps.prisma.run.findUnique({
    where: {
      workspaceId_clientNonce: { workspaceId: input.sender.workspaceId, clientNonce },
    },
  });
  if (alreadySent) return delivered(target, alreadySent.id, true);

  // The receiving side is one transaction, so a note can never land without the run
  // that makes the peer read it, and the run can never exist without the note.
  let receivedMessageId: string;
  let peerRunId: string;
  try {
    const wake = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "system",
        blocks: [received],
      });
      const task = await tx.task.create({
        data: {
          workspaceId: input.sender.workspaceId,
          botId: target.id,
          threadId: target.threadId,
          userId: target.userId,
          prompt: peerNotePrompt(input.sender.name, target.name, text),
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          workspaceId: input.sender.workspaceId,
          botId: target.id,
          threadId: target.threadId,
          taskId: task.id,
          userId: target.userId,
          status: "queued",
          trigger: "peer",
          clientNonce,
        },
      });
      return { message, run };
    });
    receivedMessageId = wake.message.id;
    peerRunId = wake.run.id;
  } catch (error) {
    const winner = await deps.prisma.run.findUnique({
      where: {
        workspaceId_clientNonce: { workspaceId: input.sender.workspaceId, clientNonce },
      },
    });
    if (!winner) throw error;
    return delivered(target, winner.id, true);
  }

  await deps.events.append({
    workspaceId: input.sender.workspaceId,
    threadId: target.threadId,
    botId: target.id,
    type: "thread.message.created",
    payload: { messageId: receivedMessageId, role: "system", blocks: [received] },
  });

  // The same note, marked outbound, on the sender's own seat. Delivery already
  // happened, so a failure here costs the sender its log line, never the note.
  try {
    const senderMessage = await createThreadMessage(deps.prisma, {
      threadId: input.sender.threadId,
      role: "bot",
      blocks: [sent],
      runId: input.runId,
    });
    await deps.events.append({
      workspaceId: input.sender.workspaceId,
      threadId: input.sender.threadId,
      botId: input.sender.id,
      runId: input.runId,
      type: "thread.message.created",
      payload: { messageId: senderMessage.id, role: "bot", blocks: [sent] },
    });
  } catch (error) {
    console.error("peer message sender note", error);
  }

  // Deliberately no cancellation of the target's queued runs. `threads.send` cancels,
  // because the user retyping supersedes their own queued turn; a peer note must never
  // cancel the user's work, so this matches the bot-initiated `ensureSpawnRun` path.
  await deps.jobs
    .enqueue(runContinueJob(peerRunId))
    .catch((error) => console.error("peer message enqueue", error));

  return delivered(target, peerRunId);
}

export function peerNotePrompt(fromName: string, toName: string, text: string) {
  return [
    `Peer bot "${fromName}" sent you a direct note. This is not the user speaking.`,
    "",
    text,
    "",
    `Answer in your own thread as ${toName}. You cannot see ${fromName}'s conversation and must not ask for it. If ${fromName} needs a reply, use send_to_bot to send one back.`,
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
  peerRunId: string,
  duplicate?: boolean,
): PeerMessageResult {
  return {
    ok: true,
    ...(duplicate ? { duplicate: true as const } : {}),
    toBotId: target.id,
    toName: target.name,
    toThreadId: target.threadId,
    peerRunId,
  };
}

async function resolvePeer(
  prisma: PrismaClient,
  input: PeerMessageInput,
): Promise<{ error: string } | ResolvedPeer> {
  const botId = input.botId?.trim();
  const name = input.name?.trim();
  if (!botId && !name) return { error: "Pass bot_id or the peer bot's exact name." };

  // Every lookup is scoped to this bot's own workspace and user, so a bot id from
  // another workspace simply does not resolve.
  const scope = { workspaceId: input.sender.workspaceId, userId: input.sender.userId } as const;

  if (botId) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, ...scope },
      include: { thread: true },
    });
    if (!bot) {
      return {
        error: `No bot with id ${botId} in this workspace. send_to_bot only reaches bots that already exist here; it never creates one.`,
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
    where: { name, ...scope },
    include: { thread: true },
  });
  if (matches.length === 0) {
    return {
      error: `No bot named "${name}" in this workspace. Names are exact and case-sensitive. send_to_bot never creates a bot.`,
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
    return { error: "A bot cannot send a note to itself. Just say it in this thread." };
  }
  if (!bot.thread) return { error: `Bot "${bot.name}" has no thread to deliver a note to.` };
  return { id: bot.id, name: bot.name, threadId: bot.thread.id, userId: bot.userId };
}
