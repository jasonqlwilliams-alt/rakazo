import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { MessagingInboundMessage, MessagingOutboundStatus } from "@rakazo/adapter-kit";
import type { Adapter, ChatInstance } from "chat";
import { createLarkAdapter, Domain } from "chat-adapter-lark";
import { createSendblueAdapter } from "chat-adapter-sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { isVitestRuntime } from "./test-runtime.js";

/** Resident API slices for Discord Gateway; abort on shutdown instead of waiting this out. */
const DISCORD_GATEWAY_SLICE_MS = 12 * 60 * 60 * 1000;

const TEAM_ROOM_PROVIDERS = new Set(["slack", "discord"]);

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
  discordPublicKey?: string | undefined;
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
    discordPublicKey: clean(env.DISCORD_PUBLIC_KEY),
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
export function parseMessagingCsvIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Slack or Discord when that team-room platform is mounted. */
export function teamChatProviderId(platforms: Array<{ provider: string }>): string | undefined {
  return platforms.find((platform) => TEAM_ROOM_PROVIDERS.has(platform.provider))?.provider;
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
    const respondToChannelIds = parseMessagingCsvIds(env.discordRespondToChannelIds);
    const adapter = createDiscordAdapter({
      botToken: env.discordBotToken,
      applicationId: env.discordApplicationId,
      ...(env.discordPublicKey
        ? { publicKey: env.discordPublicKey }
        : { webhookVerifier: () => false }),
      respondToChannelIds,
      mentionRoleIds: parseMessagingCsvIds(env.discordMentionRoleIds),
    });
    if (options.pollInboundMessages) attachDiscordGateway(adapter);
    platforms.push({
      provider: "discord",
      capabilities: { direct: true, groups: true, typing: false },
      adapter,
      enrichTeamRoom: (raw, base) => enrichDiscordTeamRoom(raw, base, { respondToChannelIds }),
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
 * Pull Discord team-room fields the Chat SDK does not expose on Message.
 * Guild id is the workspace, the parent channel is the conversation key,
 * and a thread id is the in-channel reply thread.
 */
export function enrichDiscordTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
  options: { respondToChannelIds?: string[] } = {},
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  const encoded = discordIdsFromThreadId(base.threadId);
  const thread = root ? asRecord(root.thread) : null;
  const guildId = discordGuildId(root, encoded.guildId);
  const parentFromThread = thread ? stringField(thread, "parent_id") : undefined;
  const channelId =
    encoded.channelId ?? parentFromThread ?? (root ? stringField(root, "channel_id") : undefined);
  const replyThreadId =
    encoded.threadId ??
    (thread ? stringField(thread, "id") : undefined) ??
    discordThreadChannelId(root);
  const conversationKey = encoded.channelId ?? parentFromThread ?? channelId;
  const author = root ? asRecord(root.author) : null;
  const enrichment: Partial<MessagingInboundMessage> = {};
  if (guildId) enrichment.workspaceId = guildId;
  if (conversationKey) enrichment.conversationKey = conversationKey;
  if (author?.bot === true) enrichment.senderIsBot = true;
  enrichment.replyThreadId = replyThreadId ?? null;
  if (!base.isDirect) {
    const text = (root ? stringField(root, "content") : undefined) ?? base.content;
    const allowlisted = Boolean(
      conversationKey && options.respondToChannelIds?.includes(conversationKey),
    );
    const mentioned = root?.is_mention === true || discordHasUserMention(text);
    enrichment.kind = allowlisted || mentioned ? "mention" : "ambient";
    const stripped = stripLeadingDiscordMention(text);
    if (stripped !== text) enrichment.content = stripped;
  }
  return enrichment;
}

function assertDiscordCredentials(env: MessagingEnvironmentValues): void {
  const present = [
    env.discordBotToken,
    env.discordApplicationId,
    env.discordPublicKey,
    env.discordRespondToChannelIds,
    env.discordMentionRoleIds,
  ].some(Boolean);
  if (!present) return;
  if (env.discordBotToken && env.discordApplicationId) return;
  throw new Error(
    "Discord messaging is partially configured. Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID together, or unset every DISCORD_* key.",
  );
}

function attachDiscordGateway(adapter: Adapter): void {
  const initialize = adapter.initialize.bind(adapter);
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
  });
}

async function listenOnDiscordGateway(adapter: Adapter, signal: AbortSignal): Promise<void> {
  const startGateway = (
    adapter as Adapter & {
      startGatewayListener?: (
        options: { waitUntil: (task: Promise<unknown>) => void },
        durationMs?: number,
        abortSignal?: AbortSignal,
      ) => Promise<Response>;
    }
  ).startGatewayListener;
  if (!startGateway) return;
  while (!signal.aborted) {
    let settle: (error?: unknown) => void = () => undefined;
    const finished = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    const onAbort = () => settle();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await startGateway.call(
        adapter,
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
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function discordIdsFromThreadId(threadId: string): {
  guildId?: string;
  channelId?: string;
  threadId?: string;
} {
  const parts = threadId.split(":");
  if (parts[0] !== "discord") return {};
  return { guildId: parts[1], channelId: parts[2], threadId: parts[3] };
}

function discordGuildId(
  root: Record<string, unknown> | null,
  encodedGuildId: string | undefined,
): string | undefined {
  const raw = root?.guild_id;
  if (typeof raw === "string" && raw && raw !== "@me") return raw;
  if (encodedGuildId && encodedGuildId !== "@me") return encodedGuildId;
  return undefined;
}

function discordThreadChannelId(root: Record<string, unknown> | null): string | undefined {
  const channelType = root?.channel_type;
  if (channelType !== 11 && channelType !== 12) return undefined;
  return root ? stringField(root, "channel_id") : undefined;
}

function discordHasUserMention(text: string): boolean {
  return /<@!?[^>]+>/.test(text);
}

function stripLeadingDiscordMention(text: string): string {
  return text.replace(/^<@!?[^>]+>\s*/, "");
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
