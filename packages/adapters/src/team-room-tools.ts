import type { ConnectorTool, JobPublisher } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { parseMessagingCsvIds, teamChatProviderId } from "./messaging-platforms.js";
import { resolveMessagingThreadId } from "./team-chat-messaging.js";

export const POST_TO_TEAM_ROOM_TOOL = "post_to_team_room";
export const TEAM_ROOM_TOOL_NAMES = new Set([POST_TO_TEAM_ROOM_TOOL]);

/** Discord's documented message length; Slack is larger, so this is the shared bound. */
export const TEAM_ROOM_TEXT_MAX_CHARS = 2_000;
export const TEAM_ROOM_ROOM_MAX_CHARS = 128;
export const TEAM_ROOM_THREAD_MAX_CHARS = 128;

export const postToTeamRoomSchema = z
  .object({
    room: z.string().trim().min(1).max(TEAM_ROOM_ROOM_MAX_CHARS),
    text: z.string().min(1).max(TEAM_ROOM_TEXT_MAX_CHARS),
    thread: z.string().trim().min(1).max(TEAM_ROOM_THREAD_MAX_CHARS).optional(),
  })
  .strict()
  .refine((args) => args.text.trim().length > 0, { message: "text is required" });

export type PostToTeamRoomArgs = z.infer<typeof postToTeamRoomSchema>;

export function validPostToTeamRoomArgs(args: unknown): boolean {
  return postToTeamRoomSchema.safeParse(args).success;
}

export function selectTeamRoomTools(tools: ConnectorTool[], teamRoomEnabled: boolean) {
  return teamRoomEnabled ? tools : tools.filter((tool) => !TEAM_ROOM_TOOL_NAMES.has(tool.name));
}

export type TeamRoomToolConfig = {
  provider: string;
  envRoomIds: string[];
};

/** Composition-root config: one team platform and its env channel allowlist. */
export function teamRoomToolConfig(
  platforms: Array<{ provider: string }>,
  env: { discordRespondToChannelIds?: string },
): TeamRoomToolConfig | undefined {
  const provider = teamChatProviderId(platforms);
  if (!provider) return undefined;
  return {
    provider,
    envRoomIds: provider === "discord" ? parseMessagingCsvIds(env.discordRespondToChannelIds) : [],
  };
}

export type SeenTeamRoom = {
  externalKey: string;
  displayName: string | null;
  conversationId: string;
  workspaceId: string;
};

export type TeamRoomAllowlistEntry = {
  id: string;
  name: string | null;
  conversationId: string;
};

export function buildTeamRoomAllowlist(
  provider: string,
  envRoomIds: string[],
  seen: SeenTeamRoom[],
): TeamRoomAllowlistEntry[] {
  const byId = new Map<string, TeamRoomAllowlistEntry>();
  for (const row of seen) {
    if (!isTeamRoomSeen(provider, row)) continue;
    byId.set(row.externalKey, {
      id: row.externalKey,
      name: row.displayName,
      conversationId: row.conversationId,
    });
  }
  for (const roomId of envRoomIds) {
    if (byId.has(roomId)) continue;
    byId.set(roomId, {
      id: roomId,
      name: null,
      conversationId: conversationIdForEnvRoom(provider, roomId, seen),
    });
  }
  return [...byId.values()];
}

export function resolveTeamRoom(
  room: string,
  allowlist: TeamRoomAllowlistEntry[],
): TeamRoomAllowlistEntry | null {
  const needle = normalizeRoomKey(room);
  if (!needle) return null;
  for (const entry of allowlist) {
    if (normalizeRoomKey(entry.id) === needle) return entry;
    if (entry.name && normalizeRoomKey(entry.name) === needle) return entry;
    if (normalizeRoomKey(entry.conversationId) === needle) return entry;
  }
  return null;
}

export type PostToTeamRoomDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
  teamRoom: TeamRoomToolConfig;
};

export type PostToTeamRoomResult = { ok: true } | { ok: false; error: string };

/**
 * Enqueue one allowlisted team-room post through the outbound ledger.
 * Retries reuse `deliveryKey` so skipDuplicates cannot insert a second row.
 */
export async function postToTeamRoom(
  deps: PostToTeamRoomDeps,
  input: { room: unknown; text: unknown; thread?: unknown; deliveryKey: string },
): Promise<PostToTeamRoomResult> {
  const parsed = postToTeamRoomSchema.safeParse({
    room: input.room,
    text: input.text,
    ...(input.thread === undefined ? {} : { thread: input.thread }),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid team-room arguments. Text is limited to ${TEAM_ROOM_TEXT_MAX_CHARS} characters.`,
    };
  }
  const deliveryKey = input.deliveryKey.trim();
  if (!deliveryKey) return { ok: false, error: "deliveryKey is required" };

  const seen = await deps.prisma.externalConversation.findMany({
    where: { provider: deps.teamRoom.provider },
    select: {
      externalKey: true,
      displayName: true,
      conversationId: true,
      workspaceId: true,
    },
  });
  const allowlist = buildTeamRoomAllowlist(deps.teamRoom.provider, deps.teamRoom.envRoomIds, seen);
  const room = resolveTeamRoom(parsed.data.room, allowlist);
  if (!room) {
    return { ok: false, error: "That room is not on the team-room allowlist." };
  }

  const idempotencyKey = `team-room:${deliveryKey}`;
  const threadId = resolveMessagingThreadId(room.conversationId, parsed.data.thread ?? null);
  await deps.prisma.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey,
        kind: "group",
        threadId,
        body: parsed.data.text,
      },
    ],
    skipDuplicates: true,
  });
  const recorded = await deps.prisma.messagingOutbound.findUnique({
    where: { idempotencyKey },
    select: { status: true },
  });
  if (!recorded) return { ok: false, error: "Could not record the team-room post." };
  if (recorded.status === "pending") {
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("team room post enqueue error", error);
    });
  }
  return { ok: true };
}

function isTeamRoomSeen(provider: string, row: SeenTeamRoom): boolean {
  if (row.workspaceId === "@me") return false;
  if (row.conversationId.split(":").includes("@me")) return false;
  if (/^(im|mpim):/i.test(row.externalKey)) return false;
  if (provider === "slack") return /^[CG]/i.test(row.externalKey);
  return true;
}

function conversationIdForEnvRoom(provider: string, roomId: string, seen: SeenTeamRoom[]): string {
  const match = seen.find((row) => row.externalKey === roomId);
  if (match) return match.conversationId;
  if (provider === "discord") {
    const guild = seen.find((row) => row.workspaceId && row.workspaceId !== "@me")?.workspaceId;
    return guild ? `discord:${guild}:${roomId}` : `discord:${roomId}`;
  }
  return `${provider}:${roomId}`;
}

function normalizeRoomKey(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}
