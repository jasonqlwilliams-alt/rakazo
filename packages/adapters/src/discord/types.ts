export const ROUNDTABLE_SPEAKERS = ["firstmate", "flux", "eleusis"] as const;
export type RoundtableSpeaker = (typeof ROUNDTABLE_SPEAKERS)[number];

export const SPEAKER_LABELS: Record<RoundtableSpeaker, string> = {
  firstmate: "FirstMate",
  flux: "Flux",
  eleusis: "Eleusis",
};

export interface DiscordAllowlist {
  guildId: string;
  channelId: string;
}

export interface DiscordCorrelation {
  eventId: string;
  eventKind: "interaction" | "message";
  interactionId?: string;
  messageId?: string;
  guildId: string;
  channelId: string;
  parentChannelId?: string;
  userId?: string;
  username?: string;
}

export interface DiscordLocation {
  guildId?: string;
  channelId?: string;
  parentChannelId?: string;
}

export interface DiscordAuthor {
  id?: string;
  bot?: boolean;
  webhookId?: string;
  applicationId?: string;
}

export type DiscordCommand =
  | { kind: "ask"; speaker: RoundtableSpeaker; prompt: string }
  | { kind: "roundtable"; speakers: RoundtableSpeaker[]; prompt: string };

export type RouteDecision =
  | { action: "ignore"; reason: "bot_loop" | "duplicate" | "not_addressed" }
  | { action: "reject"; reason: "unauthorized" | "malformed" | "stopping"; message: string }
  | { action: "dispatch"; command: DiscordCommand; correlation: DiscordCorrelation };

export interface DiscordOutboundMessage {
  content: string;
  tts: boolean;
  embeds?: DiscordEmbed[];
  allowedMentions?: { parse: string[] };
  flags?: number;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  footer?: { text: string };
}

export interface DiscordHttpResult {
  status: number;
  body: Record<string, unknown>;
  /**
   * Set when the bridge deferred the interaction. The transport must call it once the
   * interaction response has been handed to Discord; no webhook call is made before that.
   */
  afterResponse?: () => void;
}

export interface AgentReply {
  speaker: RoundtableSpeaker;
  text: string;
  unavailable?: boolean;
  error?: string;
  runId?: string;
  threadId?: string;
  botId?: string;
}

export interface DiscordVoicePort {
  joinVoiceChannel(channelId: string, signal?: AbortSignal): Promise<void>;
  speakText(text: string, signal?: AbortSignal): Promise<void>;
  leaveVoiceChannel(): Promise<void>;
}

export interface BridgeLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface FirstMateAskRequest {
  prompt: string;
  correlation: DiscordCorrelation;
  signal?: AbortSignal;
}

export type FirstMateAskResult =
  | { ok: true; text: string }
  | { ok: false; unavailable: true; message: string }
  | { ok: false; unavailable?: false; message: string };

export interface FirstMateTransport {
  ask(request: FirstMateAskRequest): Promise<FirstMateAskResult>;
}

export interface RakazoBotTurnRequest {
  speaker: "flux" | "eleusis";
  prompt: string;
  correlation: DiscordCorrelation;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RakazoBotTurnResult =
  | {
      ok: true;
      text: string;
      runId: string;
      threadId: string;
      botId: string;
    }
  | {
      ok: false;
      code: "not_found" | "timeout" | "failed" | "paused" | "cancelled";
      message: string;
      runId?: string;
      threadId?: string;
      botId?: string;
    };

export interface RakazoBotRunner {
  runTurn(request: RakazoBotTurnRequest): Promise<RakazoBotTurnResult>;
}

export interface DiscordIO {
  verifyRequest(input: {
    signature: string;
    timestamp: string;
    rawBody: string;
    nowMs?: number;
  }): boolean;
  deferInteraction(): Record<string, unknown>;
  pong(): Record<string, unknown>;
  ephemeral(message: string): Record<string, unknown>;
  editOriginal(token: string, message: DiscordOutboundMessage, signal?: AbortSignal): Promise<void>;
  followUp(token: string, message: DiscordOutboundMessage, signal?: AbortSignal): Promise<void>;
  createChannelMessage(
    channelId: string,
    message: DiscordOutboundMessage,
    signal?: AbortSignal,
  ): Promise<void>;
  registerGuildCommands(signal?: AbortSignal): Promise<void>;
}

export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_CONTENT_LIMIT = 2000;
export const INTERACTION_TYPE_PING = 1;
export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
export const INTERACTION_CALLBACK_PONG = 1;
export const INTERACTION_CALLBACK_CHANNEL_MESSAGE = 4;
export const INTERACTION_CALLBACK_DEFERRED_CHANNEL_MESSAGE = 5;
export const APPLICATION_COMMAND_CHAT_INPUT = 1;
export const APPLICATION_COMMAND_OPTION_STRING = 3;
