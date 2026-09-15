import { EventEmitter } from "node:events";
import type { MessagingInboundEvent } from "@rakazo/adapter-kit";
import { Domain } from "chat-adapter-lark";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import {
  enrichDiscordTeamRoom,
  enrichSlackTeamRoom,
  isMessagingEnabled,
  isMessagingSurfaceEnabled,
  type MessagingEnvironmentValues,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  parseSendblueStatus,
  teamChatProviderId,
} from "./messaging-platforms.js";

// Fake credentials: adapters are constructed offline, never called.
const fullEnv: MessagingEnvironmentValues = {
  sendblueApiKeyId: "sb-key-id",
  sendblueApiSecret: "sb-secret",
  sendblueSigningSecret: "sb-signing",
  sendbluePhoneNumber: "+15550009999",
  slackBotToken: "xoxb-fake",
  slackSigningSecret: "slack-signing",
  discordBotToken: "discord-bot-token",
  discordApplicationId: "discord-app-id",
  discordRespondToChannelIds: "channel-1",
  whatsappAccessToken: "wa-token",
  whatsappPhoneNumberId: "wa-phone-id",
  whatsappAppSecret: "wa-app-secret",
  whatsappVerifyToken: "wa-verify",
  telegramBotToken: "tg-token",
  telegramWebhookSecret: "tg-webhook-secret",
  larkAppId: "cli-fake",
  larkAppSecret: "lark-secret",
  larkVerificationToken: "lark-verify",
};

function providers(env: MessagingEnvironmentValues): string[] {
  return messagingPlatformsFromEnv(env).map((platform) => platform.provider);
}

describe("messagingPlatformsFromEnv", () => {
  it("mounts nothing without credentials and everything with full credentials", () => {
    expect(providers({})).toEqual([]);
    expect(providers(fullEnv)).toEqual([
      "sendblue",
      "slack",
      "discord",
      "whatsapp",
      "telegram",
      "lark",
    ]);
  });

  it("requires all four sendblue values", () => {
    for (const key of [
      "sendblueApiKeyId",
      "sendblueApiSecret",
      "sendblueSigningSecret",
      "sendbluePhoneNumber",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("sendblue");
    }
  });

  it("requires each platform's full credential set", () => {
    expect(providers({ ...fullEnv, slackSigningSecret: undefined })).not.toContain("slack");
    expect(providers({ ...fullEnv, slackBotToken: undefined })).not.toContain("slack");
    for (const key of [
      "whatsappAccessToken",
      "whatsappPhoneNumberId",
      "whatsappAppSecret",
      "whatsappVerifyToken",
    ] as const) {
      expect(providers({ ...fullEnv, [key]: undefined })).not.toContain("whatsapp");
    }
    expect(providers({ ...fullEnv, telegramBotToken: undefined })).not.toContain("telegram");
    // Without the secret token the adapter would accept unsigned webhook
    // posts, so the secret is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, telegramWebhookSecret: undefined })).not.toContain("telegram");
    expect(providers({ telegramBotToken: "tg-token" })).toEqual([]);
    expect(
      providers({ telegramBotToken: "tg-token", telegramWebhookSecret: "tg-webhook-secret" }),
    ).toEqual(["telegram"]);
    expect(providers({ ...fullEnv, larkAppId: undefined })).not.toContain("lark");
    expect(providers({ ...fullEnv, larkAppSecret: undefined })).not.toContain("lark");
    // Without the verification token the adapter would accept unsigned
    // webhook posts, so the token is a mount gate, not optional hardening.
    expect(providers({ ...fullEnv, larkVerificationToken: undefined })).not.toContain("lark");
    expect(providers({ larkAppId: "cli-fake", larkAppSecret: "lark-secret" })).toEqual([]);
    expect(
      providers({
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }),
    ).toEqual(["lark"]);
  });

  it("forces Telegram into webhook mode so worker initialize cannot long-poll", () => {
    const telegram = messagingPlatformsFromEnv({
      telegramBotToken: "tg-token",
      telegramWebhookSecret: "tg-webhook-secret",
    })[0]!;
    // mode is protected on the adapter class but readable at runtime.
    expect((telegram.adapter as unknown as { mode: string }).mode).toBe("webhook");
  });

  it("forces Lark into webhook inbound so worker initialize cannot open a long connection", () => {
    const lark = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
    })[0]!;
    const incoming = lark.adapter as unknown as {
      incomingConfig: { events: string; callbacks: string };
      shouldStartWsClient: () => boolean;
    };
    expect(incoming.incomingConfig).toEqual({ events: "webhook", callbacks: "webhook" });
    expect(incoming.shouldStartWsClient()).toBe(false);
  });

  it("maps LARK_* process env and accepts the international domain switch", () => {
    expect(
      messagingEnvFromProcess({
        LARK_APP_ID: " cli-fake ",
        LARK_APP_SECRET: " lark-secret ",
        LARK_VERIFICATION_TOKEN: " lark-verify ",
        LARK_ENCRYPT_KEY: " lark-encrypt ",
        LARK_DOMAIN: " Lark ",
      }),
    ).toMatchObject({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkEncryptKey: "lark-encrypt",
      larkDomain: "Lark",
    });
    const international = messagingPlatformsFromEnv({
      larkAppId: "cli-fake",
      larkAppSecret: "lark-secret",
      larkVerificationToken: "lark-verify",
      larkDomain: "Lark",
    })[0]!;
    expect((international.adapter as unknown as { config: { domain: Domain } }).config.domain).toBe(
      Domain.Lark,
    );
  });

  it.each(["", "unknown", "feishu"])("uses normalized Lark defaults for domain %s", (domain) => {
    vi.stubEnv("LARK_DOMAIN", domain);
    vi.stubEnv("LARK_ENCRYPT_KEY", "   ");
    try {
      const lark = messagingPlatformsFromEnv({
        ...messagingEnvFromProcess(process.env),
        larkAppId: "cli-fake",
        larkAppSecret: "lark-secret",
        larkVerificationToken: "lark-verify",
      }).find((platform) => platform.provider === "lark")!;
      const config = (
        lark.adapter as unknown as {
          config: { domain: Domain; encryptKey: string };
        }
      ).config;
      expect(config.domain).toBe(Domain.Feishu);
      expect(config.encryptKey).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("declares group and typing support only for sendblue", () => {
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const capabilities = Object.fromEntries(
      platforms.map((platform) => [platform.provider, platform.capabilities]),
    );
    expect(capabilities.sendblue).toEqual({ direct: true, groups: true, typing: true });
    expect(capabilities.slack).toEqual({ direct: true, groups: true, typing: false });
    expect(capabilities.discord).toEqual({ direct: true, groups: true, typing: false });
    expect(capabilities.whatsapp).toEqual({ direct: true, groups: false, typing: false });
    expect(capabilities.telegram).toEqual({ direct: true, groups: false, typing: false });
    expect(capabilities.lark).toEqual({ direct: true, groups: false, typing: false });
  });
});

describe("sendblue platform hooks", () => {
  const sendblue = messagingPlatformsFromEnv(fullEnv)[0]!;

  it("filters the deployment line and non-string entries out of the roster", () => {
    expect(
      sendblue.participants!({
        participants: ["+15551111111", "+15550009999", 42, null, "+15552222222"],
      }),
    ).toEqual(["+15551111111", "+15552222222"]);
    expect(sendblue.participants!({ participants: "not-a-list" })).toEqual([]);
    expect(sendblue.participants!(null)).toEqual([]);
  });

  it("reads the group display name only when present", () => {
    expect(sendblue.channelName!({ group_display_name: "Family" })).toBe("Family");
    expect(sendblue.channelName!({ group_display_name: "" })).toBeNull();
    expect(sendblue.channelName!({})).toBeNull();
    expect(sendblue.channelName!(null)).toBeNull();
  });

  it("accepts only supported per-message transports", () => {
    for (const service of ["iMessage", "SMS", "RCS"]) {
      expect(sendblue.transport!({ service })).toBe(service);
    }
    expect(sendblue.transport!({ service: "email" })).toBeNull();
    expect(sendblue.transport!({ service: 42 })).toBeNull();
    expect(sendblue.transport!(null)).toBeNull();
  });

  it("derives deterministic provider-prefixed direct thread ids", () => {
    expect(sendblue.directThreadId!("+15551234567")).toMatch(/^sendblue:/);
    expect(sendblue.adapter.isDM?.(sendblue.directThreadId!("+15551234567"))).toBe(true);
  });
});

describe("parseSendblueStatus", () => {
  const statusPayload = {
    content: "",
    is_outbound: true,
    status: "DELIVERED",
    message_handle: "handle-1",
    from_number: "+15550009999",
  };

  it("normalizes outbound delivery webhooks", () => {
    expect(parseSendblueStatus(statusPayload)).toEqual({
      type: "status",
      provider: "sendblue",
      handle: "handle-1",
      status: "DELIVERED",
    });
    expect(parseSendblueStatus({ ...statusPayload, status: 7 })).toEqual(
      expect.objectContaining({ status: "" }),
    );
  });

  it("ignores inbound and malformed payloads", () => {
    expect(parseSendblueStatus({ ...statusPayload, is_outbound: false })).toBeNull();
    expect(parseSendblueStatus({ ...statusPayload, message_handle: "" })).toBeNull();
    const { message_handle: _dropped, ...withoutHandle } = statusPayload;
    expect(parseSendblueStatus(withoutHandle)).toBeNull();
    expect(parseSendblueStatus(null)).toBeNull();
    expect(parseSendblueStatus("nope")).toBeNull();
  });
});

describe("isMessagingEnabled", () => {
  it("requires at least one platform", () => {
    vi.stubEnv("VITEST", "");
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    expect(isMessagingEnabled([])).toBe(false);
    vi.unstubAllEnvs();
  });

  it("is disabled under vitest even with platforms configured", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(false);
  });

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(isMessagingEnabled(messagingPlatformsFromEnv(fullEnv))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("isMessagingSurfaceEnabled", () => {
  it("requires the deployment model key only for open signup", () => {
    vi.stubEnv("VITEST", "");
    const platforms = messagingPlatformsFromEnv(fullEnv);
    const key = (deploymentModelKey: string | undefined, openSignup: boolean) => ({
      deploymentModelKey,
      openSignup,
    });
    // Open signup provisions users with no credentials of their own.
    expect(isMessagingSurfaceEnabled(platforms, key("model-key", true))).toBe(true);
    expect(isMessagingSurfaceEnabled(platforms, key(undefined, true))).toBe(false);
    // Linking-only deployments run linked users on their own credentials.
    expect(isMessagingSurfaceEnabled(platforms, key(undefined, false))).toBe(true);
    expect(isMessagingSurfaceEnabled([], key("model-key", true))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("enrichSlackTeamRoom", () => {
  const base = {
    type: "message" as const,
    provider: "slack",
    handle: "Ev1",
    threadId: "slack:C1",
    isDirect: false,
    from: "U_OTHER",
    fromLabel: "Ada",
    channelName: "launch",
    participants: ["U_OTHER"],
    content: "hello <@U_SOMEONE>",
    mediaUrl: null,
  };

  it("marks app_mention events as mention", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: { type: "app_mention", channel: "C1", text: "<@U_BOT> ship it", user: "U_OTHER" },
      },
      base,
    );
    expect(enrichment.kind).toBe("mention");
    expect(enrichment.workspaceId).toBe("T1");
    expect(enrichment.conversationKey).toBe("C1");
  });

  it("keeps ambient when another user is mentioned, not the bot", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: {
          type: "message",
          channel: "C1",
          text: "hey <@U_SOMEONE> can you look?",
          user: "U_OTHER",
        },
      },
      base,
    );
    expect(enrichment.kind).toBe("ambient");
  });

  it("marks message events that mention the authorized bot as mention", () => {
    const enrichment = enrichSlackTeamRoom(
      {
        team_id: "T1",
        authorizations: [{ user_id: "U_BOT", is_bot: true }],
        event: {
          type: "message",
          channel: "C1",
          text: "hey <@U_BOT> ship Friday?",
          user: "U_OTHER",
        },
      },
      base,
    );
    expect(enrichment.kind).toBe("mention");
  });
});

describe("discord platform", () => {
  const discordEnv = {
    discordBotToken: "discord-bot-token",
    discordApplicationId: "discord-app-id",
    discordRespondToChannelIds: " channel-1 , channel-2 ",
  };
  type DiscordGatewayAdapter = {
    startGatewayListener: (
      options: { waitUntil: (task: Promise<unknown>) => void },
      ...rest: unknown[]
    ) => Promise<Response>;
    createDiscordThread: (channelId: string, messageId: string) => Promise<{ id: string }>;
    setupLegacyGatewayHandlers: (client: EventEmitter, isShuttingDown: () => boolean) => void;
    stopPolling?: () => Promise<void>;
  };

  function gatewayMessage(input: {
    id: string;
    channelId: string;
    guildId?: string | null;
    parentId?: string;
    authorIsBot?: boolean;
    mentionsBot?: boolean;
  }) {
    return {
      id: input.id,
      channelId: input.channelId,
      guildId: input.guildId === undefined ? "guild-1" : input.guildId,
      content: input.mentionsBot ? "<@discord-app-id> ship it" : "ship it",
      author: {
        id: input.authorIsBot ? "other-bot" : "user-1",
        username: "ada",
        displayName: "Ada",
        bot: Boolean(input.authorIsBot),
      },
      mentions: {
        has: (id: string) => Boolean(input.mentionsBot) && id === "discord-app-id",
        roles: [],
        everyone: false,
      },
      channel: { isThread: () => Boolean(input.parentId), parentId: input.parentId ?? null },
      attachments: new Map(),
      createdAt: new Date(0),
      editedAt: null,
    };
  }

  it("refuses a partial DISCORD_* set and stays off when none are set", () => {
    expect(messagingEnvFromProcess({})).not.toMatchObject({
      discordBotToken: expect.anything(),
    });
    expect(providers({})).toEqual([]);
    expect(() => messagingEnvFromProcess({ DISCORD_BOT_TOKEN: " discord-bot-token " })).toThrow(
      /partially configured/,
    );
    expect(() => messagingEnvFromProcess({ DISCORD_APPLICATION_ID: "discord-app-id" })).toThrow(
      /partially configured/,
    );
    expect(() => messagingEnvFromProcess({ DISCORD_RESPOND_TO_CHANNEL_IDS: "channel-1" })).toThrow(
      /partially configured/,
    );
    expect(() => messagingPlatformsFromEnv({ discordBotToken: "discord-bot-token" })).toThrow(
      /partially configured/,
    );
  });

  it("refuses Discord without a channel allowlist, with or without team chat", () => {
    for (const discordRespondToChannelIds of [undefined, " , "]) {
      expect(() =>
        messagingPlatformsFromEnv({ ...discordEnv, discordRespondToChannelIds }),
      ).toThrow(/DISCORD_RESPOND_TO_CHANNEL_IDS \(the only channel ids the bot answers\)/);
    }
    expect(() =>
      messagingEnvFromProcess({
        DISCORD_BOT_TOKEN: "discord-bot-token",
        DISCORD_APPLICATION_ID: "discord-app-id",
      }),
    ).toThrow(/partially configured/);
  });

  it("maps DISCORD_* process env and mounts with token, application id, and channel ids", () => {
    expect(
      messagingEnvFromProcess({
        DISCORD_BOT_TOKEN: " discord-bot-token ",
        DISCORD_APPLICATION_ID: " discord-app-id ",
        DISCORD_RESPOND_TO_CHANNEL_IDS: " channel-1 , channel-2 ",
        DISCORD_MENTION_ROLE_IDS: " role-1 ",
      }),
    ).toMatchObject({
      discordBotToken: "discord-bot-token",
      discordApplicationId: "discord-app-id",
      discordRespondToChannelIds: "channel-1 , channel-2",
      discordMentionRoleIds: "role-1",
    });
    expect(providers(discordEnv)).toEqual(["discord"]);
  });

  it("gives team chat the one team platform and refuses both Slack and Discord", () => {
    expect(teamChatProviderId(messagingPlatformsFromEnv(discordEnv))).toBe("discord");
    expect(
      teamChatProviderId(
        messagingPlatformsFromEnv({ slackBotToken: "xoxb-fake", slackSigningSecret: "slack" }),
      ),
    ).toBe("slack");
    expect(teamChatProviderId(messagingPlatformsFromEnv({}))).toBeUndefined();
    expect(() => teamChatProviderId(messagingPlatformsFromEnv(fullEnv))).toThrow(
      /TEAM_CHAT_BOT_ID serves one team platform, but slack and discord are both configured/,
    );
  });

  it("rejects every Discord HTTP request, forwarded Gateway events included", async () => {
    const platforms = messagingPlatformsFromEnv(discordEnv);
    const surface = new ChatSdkMessagingSurface(platforms);
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    const post = (headers: Record<string, string>, body: unknown) =>
      surface.handleWebhook(
        "discord",
        new Request("https://rakazo.test/api/v1/messaging/webhook/discord", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );
    try {
      expect((await post({}, { type: 1 }))?.status).toBe(404);
      const forwarded = await post(
        { "x-discord-gateway-token": "discord-bot-token" },
        {
          type: "GATEWAY_MESSAGE_CREATE",
          timestamp: 0,
          data: {
            id: "forged",
            channel_id: "dm-1",
            content: "run owner command",
            author: { id: "linked-user", username: "ada" },
            mentions: [],
            attachments: [],
            timestamp: new Date(0).toISOString(),
          },
        },
      );
      expect(forwarded?.status).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(inbound).toEqual([]);
    } finally {
      await surface.shutdown();
    }
  });

  it("starts the Gateway only when the API process asks to poll inbound", async () => {
    const api = messagingPlatformsFromEnv(discordEnv, { pollInboundMessages: true })[0]!;
    const worker = messagingPlatformsFromEnv(discordEnv)[0]!;
    const startApi = vi
      .spyOn(api.adapter as unknown as DiscordGatewayAdapter, "startGatewayListener")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const startWorker = vi.spyOn(
      worker.adapter as unknown as DiscordGatewayAdapter,
      "startGatewayListener",
    );

    await worker.adapter.initialize({} as never);
    expect(startWorker).not.toHaveBeenCalled();
    expect((worker.adapter as unknown as DiscordGatewayAdapter).stopPolling).toBeUndefined();

    await api.adapter.initialize({} as never);
    await vi.waitFor(() => expect(startApi).toHaveBeenCalled());
    expect(startApi.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    await (api.adapter as unknown as DiscordGatewayAdapter).stopPolling?.();
  });

  it("drops bot authors and rooms outside the channel allowlist before making a thread", async () => {
    const [platform] = messagingPlatformsFromEnv(
      { ...discordEnv, discordRespondToChannelIds: "channel-1" },
      { pollInboundMessages: true },
    );
    const adapter = platform!.adapter as unknown as DiscordGatewayAdapter;
    vi.spyOn(adapter, "startGatewayListener").mockResolvedValue(new Response("ok"));
    const createThread = vi
      .spyOn(adapter, "createDiscordThread")
      .mockResolvedValue({ id: "thread-new" });
    const handleIncomingMessage = vi.fn(async () => undefined);
    await platform!.adapter.initialize({ handleIncomingMessage } as never);
    const client = Object.assign(new EventEmitter(), { user: { id: "discord-app-id" } });
    adapter.setupLegacyGatewayHandlers(client, () => false);

    for (const message of [
      gatewayMessage({
        id: "from-bot",
        channelId: "channel-1",
        authorIsBot: true,
        mentionsBot: true,
      }),
      gatewayMessage({ id: "other-room", channelId: "channel-2", mentionsBot: true }),
      gatewayMessage({ id: "direct", channelId: "dm-1", guildId: null }),
      gatewayMessage({ id: "in-thread", channelId: "thread-9", parentId: "channel-1" }),
      gatewayMessage({ id: "listed-room", channelId: "channel-1", mentionsBot: true }),
    ]) {
      client.emit("messageCreate", message);
    }

    await vi.waitFor(() => expect(handleIncomingMessage).toHaveBeenCalledTimes(2));
    expect(createThread.mock.calls).toEqual([["channel-1", "listed-room"]]);
    expect(handleIncomingMessage.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      "discord:guild-1:channel-1:thread-9",
      "discord:guild-1:channel-1:thread-new",
    ]);
    await adapter.stopPolling?.();
  });

  it("uses the adapter's mention decision end to end and logs no message content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const platforms = messagingPlatformsFromEnv(
      { ...discordEnv, discordRespondToChannelIds: "channel-1" },
      { pollInboundMessages: true },
    );
    const adapter = platforms[0]!.adapter as unknown as DiscordGatewayAdapter;
    vi.spyOn(adapter, "startGatewayListener").mockResolvedValue(new Response("ok"));
    const createThread = vi
      .spyOn(adapter, "createDiscordThread")
      .mockResolvedValue({ id: "thread-new" });
    const surface = new ChatSdkMessagingSurface(platforms);
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    try {
      await surface.initialize();
      const client = Object.assign(new EventEmitter(), { user: { id: "discord-app-id" } });
      adapter.setupLegacyGatewayHandlers(client, () => false);

      client.emit("messageCreate", {
        ...gatewayMessage({ id: "managed-role", channelId: "channel-1", mentionsBot: true }),
        content: "<@&managed-role> can you check this",
      });
      client.emit(
        "messageCreate",
        gatewayMessage({ id: "chatter", channelId: "thread-9", parentId: "channel-1" }),
      );

      await vi.waitFor(() => expect(inbound).toHaveLength(2));
      expect(createThread.mock.calls).toEqual([["channel-1", "managed-role"]]);
      expect(
        inbound.find((event) => "handle" in event && event.handle === "managed-role"),
      ).toMatchObject({
        kind: "mention",
        conversationKey: "channel-1",
        replyThreadId: "thread-new",
        content: "<@&managed-role> can you check this",
      });
      expect(
        inbound.find((event) => "handle" in event && event.handle === "chatter"),
      ).toMatchObject({
        kind: "ambient",
        replyThreadId: "thread-9",
      });
      const logged = JSON.stringify([...info.mock.calls, ...debug.mock.calls]);
      expect(logged).not.toContain("can you check this");
      expect(logged).not.toContain("ship it");
      expect(logged).not.toContain("user-1");
    } finally {
      await surface.shutdown();
      info.mockRestore();
      debug.mockRestore();
    }
  });

  it("backs off between Gateway sessions that end early", async () => {
    vi.useFakeTimers();
    try {
      const [platform] = messagingPlatformsFromEnv(discordEnv, { pollInboundMessages: true });
      const adapter = platform!.adapter as unknown as DiscordGatewayAdapter;
      const start = vi
        .spyOn(adapter, "startGatewayListener")
        .mockImplementation(async (options) => {
          options.waitUntil(Promise.resolve());
          return new Response("ok");
        });
      await platform!.adapter.initialize({} as never);

      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(start).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(start).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(3);

      await adapter.stopPolling?.();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(start).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enrichDiscordTeamRoom", () => {
  const options = { isMention: true, applicationId: "bot-1", mentionRoleIds: ["role-1"] };
  const base = {
    type: "message" as const,
    provider: "discord",
    handle: "msg-1",
    threadId: "discord:guild-1:channel-1:thread-9",
    isDirect: false,
    from: "user-1",
    fromLabel: "Ada",
    channelName: "fleet",
    participants: ["user-1"],
    content: "<@bot-1> ship it",
    mediaUrl: null,
  };

  it("maps guild, channel, and thread from the thread id", () => {
    expect(enrichDiscordTeamRoom(base, options)).toEqual({
      workspaceId: "guild-1",
      conversationKey: "channel-1",
      replyThreadId: "thread-9",
      kind: "mention",
      content: "ship it",
    });
    expect(
      enrichDiscordTeamRoom(
        { ...base, threadId: "discord:@me:dm-1", isDirect: true, content: "hi" },
        options,
      ),
    ).toEqual({ conversationKey: "dm-1", replyThreadId: null });
  });

  it("takes the kind from the mention decision and strips only a leading bot or role mention", () => {
    const enrich = (content: string, isMention: boolean) =>
      enrichDiscordTeamRoom({ ...base, content }, { ...options, isMention });
    expect(enrich("<@grace> can you review PR 12", false)).toMatchObject({ kind: "ambient" });
    expect(enrich("<@grace> can you review PR 12", false).content).toBeUndefined();
    expect(enrich("<@&role-1> heads up", true)).toMatchObject({
      kind: "mention",
      content: "heads up",
    });
    expect(enrich("<@!bot-1> hi", true)).toMatchObject({ kind: "mention", content: "hi" });
    expect(enrich("ping <@bot-1>", true)).toMatchObject({ kind: "mention" });
    expect(enrich("ping <@bot-1>", true).content).toBeUndefined();
  });
});
