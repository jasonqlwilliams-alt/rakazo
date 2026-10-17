import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDiscordRoundtableBridge } from "./bridge.js";
import { loadDiscordRoundtableConfig } from "./config.js";
import { firstMateUnavailableMessage } from "./firstmate.js";
import { createMemoryDedupStore } from "./routing.js";
import type {
  DiscordCorrelation,
  DiscordIO,
  DiscordOutboundMessage,
  FirstMateTransport,
  RakazoBotRunner,
} from "./types.js";

function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { publicKeyHex: spki.subarray(-32).toString("hex"), privateKey };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

function enabledConfig(publicKeyHex: string) {
  return loadDiscordRoundtableConfig({
    DISCORD_BOT_TOKEN: "token-placeholder",
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "app",
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_CHANNEL_ID: "channel-1",
    DISCORD_WORKSPACE_ID: "ws",
    DISCORD_TTS_ENABLED: "true",
    DISCORD_REGISTER_COMMANDS: "false",
  }) as Extract<ReturnType<typeof loadDiscordRoundtableConfig>, { enabled: true }>;
}

function signedBody(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  body: string,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    timestamp,
    signature: sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex"),
    rawBody: body,
  };
}

function recordingIo(): DiscordIO & {
  posts: DiscordOutboundMessage[];
  edits: DiscordOutboundMessage[];
} {
  const posts: DiscordOutboundMessage[] = [];
  const edits: DiscordOutboundMessage[] = [];
  return {
    posts,
    edits,
    verifyRequest: () => true,
    pong: () => ({ type: 1 }),
    deferInteraction: () => ({ type: 5 }),
    ephemeral: (message) => ({ type: 4, data: { content: message, flags: 64 } }),
    async editOriginal(_token, message) {
      edits.push(message);
    },
    async followUp(_token, message) {
      posts.push(message);
    },
    async createChannelMessage(_channelId, message) {
      posts.push(message);
    },
    async registerGuildCommands() {},
  };
}

function fluxEleusisRunner(): RakazoBotRunner {
  return {
    async runTurn(request) {
      return {
        ok: true,
        text: `${request.speaker} says ${request.prompt}`,
        runId: `run-${request.speaker}`,
        threadId: `thread-${request.speaker}`,
        botId: `bot-${request.speaker}`,
      };
    },
  };
}

function firstmateTransport(text?: string): FirstMateTransport {
  return {
    async ask(request) {
      if (!text) {
        return { ok: false, unavailable: true, message: firstMateUnavailableMessage() };
      }
      return { ok: true, text: `${text} :: ${request.prompt}` };
    },
  };
}

const askFlux = {
  type: 2,
  id: "interaction-flux",
  token: "tok",
  guild_id: "guild-1",
  channel_id: "channel-1",
  member: { user: { id: "human", bot: false } },
  data: {
    name: "ask",
    options: [
      { name: "agent", value: "flux" },
      { name: "prompt", value: "harbor status" },
    ],
  },
};

const roundtable = {
  type: 2,
  id: "interaction-table",
  token: "tok",
  guild_id: "guild-1",
  channel_id: "channel-1",
  member: { user: { id: "human", bot: false } },
  data: { name: "roundtable", options: [{ name: "prompt", value: "harbor status" }] },
};

describe("discord roundtable bridge", () => {
  it("routes one agent and a three-agent roundtable", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    const rakazo = {
      runTurn: vi.fn(async (request) => ({
        ok: true as const,
        text: `${request.speaker} ready`,
        runId: `run-${request.speaker}`,
        threadId: `thread-${request.speaker}`,
        botId: `bot-${request.speaker}`,
      })),
    };
    const firstmate = {
      ask: vi.fn(async () => ({ ok: true as const, text: "FirstMate ready" })),
    };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo,
      firstmate,
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    const one = await bridge.dispatch({
      command: { kind: "ask", speaker: "eleusis", prompt: "harbor status" },
      correlation: correlationFor("one"),
    });
    const table = await bridge.dispatch({
      command: {
        kind: "roundtable",
        speakers: ["firstmate", "flux", "eleusis"],
        prompt: "harbor status",
      },
      correlation: correlationFor("table"),
    });

    expect(one).toEqual([expect.objectContaining({ speaker: "eleusis", text: "eleusis ready" })]);
    expect(table.map((row) => row.speaker)).toEqual(["firstmate", "flux", "eleusis"]);
    expect(table.map((row) => row.text)).toEqual([
      "FirstMate ready",
      "flux ready",
      "eleusis ready",
    ]);
    expect(rakazo.runTurn).toHaveBeenCalledTimes(3);
    expect(firstmate.ask).toHaveBeenCalledTimes(1);
  });

  it("posts speaker-labeled TTS replies with Discord correlation", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const io = recordingIo();
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: fluxEleusisRunner(),
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });
    const response = await bridge.handleHttpRequest(
      signedBody(privateKey, JSON.stringify(askFlux)),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 5 });
    response.afterResponse?.();
    await waitFor(() => io.posts.length === 1);
    expect(io.posts[0]).toMatchObject({
      tts: true,
      content: expect.stringContaining("Flux:"),
    });
    expect(io.posts[0]?.content).toContain("harbor status");
    expect(io.posts[0]?.embeds?.[0]?.footer?.text).toContain(
      "discord:interaction:interaction-flux",
    );
  });

  it("deduplicates retries and never dispatches bot-authored events", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const io = recordingIo();
    const rakazo = { runTurn: vi.fn(fluxEleusisRunner().runTurn) };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo,
      firstmate: firstmateTransport(),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });
    const body = signedBody(privateKey, JSON.stringify(askFlux));
    (await bridge.handleHttpRequest(body)).afterResponse?.();
    (await bridge.handleHttpRequest(body)).afterResponse?.();
    await waitFor(() => io.posts.length === 1);
    expect(rakazo.runTurn).toHaveBeenCalledTimes(1);

    const mention = await bridge.handleMentionMessage({
      messageId: "bot-msg",
      content: "<@app> flux loop me",
      location: { guildId: "guild-1", channelId: "channel-1" },
      author: { bot: true, applicationId: "app" },
      botUserId: "app",
    });
    expect(mention).toMatchObject({ action: "ignore", reason: "bot_loop" });
    expect(rakazo.runTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps FirstMate on the external transport and never creates a Rakazo seat", async () => {
    const { publicKeyHex } = testKeys();
    const rakazo = { runTurn: vi.fn(fluxEleusisRunner().runTurn) };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io: recordingIo(),
      rakazo,
      firstmate: firstmateTransport(),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });
    const replies = await bridge.dispatch({
      command: { kind: "roundtable", speakers: ["firstmate", "flux", "eleusis"], prompt: "q" },
      correlation: correlationFor("truth"),
    });
    expect(replies[0]).toMatchObject({
      speaker: "firstmate",
      unavailable: true,
      error: firstMateUnavailableMessage(),
    });
    expect(rakazo.runTurn.mock.calls.map((call) => call[0]?.speaker)).toEqual(["flux", "eleusis"]);
  });

  it("rejects unauthorized guilds and malformed commands without dispatch", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const rakazo = { runTurn: vi.fn(fluxEleusisRunner().runTurn) };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io: recordingIo(),
      rakazo,
      firstmate: firstmateTransport("x"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });
    const foreign = await bridge.handleHttpRequest(
      signedBody(
        privateKey,
        JSON.stringify({ ...askFlux, id: "foreign", guild_id: "other-guild" }),
      ),
    );
    expect(foreign.status).toBe(200);
    expect(JSON.stringify(foreign.body)).toContain("configured Discord server");
    const malformed = await bridge.handleHttpRequest(
      signedBody(
        privateKey,
        JSON.stringify({
          ...askFlux,
          id: "bad",
          data: { name: "ask", options: [{ name: "agent", value: "flux" }] },
        }),
      ),
    );
    expect(JSON.stringify(malformed.body)).toContain("Prompt is required");
    expect(rakazo.runTurn).not.toHaveBeenCalled();
  });

  it("continues a roundtable when one agent fails", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      firstmate: {
        async ask() {
          return { ok: false, message: "FirstMate transport timed out." };
        },
      },
      rakazo: {
        async runTurn(request) {
          if (request.speaker === "flux") {
            return { ok: false, code: "failed", message: "Flux backend failed." };
          }
          return {
            ok: true,
            text: "Eleusis ok",
            runId: "run-e",
            threadId: "t-e",
            botId: "b-e",
          };
        },
      },
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });
    (
      await bridge.handleHttpRequest({
        signature: "unused",
        timestamp: "1",
        rawBody: JSON.stringify(roundtable),
      })
    ).afterResponse?.();
    await waitFor(() => io.posts.length === 3);
    expect(io.posts.map((post) => post.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FirstMate transport timed out"),
        expect.stringContaining("Flux backend failed"),
        expect.stringContaining("Eleusis: Eleusis ok"),
      ]),
    );
  });

  it("makes no Discord webhook call until the deferred ack is handed back", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const io = recordingIo();
    const rakazo = { runTurn: vi.fn(fluxEleusisRunner().runTurn) };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo,
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    const response = await bridge.handleHttpRequest(
      signedBody(privateKey, JSON.stringify(askFlux)),
    );

    expect(response.body).toEqual({ type: 5 });
    expect(io.edits).toHaveLength(0);
    expect(io.posts).toHaveLength(0);
    expect(rakazo.runTurn).not.toHaveBeenCalled();

    response.afterResponse?.();
    await waitFor(() => io.posts.length === 1);
    expect(io.edits).toHaveLength(1);
    expect(rakazo.runTurn).toHaveBeenCalledTimes(1);
  });

  it("still posts the other speakers when one speaker throws", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      firstmate: {
        async ask() {
          throw new Error("FirstMate transport exploded");
        },
      },
      rakazo: {
        async runTurn(request) {
          if (request.speaker === "flux") throw new Error("prisma is down");
          return {
            ok: true,
            text: "Eleusis ok",
            runId: "run-e",
            threadId: "t-e",
            botId: "b-e",
          };
        },
      },
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest({
        signature: "unused",
        timestamp: "1",
        rawBody: JSON.stringify(roundtable),
      })
    ).afterResponse?.();
    await waitFor(() => io.posts.length === 3);

    const contents = io.posts.map((post) => post.content);
    expect(contents.some((content) => content.includes("Eleusis: Eleusis ok"))).toBe(true);
    expect(
      contents.filter((content) => content.includes("could not answer this turn")),
    ).toHaveLength(2);
    expect(contents.some((content) => content.includes("exploded"))).toBe(false);
  });

  it("keeps posting replies when the deferred ack edit fails", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    io.editOriginal = async () => {
      throw new Error("Discord request failed with HTTP 404");
    };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: fluxEleusisRunner(),
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest({
        signature: "unused",
        timestamp: "1",
        rawBody: JSON.stringify(roundtable),
      })
    ).afterResponse?.();

    await waitFor(() => io.posts.length === 3);
  });

  it("still posts the other speakers when one reply is rejected by Discord", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    const original = io.followUp;
    let attempted = 0;
    io.followUp = async (token, message) => {
      attempted += 1;
      if (attempted === 1) {
        throw new Error("Discord asked for a 3600s rate-limit wait, beyond the bridge's bound");
      }
      return original(token, message);
    };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: fluxEleusisRunner(),
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest({
        signature: "unused",
        timestamp: "1",
        rawBody: JSON.stringify(roundtable),
      })
    ).afterResponse?.();
    await waitFor(() => io.posts.length === 3);

    const contents = io.posts.map((post) => post.content);
    expect(contents.some((content) => content.includes("Flux:"))).toBe(true);
    expect(contents.some((content) => content.includes("Eleusis:"))).toBe(true);
    expect(contents.some((content) => content.includes("FirstMate:"))).toBe(false);
    expect(
      contents.some(
        (content) => content.includes("FirstMate") && content.includes("missing above"),
      ),
    ).toBe(true);
    expect(contents.some((content) => content.includes("rate-limit wait"))).toBe(false);
    expect(
      contents.some((content) => content.includes("failed before all replies could be posted")),
    ).toBe(false);
  });

  it("names every speaker whose reply Discord refused", async () => {
    const { publicKeyHex } = testKeys();
    const io = recordingIo();
    const original = io.followUp;
    let attempted = 0;
    io.followUp = async (token, message) => {
      attempted += 1;
      if (attempted <= 2) throw new Error("Discord request failed with HTTP 500");
      return original(token, message);
    };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: fluxEleusisRunner(),
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest({
        signature: "unused",
        timestamp: "1",
        rawBody: JSON.stringify(roundtable),
      })
    ).afterResponse?.();
    await waitFor(() => io.posts.length === 2);

    const contents = io.posts.map((post) => post.content);
    expect(contents.some((content) => content.includes("Eleusis:"))).toBe(true);
    const notice = contents.find((content) => content.includes("missing above"));
    expect(notice).toContain("FirstMate");
    expect(notice).toContain("Flux");
    expect(notice).not.toContain("Eleusis's reply");
  });

  it("splits a reply past Discord's limit across follow-ups instead of truncating it", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const io = recordingIo();
    const long = longReply();
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: {
        async runTurn(request) {
          return {
            ok: true,
            text: long,
            runId: `run-${request.speaker}`,
            threadId: `thread-${request.speaker}`,
            botId: `bot-${request.speaker}`,
          };
        },
      },
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest(signedBody(privateKey, JSON.stringify(askFlux)))
    ).afterResponse?.();
    await waitFor(() => rebuildReply(io.posts.map((post) => post.content)) === long);

    expect(io.posts.length).toBeGreaterThan(2);
    for (const post of io.posts) {
      expect(post.content.length).toBeLessThanOrEqual(2000);
      expect(post.content).not.toContain("(truncated)");
    }
    expect(io.posts[0]?.embeds?.[0]?.footer?.text).toContain(
      "discord:interaction:interaction-flux",
    );
    expect(io.posts.slice(1).every((post) => post.content.startsWith("Flux (continued): "))).toBe(
      true,
    );
  });

  it("keeps the chunks already posted when Discord refuses a later chunk", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const io = recordingIo();
    const long = longReply();
    const original = io.followUp;
    let attempted = 0;
    io.followUp = async (token, message) => {
      attempted += 1;
      if (attempted === 2) throw new Error("Discord request failed with HTTP 500");
      return original(token, message);
    };
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io,
      rakazo: {
        async runTurn(request) {
          return {
            ok: true,
            text: long,
            runId: `run-${request.speaker}`,
            threadId: `thread-${request.speaker}`,
            botId: `bot-${request.speaker}`,
          };
        },
      },
      firstmate: firstmateTransport("FirstMate ready"),
      logger: silentLogger,
      dedup: createMemoryDedupStore(),
    });

    (
      await bridge.handleHttpRequest(signedBody(privateKey, JSON.stringify(askFlux)))
    ).afterResponse?.();
    await waitFor(() => io.posts.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const contents = io.posts.map((post) => post.content);
    expect(io.posts).toHaveLength(2);
    expect(contents[0]?.startsWith("Flux: ")).toBe(true);
    expect(long.startsWith(contents[0]?.slice("Flux: ".length) ?? "")).toBe(true);
    expect(contents[1]).toContain("Flux");
    expect(contents[1]).toContain("cut short above");
    expect(contents.some((content) => content.includes(long.slice(-40)))).toBe(false);
    expect(contents.some((content) => content.includes("HTTP 500"))).toBe(false);
  });

  it("answers Discord PINGs and rejects bad signatures", async () => {
    const { publicKeyHex, privateKey } = testKeys();
    const bridge = createDiscordRoundtableBridge({
      config: enabledConfig(publicKeyHex),
      io: new (await import("./io.js")).DiscordRestAdapter({
        config: enabledConfig(publicKeyHex),
        fetch: vi.fn(),
      }),
      rakazo: fluxEleusisRunner(),
      firstmate: firstmateTransport(),
      logger: silentLogger,
    });
    const ping = signedBody(privateKey, JSON.stringify({ type: 1 }));
    expect(await bridge.handleHttpRequest(ping)).toEqual({ status: 200, body: { type: 1 } });
    expect(
      await bridge.handleHttpRequest({
        signature: "00",
        timestamp: ping.timestamp,
        rawBody: ping.rawBody,
      }),
    ).toEqual({
      status: 401,
      body: { error: "invalid request signature" },
    });
  });
});

function longReply(): string {
  return Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
}

function rebuildReply(contents: string[]): string {
  return contents
    .map((content) =>
      content.startsWith("Flux (continued): ")
        ? content.slice("Flux (continued): ".length)
        : content.startsWith("Flux: ")
          ? content.slice("Flux: ".length)
          : "",
    )
    .join("");
}

function correlationFor(eventId: string): DiscordCorrelation {
  return {
    eventId,
    eventKind: "interaction",
    interactionId: eventId,
    guildId: "guild-1",
    channelId: "channel-1",
  };
}

async function waitFor(ok: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for Discord posts");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
