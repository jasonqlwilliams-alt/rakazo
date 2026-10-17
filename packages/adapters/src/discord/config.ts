import type { DiscordAllowlist } from "./types.js";

const ENABLING_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_CHANNEL_ID",
  "DISCORD_WORKSPACE_ID",
] as const;

export interface DiscordBotTarget {
  id?: string;
  name: string;
}

export interface FirstMateTransportConfig {
  url?: string;
  token?: string;
  timeoutMs: number;
}

export type DiscordRoundtableConfig =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      publicKey: string;
      applicationId: string;
      allowlist: DiscordAllowlist;
      workspaceId: string;
      flux: DiscordBotTarget;
      eleusis: DiscordBotTarget;
      firstmate: FirstMateTransportConfig;
      ttsEnabled: boolean;
      agentTimeoutMs: number;
      registerCommandsOnStart: boolean;
    };

export function loadDiscordRoundtableConfig(
  source: NodeJS.ProcessEnv = process.env,
): DiscordRoundtableConfig {
  const present = ENABLING_KEYS.filter((key) => Boolean(source[key]?.trim()));
  if (present.length === 0) return { enabled: false };

  const missing = ENABLING_KEYS.filter((key) => !source[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Discord roundtable bridge is partially configured. Missing ${missing.join(", ")}. Set every required field or unset all Discord fields.`,
    );
  }

  return {
    enabled: true,
    token: source.DISCORD_BOT_TOKEN!.trim(),
    publicKey: source.DISCORD_PUBLIC_KEY!.trim(),
    applicationId: source.DISCORD_APPLICATION_ID!.trim(),
    allowlist: {
      guildId: source.DISCORD_GUILD_ID!.trim(),
      channelId: source.DISCORD_CHANNEL_ID!.trim(),
    },
    workspaceId: source.DISCORD_WORKSPACE_ID!.trim(),
    flux: {
      id: optional(source.DISCORD_FLUX_BOT_ID),
      name: source.DISCORD_FLUX_BOT_NAME?.trim() || "Flux",
    },
    eleusis: {
      id: optional(source.DISCORD_ELEUSIS_BOT_ID),
      name: source.DISCORD_ELEUSIS_BOT_NAME?.trim() || "Eleusis",
    },
    firstmate: {
      url: optional(source.FIRSTMATE_TRANSPORT_URL),
      token: optional(source.FIRSTMATE_TRANSPORT_TOKEN),
      timeoutMs: readPositiveInt(source.FIRSTMATE_TRANSPORT_TIMEOUT_MS, 30_000),
    },
    ttsEnabled: readBoolean(source.DISCORD_TTS_ENABLED, false),
    agentTimeoutMs: readPositiveInt(source.DISCORD_AGENT_TIMEOUT_MS, 180_000),
    registerCommandsOnStart: readBoolean(source.DISCORD_REGISTER_COMMANDS, true),
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return Math.floor(parsed);
}
