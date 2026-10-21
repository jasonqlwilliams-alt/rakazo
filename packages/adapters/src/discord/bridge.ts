import type { DiscordRoundtableConfig } from "./config.js";
import { HttpFirstMateTransport } from "./firstmate.js";
import { ackText, formatAgentMessages, formatBridgeNotice } from "./format.js";
import { DiscordRestAdapter } from "./io.js";
import { createBridgeLogger } from "./log.js";
import {
  createMemoryDedupStore,
  type DedupStore,
  decideInbound,
  parseMentionCommand,
  parseSlashCommand,
  selectedSpeakers,
} from "./routing.js";
import {
  type AgentReply,
  type BridgeLogger,
  type DiscordAuthor,
  type DiscordCommand,
  type DiscordCorrelation,
  type DiscordHttpResult,
  type DiscordIO,
  type DiscordLocation,
  type DiscordOutboundMessage,
  type FirstMateTransport,
  INTERACTION_TYPE_APPLICATION_COMMAND,
  INTERACTION_TYPE_PING,
  type RakazoBotRunner,
  type RoundtableSpeaker,
  SPEAKER_LABELS,
} from "./types.js";

export interface DiscordRoundtableBridgeDeps {
  config: Extract<DiscordRoundtableConfig, { enabled: true }>;
  io?: DiscordIO;
  firstmate?: FirstMateTransport;
  rakazo: RakazoBotRunner;
  logger?: BridgeLogger;
  fetch?: typeof fetch;
  dedup?: DedupStore;
  /** Schedules deferred interaction work after the ack has left the handler. */
  schedule?: (run: () => void) => void;
}

export class DiscordRoundtableBridge {
  private stopping = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly io: DiscordIO;
  private readonly firstmate: FirstMateTransport;
  private readonly rakazo: RakazoBotRunner;
  private readonly logger: BridgeLogger;
  private readonly dedup: DedupStore;
  private readonly schedule: (run: () => void) => void;

  constructor(private readonly deps: DiscordRoundtableBridgeDeps) {
    this.logger = deps.logger ?? createBridgeLogger();
    this.io =
      deps.io ??
      new DiscordRestAdapter({ config: deps.config, fetch: deps.fetch, logger: this.logger });
    this.firstmate =
      deps.firstmate ??
      new HttpFirstMateTransport(deps.config.firstmate, { fetch: deps.fetch, logger: this.logger });
    this.rakazo = deps.rakazo;
    this.dedup = deps.dedup ?? createMemoryDedupStore();
    this.schedule =
      deps.schedule ??
      ((run) => {
        setTimeout(run, 0);
      });
  }

  get enabled(): boolean {
    return true;
  }

  async start(): Promise<void> {
    if (!this.deps.config.registerCommandsOnStart) return;
    try {
      await this.io.registerGuildCommands();
      this.logger.info("discord.commands_registered", {
        guildId: this.deps.config.allowlist.guildId,
      });
    } catch {
      this.logger.warn("discord.command_registration_failed", {
        guildId: this.deps.config.allowlist.guildId,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  async handleHttpRequest(input: {
    signature: string;
    timestamp: string;
    rawBody: string;
  }): Promise<DiscordHttpResult> {
    if (!this.io.verifyRequest(input)) {
      this.logger.warn("discord.invalid_signature", {});
      return { status: 401, body: { error: "invalid request signature" } };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }

    if (payload.type === INTERACTION_TYPE_PING) {
      return { status: 200, body: this.io.pong() };
    }

    if (this.stopping) {
      return { status: 503, body: this.io.ephemeral("The Discord bridge is shutting down.") };
    }

    if (payload.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
      return {
        status: 200,
        body: this.io.ephemeral("This app only handles /ask and /roundtable."),
      };
    }

    const decision = this.decideInteraction(payload);
    if (decision.action === "ignore") {
      this.logger.info("discord.ignored", {
        reason: decision.reason,
        eventId: String(payload.id ?? ""),
      });
      if (decision.reason === "duplicate") {
        return { status: 200, body: this.io.deferInteraction() };
      }
      return { status: 200, body: this.io.ephemeral("Ignored.") };
    }
    if (decision.action === "reject") {
      this.logger.info("discord.rejected", {
        reason: decision.reason,
        eventId: String(payload.id ?? ""),
      });
      return { status: 200, body: this.io.ephemeral(decision.message) };
    }

    const token = String(payload.token ?? "");
    return {
      status: 200,
      body: this.io.deferInteraction(),
      afterResponse: this.startAfterAck({
        command: decision.command,
        correlation: decision.correlation,
        token,
      }),
    };
  }

  async handleMentionMessage(input: {
    messageId: string;
    content: string;
    location: DiscordLocation;
    author?: DiscordAuthor;
    botUserId?: string;
  }): Promise<RouteHandleResult> {
    if (this.stopping) {
      return {
        action: "reject",
        reason: "stopping",
        message: "The Discord bridge is shutting down.",
      };
    }
    const parsed = parseMentionCommand(input.content, input.botUserId);
    const decision = decideInbound({
      eventId: input.messageId,
      eventKind: "message",
      messageId: input.messageId,
      location: input.location,
      author: input.author,
      applicationId: this.deps.config.applicationId,
      allowlist: this.deps.config.allowlist,
      command: parsed.ok ? parsed.command : undefined,
      parseError: parsed.ok ? undefined : parsed.message,
      addressed: parsed.ok || parsed.reason !== "not_addressed",
      stopping: this.stopping,
      dedup: this.dedup,
    });
    if (decision.action !== "dispatch") return decision;
    const work = this.dispatchAndPost({
      command: decision.command,
      correlation: decision.correlation,
      channelId: input.location.channelId,
    });
    this.track(work);
    return decision;
  }

  async dispatch(input: {
    command: DiscordCommand;
    correlation: DiscordCorrelation;
    signal?: AbortSignal;
  }): Promise<AgentReply[]> {
    const speakers = selectedSpeakers(input.command);
    const replies = await Promise.all(
      speakers.map((speaker) =>
        this.runSpeaker(speaker, input.command.prompt, input.correlation, input.signal),
      ),
    );
    return replies;
  }

  private startAfterAck(input: {
    command: DiscordCommand;
    correlation: DiscordCorrelation;
    token: string;
  }): () => void {
    let started = false;
    return () => {
      if (started) return;
      started = true;
      const work = new Promise<void>((resolve) => {
        this.schedule(() => {
          void this.dispatchAndPost(input).finally(resolve);
        });
      });
      this.track(work);
    };
  }

  private decideInteraction(payload: Record<string, unknown>) {
    const data = asRecord(payload.data);
    const parsed = parseSlashCommand({
      name: typeof data?.name === "string" ? data.name : undefined,
      options: Array.isArray(data?.options)
        ? (data.options as Array<{ name: string; value?: unknown; options?: unknown[] }>)
        : undefined,
    });
    const channel = asRecord(payload.channel);
    const user = asRecord(payload.member)
      ? asRecord(asRecord(payload.member)?.user)
      : asRecord(payload.user);
    return decideInbound({
      eventId: String(payload.id ?? ""),
      eventKind: "interaction",
      interactionId: String(payload.id ?? ""),
      location: {
        guildId: typeof payload.guild_id === "string" ? payload.guild_id : undefined,
        channelId: typeof payload.channel_id === "string" ? payload.channel_id : undefined,
        parentChannelId: typeof channel?.parent_id === "string" ? channel.parent_id : undefined,
      },
      author: {
        id: typeof user?.id === "string" ? user.id : undefined,
        bot: user?.bot === true,
      },
      applicationId: this.deps.config.applicationId,
      allowlist: this.deps.config.allowlist,
      command: parsed.ok ? parsed.command : undefined,
      parseError: parsed.ok ? undefined : parsed.message,
      stopping: this.stopping,
      dedup: this.dedup,
    });
  }

  private async dispatchAndPost(input: {
    command: DiscordCommand;
    correlation: DiscordCorrelation;
    token?: string;
    channelId?: string;
  }): Promise<void> {
    const speakers = selectedSpeakers(input.command);
    this.logger.info("discord.dispatch", {
      eventId: input.correlation.eventId,
      speakers: speakers.join(","),
      count: speakers.length,
    });
    try {
      if (input.token) {
        await this.io
          .editOriginal(input.token, formatBridgeNotice(ackText(speakers), false))
          .catch((error) => {
            this.logger.warn("discord.ack_edit_failed", {
              eventId: input.correlation.eventId,
              error: error instanceof Error ? error.name : "error",
            });
          });
      }
      const replies = await Promise.all(
        speakers.map((speaker) =>
          this.runSpeaker(speaker, input.command.prompt, input.correlation),
        ),
      );
      const undelivered: UndeliveredReply[] = [];
      for (const reply of replies) {
        const messages = formatAgentMessages({
          speaker: reply.speaker,
          text: reply.error ? reply.error : reply.text,
          correlation: input.correlation,
          ttsEnabled: this.deps.config.ttsEnabled,
        });
        let posted = 0;
        for (const message of messages) {
          try {
            await this.post(input, message);
            posted += 1;
          } catch (error) {
            undelivered.push({ speaker: reply.speaker, posted });
            this.logger.error("discord.reply_post_failed", {
              eventId: input.correlation.eventId,
              speaker: reply.speaker,
              part: posted + 1,
              parts: messages.length,
              error: error instanceof Error ? error.name : "error",
            });
            break;
          }
        }
      }
      if (undelivered.length) await this.postUndeliveredNotice(input, undelivered);
    } catch (error) {
      this.logger.error("discord.dispatch_failed", {
        eventId: input.correlation.eventId,
        error: error instanceof Error ? error.name : "error",
      });
      const notice = formatBridgeNotice(
        "The roundtable request failed before all replies could be posted.",
        false,
      );
      try {
        await this.post(input, notice);
      } catch {
        this.logger.error("discord.failure_notice_failed", { eventId: input.correlation.eventId });
      }
    }
  }

  private async postUndeliveredNotice(
    input: { token?: string; channelId?: string; correlation: DiscordCorrelation },
    undelivered: UndeliveredReply[],
  ): Promise<void> {
    const missing = undelivered.filter((row) => row.posted === 0).map(labelOf);
    const cutShort = undelivered.filter((row) => row.posted > 0).map(labelOf);
    const sentences: string[] = [];
    if (missing.length) {
      sentences.push(
        `Discord would not accept ${joinNames(missing)}'s reply, so it is missing above.`,
      );
    }
    if (cutShort.length) {
      sentences.push(
        `Discord would not accept the rest of ${joinNames(cutShort)}'s reply, so it is cut short above.`,
      );
    }
    const notice = formatBridgeNotice(sentences.join(" "), false);
    try {
      await this.post(input, notice);
    } catch {
      this.logger.error("discord.failure_notice_failed", { eventId: input.correlation.eventId });
    }
  }

  private async post(
    input: { token?: string; channelId?: string },
    message: DiscordOutboundMessage,
  ): Promise<void> {
    if (input.token) await this.io.followUp(input.token, message);
    else if (input.channelId) await this.io.createChannelMessage(input.channelId, message);
  }

  private async runSpeaker(
    speaker: RoundtableSpeaker,
    prompt: string,
    correlation: DiscordCorrelation,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    try {
      return await this.askSpeaker(speaker, prompt, correlation, signal);
    } catch (error) {
      this.logger.error("discord.speaker_failed", {
        eventId: correlation.eventId,
        speaker,
        error: error instanceof Error ? error.name : "error",
      });
      const message = `${SPEAKER_LABELS[speaker]} could not answer this turn.`;
      return { speaker, text: message, error: message };
    }
  }

  private async askSpeaker(
    speaker: RoundtableSpeaker,
    prompt: string,
    correlation: DiscordCorrelation,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    if (speaker === "firstmate") {
      const result = await this.firstmate.ask({ prompt, correlation, signal });
      if (result.ok) return { speaker, text: result.text };
      return {
        speaker,
        text: result.message,
        unavailable: result.unavailable === true,
        error: result.message,
      };
    }
    const result = await this.rakazo.runTurn({
      speaker,
      prompt,
      correlation,
      timeoutMs: this.deps.config.agentTimeoutMs,
      signal,
    });
    if (result.ok) {
      return {
        speaker,
        text: result.text,
        runId: result.runId,
        threadId: result.threadId,
        botId: result.botId,
      };
    }
    return {
      speaker,
      text: result.message,
      error: result.message,
      runId: result.runId,
      threadId: result.threadId,
      botId: result.botId,
    };
  }

  private track(work: Promise<void>) {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
  }
}

type RouteHandleResult = ReturnType<typeof decideInbound>;

interface UndeliveredReply {
  speaker: RoundtableSpeaker;
  posted: number;
}

function labelOf(row: UndeliveredReply): string {
  return SPEAKER_LABELS[row.speaker];
}

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function createDiscordRoundtableBridge(
  deps: DiscordRoundtableBridgeDeps,
): DiscordRoundtableBridge {
  return new DiscordRoundtableBridge(deps);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
