import {
  type DiscordAuthor,
  type DiscordCommand,
  type DiscordCorrelation,
  type DiscordLocation,
  ROUNDTABLE_SPEAKERS,
  type RoundtableSpeaker,
  type RouteDecision,
} from "./types.js";

const FIRSTMATE_ALIASES = new Set(["firstmate", "first-mate", "fm", "codex"]);
const SPEAKER_ALIASES: Record<string, RoundtableSpeaker> = {
  firstmate: "firstmate",
  "first-mate": "firstmate",
  fm: "firstmate",
  codex: "firstmate",
  flux: "flux",
  eleusis: "eleusis",
};

const DUPLICATE_TTL_MS = 15 * 60 * 1000;

export interface DedupStore {
  claim(id: string, nowMs?: number): boolean;
  seen(id: string, nowMs?: number): boolean;
}

export function createMemoryDedupStore(ttlMs = DUPLICATE_TTL_MS): DedupStore {
  const seenAt = new Map<string, number>();
  return {
    claim(id, nowMs = Date.now()) {
      prune(seenAt, nowMs, ttlMs);
      if (seenAt.has(id)) return false;
      seenAt.set(id, nowMs);
      return true;
    },
    seen(id, nowMs = Date.now()) {
      prune(seenAt, nowMs, ttlMs);
      return seenAt.has(id);
    },
  };
}

export function isAllowedLocation(
  location: DiscordLocation,
  allowlist: { guildId: string; channelId: string },
): boolean {
  if (location.guildId !== allowlist.guildId) return false;
  return (
    location.channelId === allowlist.channelId || location.parentChannelId === allowlist.channelId
  );
}

export function isBotAuthored(author: DiscordAuthor | undefined, applicationId?: string): boolean {
  if (!author) return false;
  if (author.bot) return true;
  if (author.webhookId) return true;
  if (applicationId && author.applicationId === applicationId) return true;
  return false;
}

export function resolveSpeaker(raw: string | undefined): RoundtableSpeaker | undefined {
  if (!raw) return undefined;
  return SPEAKER_ALIASES[raw.trim().toLowerCase()];
}

export function parseSlashCommand(input: {
  name?: string;
  options?: Array<{ name: string; value?: unknown; options?: unknown[] }>;
}): { ok: true; command: DiscordCommand } | { ok: false; message: string } {
  const name = input.name?.trim().toLowerCase();
  const options = flattenOptions(input.options);
  const prompt = stringifyOption(options.prompt).trim();
  if (name === "ask") {
    const speaker = resolveSpeaker(stringifyOption(options.agent));
    if (!speaker) {
      return { ok: false, message: "Choose FirstMate, Flux, or Eleusis." };
    }
    if (!prompt) return { ok: false, message: "Prompt is required." };
    return { ok: true, command: { kind: "ask", speaker, prompt } };
  }
  if (name === "roundtable") {
    if (!prompt) return { ok: false, message: "Prompt is required." };
    return {
      ok: true,
      command: { kind: "roundtable", speakers: [...ROUNDTABLE_SPEAKERS], prompt },
    };
  }
  return { ok: false, message: "Unknown command. Use /ask or /roundtable." };
}

export function parseMentionCommand(
  content: string,
  botUserId?: string,
):
  | { ok: true; command: DiscordCommand }
  | { ok: false; reason: "not_addressed" | "malformed"; message?: string } {
  let text = content.trim();
  if (botUserId) {
    const mention = new RegExp(`^<@!?${botUserId}>\\s*`);
    if (!mention.test(text)) return { ok: false, reason: "not_addressed" };
    text = text.replace(mention, "").trim();
  }
  if (!text)
    return { ok: false, reason: "malformed", message: "Mention the bot with ask or roundtable." };

  const roundtable = /^(roundtable)\s+([\s\S]+)$/i.exec(text);
  if (roundtable?.[2]) {
    return {
      ok: true,
      command: {
        kind: "roundtable",
        speakers: [...ROUNDTABLE_SPEAKERS],
        prompt: roundtable[2].trim(),
      },
    };
  }

  const ask = /^(?:ask\s+)?(firstmate|first-mate|fm|codex|flux|eleusis)\s+([\s\S]+)$/i.exec(text);
  if (ask?.[1] && ask[2]) {
    const speaker = resolveSpeaker(ask[1]);
    if (!speaker) return { ok: false, reason: "malformed", message: "Unknown agent." };
    return { ok: true, command: { kind: "ask", speaker, prompt: ask[2].trim() } };
  }

  return {
    ok: false,
    reason: "malformed",
    message: "Say `@bot flux …`, `@bot firstmate …`, `@bot eleusis …`, or `@bot roundtable …`.",
  };
}

export function decideInbound(input: {
  eventId: string;
  eventKind: DiscordCorrelation["eventKind"];
  interactionId?: string;
  messageId?: string;
  location: DiscordLocation;
  author?: DiscordAuthor;
  applicationId?: string;
  allowlist: { guildId: string; channelId: string };
  command?: DiscordCommand;
  parseError?: string;
  addressed?: boolean;
  stopping?: boolean;
  dedup: DedupStore;
}): RouteDecision {
  if (input.stopping) {
    return {
      action: "reject",
      reason: "stopping",
      message: "The Discord bridge is shutting down.",
    };
  }
  if (isBotAuthored(input.author, input.applicationId)) {
    return { action: "ignore", reason: "bot_loop" };
  }
  if (!isAllowedLocation(input.location, input.allowlist)) {
    return {
      action: "reject",
      reason: "unauthorized",
      message: "This app only operates in the configured Discord server and channel.",
    };
  }
  if (input.addressed === false) {
    return { action: "ignore", reason: "not_addressed" };
  }
  if (!input.dedup.claim(input.eventId)) {
    return { action: "ignore", reason: "duplicate" };
  }
  if (!input.command) {
    return {
      action: "reject",
      reason: "malformed",
      message: input.parseError ?? "Could not understand that command.",
    };
  }
  const correlation: DiscordCorrelation = {
    eventId: input.eventId,
    eventKind: input.eventKind,
    interactionId: input.interactionId,
    messageId: input.messageId,
    guildId: input.location.guildId ?? "",
    channelId: input.location.channelId ?? "",
    parentChannelId: input.location.parentChannelId,
    userId: input.author?.id,
  };
  return { action: "dispatch", command: input.command, correlation };
}

export function selectedSpeakers(command: DiscordCommand): RoundtableSpeaker[] {
  return command.kind === "ask" ? [command.speaker] : command.speakers;
}

export function isFirstMateAlias(value: string): boolean {
  return FIRSTMATE_ALIASES.has(value.trim().toLowerCase());
}

function flattenOptions(
  options?: Array<{ name: string; value?: unknown; options?: unknown[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const option of options ?? []) {
    if (option.value !== undefined) out[option.name] = option.value;
    if (Array.isArray(option.options)) {
      Object.assign(
        out,
        flattenOptions(
          option.options as Array<{ name: string; value?: unknown; options?: unknown[] }>,
        ),
      );
    }
  }
  return out;
}

function stringifyOption(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function prune(seenAt: Map<string, number>, nowMs: number, ttlMs: number) {
  for (const [id, at] of seenAt) {
    if (nowMs - at > ttlMs) seenAt.delete(id);
  }
}
