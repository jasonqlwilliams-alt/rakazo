import { createPublicKey, verify } from "node:crypto";
import type { DiscordRoundtableConfig } from "./config.js";
import {
  APPLICATION_COMMAND_CHAT_INPUT,
  APPLICATION_COMMAND_OPTION_STRING,
  type BridgeLogger,
  DISCORD_API_BASE,
  DISCORD_EPHEMERAL_FLAG,
  type DiscordIO,
  type DiscordOutboundMessage,
  type DiscordVoicePort,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_PONG,
} from "./types.js";

const SIGNATURE_SKEW_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 30_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DiscordRestOptions {
  config: Extract<DiscordRoundtableConfig, { enabled: true }>;
  fetch?: typeof fetch;
  logger?: BridgeLogger;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxRetryAfterMs?: number;
}

export function verifyDiscordSignature(input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  rawBody: string;
  nowMs?: number;
  maxSkewMs?: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const timestampMs = Number(input.timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(nowMs - timestampMs) > (input.maxSkewMs ?? SIGNATURE_SKEW_MS)) return false;
  if (!/^[0-9a-f]+$/i.test(input.publicKey) || !/^[0-9a-f]+$/i.test(input.signature)) return false;
  try {
    const raw = Buffer.from(input.publicKey, "hex");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(`${input.timestamp}${input.rawBody}`),
      key,
      Buffer.from(input.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export class DiscordRestAdapter implements DiscordIO {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxRetryAfterMs: number;

  constructor(private readonly options: DiscordRestOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  }

  verifyRequest(input: {
    signature: string;
    timestamp: string;
    rawBody: string;
    nowMs?: number;
  }): boolean {
    return verifyDiscordSignature({
      publicKey: this.options.config.publicKey,
      signature: input.signature,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      nowMs: input.nowMs ?? this.now(),
    });
  }

  pong(): Record<string, unknown> {
    return { type: INTERACTION_CALLBACK_PONG };
  }

  deferInteraction(): Record<string, unknown> {
    return { type: INTERACTION_CALLBACK_DEFERRED_CHANNEL_MESSAGE };
  }

  ephemeral(message: string): Record<string, unknown> {
    return {
      type: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
      data: {
        content: message,
        flags: DISCORD_EPHEMERAL_FLAG,
        allowed_mentions: { parse: [] },
        tts: false,
      },
    };
  }

  async editOriginal(
    token: string,
    message: DiscordOutboundMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/webhooks/${this.options.config.applicationId}/${token}/messages/@original`,
      {
        method: "PATCH",
        body: JSON.stringify(toDiscordMessageBody(message)),
        retryUnknownWebhook: true,
      },
      signal,
    );
  }

  async followUp(
    token: string,
    message: DiscordOutboundMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/webhooks/${this.options.config.applicationId}/${token}`,
      {
        method: "POST",
        body: JSON.stringify(toDiscordMessageBody(message)),
      },
      signal,
    );
  }

  async createChannelMessage(
    channelId: string,
    message: DiscordOutboundMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(toDiscordMessageBody(message)),
        botAuth: true,
      },
      signal,
    );
  }

  async registerGuildCommands(signal?: AbortSignal): Promise<void> {
    await this.request(
      `/applications/${this.options.config.applicationId}/guilds/${this.options.config.allowlist.guildId}/commands`,
      {
        method: "PUT",
        body: JSON.stringify(guildSlashCommands()),
        botAuth: true,
      },
      signal,
    );
  }

  private async request(
    path: string,
    init: { method: string; body?: string; botAuth?: boolean; retryUnknownWebhook?: boolean },
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "Rakazo-DiscordBridge (https://rakazo.com, 0.1.0)",
    };
    if (init.botAuth) headers.authorization = `Bot ${this.options.config.token}`;
    const safePath = redactDiscordPath(path);
    const response = await this.fetchImpl(`${DISCORD_API_BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      signal,
    });
    if (response.status === 429 && attempt < 3) {
      const retryMs = await retryAfterMs(response);
      if (retryMs > this.maxRetryAfterMs) {
        this.options.logger?.error("discord.rate_limit_too_long", {
          path: safePath,
          status: 429,
          retryMs,
          maxRetryAfterMs: this.maxRetryAfterMs,
        });
        throw new Error(
          `Discord asked for a ${Math.round(retryMs / 1000)}s rate-limit wait, beyond the bridge's bound`,
        );
      }
      this.options.logger?.warn("discord.rate_limited", {
        path: safePath,
        status: 429,
        retryMs,
        attempt,
      });
      await this.sleep(retryMs, signal);
      return this.request(path, init, signal, attempt + 1);
    }
    if (response.status >= 500 && attempt < 3) {
      this.options.logger?.warn("discord.upstream_retry", {
        path: safePath,
        status: response.status,
        attempt,
      });
      await this.sleep(250 * 2 ** attempt, signal);
      return this.request(path, init, signal, attempt + 1);
    }
    if (response.status === 404 && init.retryUnknownWebhook && attempt < 3) {
      this.options.logger?.warn("discord.unknown_webhook_retry", {
        path: safePath,
        status: 404,
        attempt,
      });
      await this.sleep(250 * 2 ** attempt, signal);
      return this.request(path, init, signal, attempt + 1);
    }
    if (!response.ok) {
      this.options.logger?.error("discord.request_failed", {
        path: safePath,
        status: response.status,
      });
      throw new Error(`Discord request failed with HTTP ${response.status}`);
    }
    return response;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Discord request was aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Discord request was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function redactDiscordPath(path: string): string {
  return path.replace(/^(\/webhooks\/[^/]+\/)[^/]+/, "$1[redacted]");
}

export function guildSlashCommands() {
  return [
    {
      name: "ask",
      description: "Ask one Rakazo roundtable agent",
      type: APPLICATION_COMMAND_CHAT_INPUT,
      options: [
        {
          name: "agent",
          description: "Which agent should answer",
          type: APPLICATION_COMMAND_OPTION_STRING,
          required: true,
          choices: [
            { name: "FirstMate", value: "firstmate" },
            { name: "Flux", value: "flux" },
            { name: "Eleusis", value: "eleusis" },
          ],
        },
        {
          name: "prompt",
          description: "What to ask",
          type: APPLICATION_COMMAND_OPTION_STRING,
          required: true,
        },
      ],
    },
    {
      name: "roundtable",
      description: "Ask FirstMate, Flux, and Eleusis once each",
      type: APPLICATION_COMMAND_CHAT_INPUT,
      options: [
        {
          name: "prompt",
          description: "What to ask the roundtable",
          type: APPLICATION_COMMAND_OPTION_STRING,
          required: true,
        },
      ],
    },
  ];
}

export function unsupportedDiscordVoicePort(): DiscordVoicePort {
  return {
    async joinVoiceChannel() {
      throw new Error("Phase 1 does not join Discord voice channels.");
    },
    async speakText() {
      throw new Error("Phase 1 posts TTS-capable text messages; it does not speak in voice.");
    },
    async leaveVoiceChannel() {
      throw new Error("Phase 1 does not join Discord voice channels.");
    },
  };
}

function toDiscordMessageBody(message: DiscordOutboundMessage): Record<string, unknown> {
  return {
    content: message.content,
    tts: message.tts,
    embeds: message.embeds,
    allowed_mentions: message.allowedMentions ?? { parse: [] },
    flags: message.flags,
  };
}

async function retryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  try {
    const body = (await response.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // Discord rate-limit bodies are optional; fall through to a short backoff.
  }
  return 1000;
}
