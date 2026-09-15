import type { DiscordAdapter } from "@chat-adapter/discord";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { MessagingInboundMessage, MessagingOutboundStatus } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { Adapter, ChatInstance } from "chat";
import { ConsoleLogger } from "chat";
import { createLarkAdapter, Domain } from "chat-adapter-lark";
import { createSendblueAdapter } from "chat-adapter-sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { isVitestRuntime } from "./test-runtime.js";

/** Longest setTimeout delay; shutdown aborts the Gateway instead of waiting this out. */
const DISCORD_GATEWAY_SLICE_MS = 2 ** 31 - 1;
const DISCORD_GATEWAY_RETRY_MIN_MS = 2_000;
const DISCORD_GATEWAY_RETRY_MAX_MS = 5 * 60_000;

const TEAM_ROOM_PROVIDERS = new Set(["slack", "discord"]);

type DiscordGatewayMessage = {
  channelId: string;
  channel: { isThread(): boolean; parentId?: string | null };
};

/**
 * Parsed platform credentials, filled from process.env at the composition
 * roots. A platform mounts when its full credential set is present.
 */
export interface MessagingEnvironmentValues {
  sendblueApiKeyId?: string | undefined;
  sendblueApiSecret?: string | undefined;
  sendblueSigningSecret?: string | undefined;
  sendbluePhoneNumber?: string | undefined;
  slackBotToken?: string | undefined;
  slackSigningSecret?: string | undefined;
  discordBotToken?: string | undefined;
  discordApplicationId?: string | undefined;
  discordRespondToChannelIds?: string | undefined;
  discordMentionRoleIds?: string | undefined;
  whatsappAccessToken?: string | undefined;
  whatsappPhoneNumberId?: string | undefined;
  whatsappAppSecret?: string | undefined;
  whatsappVerifyToken?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramWebhookSecret?: string | undefined;
  larkAppId?: string | undefined;
  larkAppSecret?: string | undefined;
  larkVerificationToken?: string | undefined;
  larkEncryptKey?: string | undefined;
  larkDomain?: string | undefined;
}

export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  // Same trim/empty-to-undefined normalization the API's env loader applies,
  // so a credential with stray whitespace behaves identically in both roles.
  const clean = (value: string | undefined) => value?.trim() || undefined;
  const parsed: MessagingEnvironmentValues = {
    sendblueApiKeyId: clean(env.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: clean(env.SENDBLUE_API_SECRET),
    sendblueSigningSecret: clean(env.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: clean(env.SENDBLUE_PHONE_NUMBER),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackSigningSecret: clean(env.SLACK_SIGNING_SECRET),
    discordBotToken: clean(env.DISCORD_BOT_TOKEN),
    discordApplicationId: clean(env.DISCORD_APPLICATION_ID),
    discordRespondToChannelIds: clean(env.DISCORD_RESPOND_TO_CHANNEL_IDS),
    discordMentionRoleIds: clean(env.DISCORD_MENTION_ROLE_IDS),
    whatsappAccessToken: clean(env.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: clean(env.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: clean(env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET_TOKEN),
    larkAppId: clean(env.LARK_APP_ID),
    larkAppSecret: clean(env.LARK_APP_SECRET),
    larkVerificationToken: clean(env.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: clean(env.LARK_ENCRYPT_KEY),
    larkDomain: clean(env.LARK_DOMAIN),
  };
  assertDiscordCredentials(parsed);
  return parsed;
}

/** Comma-separated platform ids (Discord channel/role allowlists). */
function parseMessagingCsvIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Slack and Discord carry team rooms (workspaces with channels and threads). */
export function isTeamRoomProvider(provider: string): boolean {
  return TEAM_ROOM_PROVIDERS.has(provider);
}

/** The one mounted team-room platform a team-chat bot serves; refuses more than one. */
export function teamChatProviderId(platforms: Array<{ provider: string }>): string | undefined {
  const providers = platforms.map((platform) => platform.provider).filter(isTeamRoomProvider);
  if (providers.length > 1) {
    throw new Error(
      `TEAM_CHAT_BOT_ID serves one team platform, but ${providers.join(" and ")} are both configured. Unset one platform's keys.`,
    );
  }
  return providers[0];
}

/**
 * Build the platform list for every fully configured provider. Group
 * conversations stay sendblue-only until channel semantics are mapped for
 * the other platforms, so their capabilities say so instead of half-working.
 *
 * `pollInboundMessages` must be true only in the one process that also
 * registers the inbound sink (messaging.onInbound — apps/api/src/app.ts).
 * Telegram's "auto" mode starts a long-poll the moment anything calls
 * chat.initialize() when no webhook is registered — and that includes a
 * process that only ever meant to *send*: outbound delivery
 * (sendToThread) lazily initializes too. A second process polling with no
 * inbound sink attached doesn't just do nothing — it actively steals
 * Telegram's single getUpdates slot away from the process that IS
 * listening, so both sides spend every cycle losing a 409 Conflict to the
 * other and messages stop arriving at all. Discord Gateway has the same
 * single-consumer rule: only the API process starts it. Any caller that
 * only sends (e.g. apps/worker/src/index.ts, for messaging.deliver jobs)
 * must leave this false so Telegram mode resolves to "webhook" (passive —
 * resolves bot identity for outbound calls, never polls, and no webhook
 * route is mounted there for it to receive on anyway) and Discord never
 * opens a Gateway.
 */
export function messagingPlatformsFromEnv(
  env: MessagingEnvironmentValues,
  options: { pollInboundMessages?: boolean } = {},
): MessagingPlatform[] {
  assertDiscordCredentials(env);
  const platforms: MessagingPlatform[] = [];

  if (
    env.sendblueApiKeyId &&
    env.sendblueApiSecret &&
    env.sendblueSigningSecret &&
    env.sendbluePhoneNumber
  ) {
    const lineNumber = env.sendbluePhoneNumber;
    const adapter = createSendblueAdapter({
      apiKey: env.sendblueApiKeyId,
      apiSecret: env.sendblueApiSecret,
      defaultFromNumber: lineNumber,
      webhookSecret: env.sendblueSigningSecret,
      allowedServices: ["iMessage", "SMS", "RCS"],
    });
    // chat@4.39 derives thread.isDM solely from the optional Adapter.isDM
    // hook, and chat-adapter-sendblue@0.2.0 omits it — without this every
    // 1:1 message would route as a group. Derive it from the thread id.
    Object.assign(adapter, {
      isDM: (threadId: string) => !adapter.decodeThreadId(threadId).groupId,
    } satisfies Pick<Adapter, "isDM">);
    platforms.push({
      provider: "sendblue",
      capabilities: { direct: true, groups: true, typing: true },
      adapter,
      directThreadId: (address) =>
        adapter.encodeThreadId({ fromNumber: lineNumber, contactNumber: address }),
      peekStatus: (payload) => parseSendblueStatus(payload),
      participants: (raw) => sendblueParticipants(raw, lineNumber),
      channelName: (raw) => sendblueGroupName(raw),
      transport: (raw) => sendblueTransport(raw),
    });
  }

  if (env.slackBotToken && env.slackSigningSecret) {
    platforms.push({
      provider: "slack",
      capabilities: { direct: true, groups: true, typing: false },
      adapter: createSlackAdapter({
        botToken: env.slackBotToken,
        signingSecret: env.slackSigningSecret,
      }),
      enrichTeamRoom: enrichSlackTeamRoom,
    });
  }

  if (env.discordBotToken && env.discordApplicationId) {
    const adapter = createDiscordAdapter({
      botToken: env.discordBotToken,
      applicationId: env.discordApplicationId,
      webhookVerifier: () => false,
      // Explicit empty list prevents the adapter from rereading process.env values.
      respondToChannelIds: [],
      mentionRoleIds: parseMessagingCsvIds(env.discordMentionRoleIds),
      logger: new ConsoleLogger("warn").child("discord"),
    });
    Object.assign(adapter, {
      handleWebhook: async () => new Response("Not found", { status: 404 }),
    } satisfies Pick<Adapter, "handleWebhook">);
    if (options.pollInboundMessages) {
      attachDiscordGateway(adapter, parseMessagingCsvIds(env.discordRespondToChannelIds));
    }
    platforms.push({
      provider: "discord",
      capabilities: { direct: true, groups: true, typing: false },
      adapter,
      enrichTeamRoom: (_raw, base, message) => enrichDiscordTeamRoom(base, message),
    });
  }

  if (
    env.whatsappAccessToken &&
    env.whatsappPhoneNumberId &&
    env.whatsappAppSecret &&
    env.whatsappVerifyToken
  ) {
    platforms.push({
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, typing: false },
      adapter: createWhatsAppAdapter({
        accessToken: env.whatsappAccessToken,
        phoneNumberId: env.whatsappPhoneNumberId,
        appSecret: env.whatsappAppSecret,
        verifyToken: env.whatsappVerifyToken,
      }),
    });
  }

  // Both required: without the secret token the adapter accepts unsigned
  // webhook posts, so a forged update could reach inbound processing.
  if (env.telegramBotToken && env.telegramWebhookSecret) {
    platforms.push({
      provider: "telegram",
      capabilities: { direct: true, groups: false, typing: false },
      // Auto mode: uses the webhook route when Telegram has one registered
      // (checked via getWebhookInfo), and otherwise falls back to
      // long-polling getUpdates. Self-hosted/local deployments typically
      // have no public HTTPS endpoint for Telegram to push to, so the API
      // process calls initialize() at startup (apps/api/src/app.ts) to
      // start that polling loop immediately rather than waiting for the
      // first inbound webhook or outbound send. It must be the API
      // process specifically: that's where the inbound sink is registered,
      // and Telegram allows only one live getUpdates connection per bot —
      // a second poller elsewhere would just steal that slot and drop
      // every message into the void.
      adapter: createTelegramAdapter({
        botToken: env.telegramBotToken,
        secretToken: env.telegramWebhookSecret,
        mode: options.pollInboundMessages ? "auto" : "webhook",
      }),
    });
  }

  // App ID, secret, and verification token are all required: without the
  // token the adapter accepts unsigned webhook posts. Encrypt key and
  // domain are optional (event encryption / open.feishu.cn vs open.larksuite.com).
  if (env.larkAppId && env.larkAppSecret && env.larkVerificationToken) {
    platforms.push({
      provider: "lark",
      capabilities: { direct: true, groups: false, typing: false },
      // Webhook-only: ws/long-connection incoming would consume events so
      // the HTTP webhook at /api/v1/messaging/webhook/lark never sees them.
      adapter: createLarkAdapter({
        appId: env.larkAppId,
        appSecret: env.larkAppSecret,
        verificationToken: env.larkVerificationToken,
        incoming: { events: "webhook", callbacks: "webhook" },
        // Explicit defaults prevent the adapter from rereading untrimmed process.env values.
        encryptKey: env.larkEncryptKey ?? "",
        domain: env.larkDomain?.toLowerCase() === "lark" ? Domain.Lark : Domain.Feishu,
      }),
    });
  }

  return platforms;
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}

/**
 * Linked users run on their own credentials, so linking-only deployments
 * need no deployment key. Open signup provisions users with no credential
 * of their own, so that mode requires the deployment model key — without
 * it their runs cannot execute.
 */
export function isMessagingSurfaceEnabled(
  platforms: MessagingPlatform[],
  options: { deploymentModelKey: string | undefined; openSignup: boolean },
): boolean {
  if (!isMessagingEnabled(platforms)) return false;
  return options.openSignup ? Boolean(options.deploymentModelKey) : true;
}

/** Sendblue reports outbound delivery as webhooks the Chat SDK ignores. */
export function parseSendblueStatus(payload: unknown): MessagingOutboundStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.is_outbound !== true) return null;
  if (typeof body.message_handle !== "string" || !body.message_handle) return null;
  return {
    type: "status",
    provider: "sendblue",
    handle: body.message_handle,
    status: typeof body.status === "string" ? body.status : "",
  };
}

/** Pull Slack team-room fields the Chat SDK does not expose on Message. */
export function enrichSlackTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  if (!root) return {};
  const event = asRecord(root.event) ?? root;
  const teamId =
    stringField(root, "team_id") ?? stringField(event, "team") ?? stringField(event, "team_id");
  const eventType = stringField(event, "type");
  const botProfile = asRecord(event.bot_profile) ?? {};
  const botId = stringField(event, "bot_id") ?? stringField(botProfile, "id");
  const threadTs = stringField(event, "thread_ts");
  const channel = stringField(event, "channel");
  const enrichment: Partial<MessagingInboundMessage> = {};
  if (teamId) enrichment.workspaceId = teamId;
  if (channel) enrichment.conversationKey = channel;
  if (botId) enrichment.senderIsBot = true;
  else if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    enrichment.senderIsBot = true;
  }
  if (threadTs) enrichment.replyThreadId = threadTs;
  else enrichment.replyThreadId = null;
  if (!base.isDirect) {
    const text = stringField(event, "text") ?? base.content;
    const botUserId = slackAuthorizedBotUserId(root);
    // app_mention is Slack's bot-directed event. A bare <@U…> mention of
    // someone else must stay ambient so listen policy still applies.
    enrichment.kind =
      eventType === "app_mention" || mentionsSlackBot(text, botUserId) ? "mention" : "ambient";
  }
  return enrichment;
}

/** Bot user id from Slack's event authorizations (the app that received the event). */
function slackAuthorizedBotUserId(root: Record<string, unknown>): string | undefined {
  const authorizations = root.authorizations;
  if (!Array.isArray(authorizations)) return undefined;
  for (const entry of authorizations) {
    const record = asRecord(entry);
    if (!record || record.is_bot !== true) continue;
    const userId = stringField(record, "user_id");
    if (userId) return userId;
  }
  return undefined;
}

function mentionsSlackBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

/**
 * Discord team-room fields from the thread id (discord:{guild}:{channel}[:{thread}]).
 * Guild id is the workspace (direct messages use "@me"), the parent channel
 * is the conversation key, and a thread id is the in-channel reply thread.
 * The Chat SDK mention flag sets the kind; content keeps its mentions, as on Slack.
 */
export function enrichDiscordTeamRoom(
  base: MessagingInboundMessage,
  message: { isMention: boolean },
): Partial<MessagingInboundMessage> {
  const [, guildId, channelId, threadId] = base.threadId.split(":");
  const enrichment: Partial<MessagingInboundMessage> = { replyThreadId: threadId ?? null };
  if (guildId && guildId !== "@me") enrichment.workspaceId = guildId;
  if (channelId) enrichment.conversationKey = channelId;
  if (!base.isDirect) enrichment.kind = message.isMention ? "mention" : "ambient";
  return enrichment;
}

/**
 * A Discord bot token reaches every server the bot joins and every user who
 * can message it, so the channel allowlist is part of the required set.
 */
function assertDiscordCredentials(env: MessagingEnvironmentValues): void {
  const present = [
    env.discordBotToken,
    env.discordApplicationId,
    env.discordRespondToChannelIds,
    env.discordMentionRoleIds,
  ].some(Boolean);
  if (!present) return;
  if (
    env.discordBotToken &&
    env.discordApplicationId &&
    parseMessagingCsvIds(env.discordRespondToChannelIds).length > 0
  ) {
    return;
  }
  throw new Error(
    "Discord messaging is partially configured. Set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_RESPOND_TO_CHANNEL_IDS (the only channel ids the bot answers) together, or unset every DISCORD_* key.",
  );
}

/**
 * Run the Gateway from initialize() until stopPolling(). A message outside the
 * channel ids (direct messages included) is dropped before the adapter
 * handles it, so it creates no Discord thread.
 */
function attachDiscordGateway(adapter: DiscordAdapter, channelIds: string[]): void {
  const initialize = adapter.initialize.bind(adapter);
  const gateway = adapter as unknown as {
    handleGatewayMessage(message: DiscordGatewayMessage, isMentioned: boolean): Promise<void>;
  };
  const handleGatewayMessage = gateway.handleGatewayMessage.bind(adapter);
  let abort: AbortController | undefined;
  let running: Promise<void> | undefined;
  Object.assign(adapter, {
    initialize: async (chat: ChatInstance) => {
      await initialize(chat);
      abort?.abort();
      abort = new AbortController();
      running = listenOnDiscordGateway(adapter, abort.signal);
    },
    stopPolling: async () => {
      abort?.abort();
      await running?.catch(() => undefined);
    },
    handleGatewayMessage: async (message: DiscordGatewayMessage, isMentioned: boolean) => {
      const roomId = message.channel.isThread()
        ? (message.channel.parentId ?? message.channelId)
        : message.channelId;
      if (!channelIds.includes(roomId)) return;
      await handleGatewayMessage(message, isMentioned);
    },
  });
}

async function listenOnDiscordGateway(adapter: DiscordAdapter, signal: AbortSignal): Promise<void> {
  let retryMs = DISCORD_GATEWAY_RETRY_MIN_MS;
  while (!signal.aborted) {
    const startedAt = Date.now();
    let settle: (error?: unknown) => void = () => undefined;
    const finished = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    const onAbort = () => settle();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await adapter.startGatewayListener(
        {
          waitUntil: (task) => {
            void Promise.resolve(task).then(
              () => settle(),
              (error) => settle(error),
            );
          },
        },
        DISCORD_GATEWAY_SLICE_MS,
        signal,
      );
      if (!response.ok) {
        throw new Error(`Discord Gateway failed to start (${response.status})`);
      }
      await finished;
    } catch (error) {
      getLogger().error("discord gateway listener failed", error);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) return;
    if (Date.now() - startedAt >= DISCORD_GATEWAY_RETRY_MAX_MS) {
      retryMs = DISCORD_GATEWAY_RETRY_MIN_MS;
    }
    await waitUnlessAborted(retryMs, signal);
    retryMs = Math.min(retryMs * 2, DISCORD_GATEWAY_RETRY_MAX_MS);
  }
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function sendblueParticipants(raw: unknown, lineNumber: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const participants = (raw as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return [];
  return participants.filter(
    (entry): entry is string => typeof entry === "string" && entry !== lineNumber,
  );
}

function sendblueGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as { group_display_name?: unknown }).group_display_name;
  return typeof name === "string" && name ? name : null;
}

function sendblueTransport(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const service = (raw as { service?: unknown }).service;
  return service === "iMessage" || service === "SMS" || service === "RCS" ? service : null;
}
