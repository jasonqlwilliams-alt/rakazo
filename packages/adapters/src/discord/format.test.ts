import { describe, expect, it } from "vitest";
import { ackText, formatAgentMessages, provenanceLine } from "./format.js";
import { DISCORD_CONTENT_LIMIT, type DiscordCorrelation } from "./types.js";

const correlation: DiscordCorrelation = {
  eventId: "evt-1",
  eventKind: "interaction",
  interactionId: "123",
  guildId: "guild",
  channelId: "channel",
};

describe("discord reply formatting", () => {
  it("keeps speaker, text, correlation, and TTS on one outbound message", () => {
    const [message] = formatAgentMessages({
      speaker: "flux",
      text: "The pier is clear.",
      correlation,
      ttsEnabled: true,
    });
    expect(message?.content).toContain("Flux:");
    expect(message?.content).toContain("The pier is clear.");
    expect(message?.tts).toBe(true);
    expect(message?.embeds?.[0]?.footer?.text).toContain("discord:interaction:123");
    expect(message?.embeds?.[0]?.footer?.text).toContain("not an impersonated Discord user");
  });

  it("defaults TTS off while preserving the text", () => {
    const [message] = formatAgentMessages({
      speaker: "eleusis",
      text: "Hold the line.",
      correlation,
      ttsEnabled: false,
    });
    expect(message?.tts).toBe(false);
    expect(message?.content).toContain("Hold the line.");
  });

  it("keeps a short reply on a single message with no continuation marker", () => {
    const messages = formatAgentMessages({
      speaker: "flux",
      text: "Short answer.",
      correlation,
      ttsEnabled: false,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Flux: Short answer.");
  });

  it("splits a reply past Discord's limit into chunks that rebuild the full text", () => {
    const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
    expect(text.length).toBeGreaterThan(DISCORD_CONTENT_LIMIT * 2);
    const messages = formatAgentMessages({
      speaker: "firstmate",
      text,
      correlation,
      ttsEnabled: true,
    });

    expect(messages.length).toBeGreaterThan(2);
    for (const message of messages) {
      expect(message.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
      expect(message.tts).toBe(true);
    }
    expect(messages[0]?.content.startsWith("FirstMate: ")).toBe(true);
    expect(messages[0]?.embeds?.[0]?.footer?.text).toContain("not an impersonated Discord user");
    for (const message of messages.slice(1)) {
      expect(message.content.startsWith("FirstMate (continued): ")).toBe(true);
      expect(message.embeds).toBeUndefined();
    }

    const rebuilt = messages
      .map((message, index) =>
        message.content.slice((index === 0 ? "FirstMate: " : "FirstMate (continued): ").length),
      )
      .join("");
    expect(rebuilt).toBe(text);
    expect(rebuilt).not.toContain("(truncated)");
  });

  it("names every selected speaker in the ack", () => {
    expect(ackText(["flux"])).toBe("Asking Flux.");
    expect(ackText(["firstmate", "flux", "eleusis"])).toBe("Asking FirstMate, Flux, and Eleusis.");
  });

  it("builds a stable provenance line", () => {
    expect(provenanceLine("firstmate", correlation)).toContain("FirstMate");
    expect(provenanceLine("firstmate", correlation)).toContain("discord:interaction:123");
  });
});
