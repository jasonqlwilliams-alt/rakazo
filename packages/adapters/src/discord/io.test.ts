import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadDiscordRoundtableConfig } from "./config.js";
import { DiscordRestAdapter, redactDiscordPath, verifyDiscordSignature } from "./io.js";
import { createBridgeLogger, sanitizeLogFields } from "./log.js";

function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { publicKeyHex: spki.subarray(-32).toString("hex"), privateKey };
}

describe("discord io adapter", () => {
  it("verifies Discord interaction signatures and rejects skew or bad signatures", () => {
    const { publicKeyHex, privateKey } = testKeys();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = `{"type":1}`;
    const signature = sign(null, Buffer.from(`${timestamp}${rawBody}`), privateKey).toString("hex");
    expect(
      verifyDiscordSignature({
        publicKey: publicKeyHex,
        signature,
        timestamp,
        rawBody,
      }),
    ).toBe(true);
    expect(
      verifyDiscordSignature({
        publicKey: publicKeyHex,
        signature: "ab".repeat(32),
        timestamp,
        rawBody,
      }),
    ).toBe(false);
    expect(
      verifyDiscordSignature({
        publicKey: publicKeyHex,
        signature,
        timestamp: String(Math.floor(Date.now() / 1000) - 600),
        rawBody,
      }),
    ).toBe(false);
  });

  it("posts follow-ups with documented tts and retries 429s", async () => {
    const { publicKeyHex } = testKeys();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.01 }), {
          status: 429,
          headers: { "retry-after": "0.01" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async () => undefined,
    });

    await adapter.followUp("interaction-token", {
      content: "Flux: hello",
      tts: true,
      allowedMentions: { parse: [] },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, second] = fetchImpl.mock.calls;
    expect(second?.[0]).toContain("/webhooks/app/interaction-token");
    expect(JSON.parse(String(second?.[1]?.body))).toMatchObject({
      content: "Flux: hello",
      tts: true,
    });
  });

  it("never writes the interaction token into rate-limit, retry, or failure logs", async () => {
    const { publicKeyHex } = testKeys();
    const warns: unknown[] = [];
    const errors: unknown[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.01 }), {
          status: 429,
          headers: { "retry-after": "0.01" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async () => undefined,
      logger: {
        info: () => undefined,
        warn: (event, fields) => warns.push({ event, fields }),
        error: (event, fields) => errors.push({ event, fields }),
      },
    });

    await expect(
      adapter.followUp("super-secret-interaction-token", { content: "hi", tts: false }),
    ).rejects.toThrow(/HTTP 403/);

    expect(warns).toHaveLength(2);
    expect(errors).toHaveLength(1);
    const logged = JSON.stringify([...warns, ...errors]);
    expect(logged).not.toContain("super-secret-interaction-token");
    expect(logged).toContain("/webhooks/app/[redacted]");
  });

  it("retries an unknown-webhook 404 on the first edit after a deferred ack", async () => {
    const { publicKeyHex } = testKeys();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async () => undefined,
    });

    await adapter.editOriginal("tok", { content: "thinking", tts: false });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 on channel posts, which are not ack-ordered", async () => {
    const { publicKeyHex } = testKeys();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async () => undefined,
    });

    await expect(
      adapter.createChannelMessage("channel", { content: "hi", tts: false }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up instead of holding a dispatch for an hour-long rate limit", async () => {
    const { publicKeyHex } = testKeys();
    const slept: number[] = [];
    const errors: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (event, fields) => errors.push({ event, fields: fields as never }),
      },
    });

    await expect(
      adapter.followUp("interaction-token", { content: "hi", tts: false }),
    ).rejects.toThrow(/rate-limit wait/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(errors[0]?.event).toBe("discord.rate_limit_too_long");
    expect(JSON.stringify(errors)).not.toContain("interaction-token");
  });

  it("still waits out a short rate limit within the bound", async () => {
    const { publicKeyHex } = testKeys();
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await adapter.followUp("tok", { content: "hi", tts: false });

    expect(slept).toEqual([2000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops sleeping between retries once the caller aborts", async () => {
    const { publicKeyHex } = testKeys();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const adapter = new DiscordRestAdapter({
      config: loadDiscordRoundtableConfig({
        DISCORD_BOT_TOKEN: "token-placeholder",
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APPLICATION_ID: "app",
        DISCORD_GUILD_ID: "guild",
        DISCORD_CHANNEL_ID: "channel",
        DISCORD_WORKSPACE_ID: "ws",
      }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>,
      fetch: fetchImpl,
    });

    const posted = adapter.followUp("tok", { content: "hi", tts: false }, controller.signal);
    controller.abort();

    await expect(posted).rejects.toThrow(/aborted/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps non-webhook paths readable while redacting webhook tokens", () => {
    expect(redactDiscordPath("/webhooks/app/tok/messages/@original")).toBe(
      "/webhooks/app/[redacted]/messages/@original",
    );
    expect(redactDiscordPath("/webhooks/app/tok")).toBe("/webhooks/app/[redacted]");
    expect(redactDiscordPath("/channels/channel-1/messages")).toBe("/channels/channel-1/messages");
  });

  it("redacts credentials and omits message bodies from info logs", () => {
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = createBridgeLogger({
      info: (event, fields) =>
        lines.push({ event: String(event), fields: fields as Record<string, unknown> }),
      warn: () => undefined,
      error: () => undefined,
    });
    logger.info("discord.dispatch", {
      token: "super-secret-token",
      content: "please do not log this body",
      eventId: "evt",
    });
    expect(JSON.stringify(lines)).not.toContain("super-secret-token");
    expect(JSON.stringify(lines)).not.toContain("please do not log this body");
    expect(sanitizeLogFields({ authorization: "Bot abc", prompt: "secret ask" })).toEqual({
      authorization: "[redacted]",
      prompt: "[omitted]",
    });
  });
});
