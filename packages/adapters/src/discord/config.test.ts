import { describe, expect, it } from "vitest";
import { loadDiscordRoundtableConfig } from "./config.js";

const complete = {
  DISCORD_BOT_TOKEN: "discord-bot-token-placeholder",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_APPLICATION_ID: "app-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_CHANNEL_ID: "channel-id",
  DISCORD_WORKSPACE_ID: "workspace-id",
};

describe("loadDiscordRoundtableConfig", () => {
  it("stays disabled when no Discord fields are set", () => {
    expect(loadDiscordRoundtableConfig({})).toEqual({ enabled: false });
  });

  it("fails closed on partial configuration", () => {
    expect(() => loadDiscordRoundtableConfig({ DISCORD_BOT_TOKEN: "token-only" })).toThrow(
      /partially configured/,
    );
    expect(() => loadDiscordRoundtableConfig({ DISCORD_BOT_TOKEN: "token-only" })).toThrow(
      /DISCORD_PUBLIC_KEY/,
    );
  });

  it("defaults TTS off and resolves Flux/Eleusis by name", () => {
    const config = loadDiscordRoundtableConfig(complete);
    expect(config).toMatchObject({
      enabled: true,
      ttsEnabled: false,
      flux: { name: "Flux" },
      eleusis: { name: "Eleusis" },
      firstmate: { url: undefined },
    });
  });

  it("accepts configured bot IDs and FirstMate transport without treating IDs as defaults", () => {
    const config = loadDiscordRoundtableConfig({
      ...complete,
      DISCORD_FLUX_BOT_ID: "flux-bot-id",
      DISCORD_ELEUSIS_BOT_ID: "eleusis-bot-id",
      DISCORD_TTS_ENABLED: "true",
      FIRSTMATE_TRANSPORT_URL: "https://firstmate.example/ask",
    });
    expect(config).toMatchObject({
      enabled: true,
      ttsEnabled: true,
      flux: { id: "flux-bot-id", name: "Flux" },
      eleusis: { id: "eleusis-bot-id", name: "Eleusis" },
      firstmate: { url: "https://firstmate.example/ask" },
    });
  });
});
