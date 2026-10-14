import { describe, expect, it } from "vitest";
import {
  createMemoryDedupStore,
  decideInbound,
  isAllowedLocation,
  isBotAuthored,
  parseMentionCommand,
  parseSlashCommand,
} from "./routing.js";

const allowlist = { guildId: "guild-1", channelId: "channel-1" };

describe("discord routing", () => {
  it("parses one-agent and roundtable slash commands", () => {
    expect(
      parseSlashCommand({
        name: "ask",
        options: [
          { name: "agent", value: "flux" },
          { name: "prompt", value: "status?" },
        ],
      }),
    ).toEqual({ ok: true, command: { kind: "ask", speaker: "flux", prompt: "status?" } });
    expect(
      parseSlashCommand({
        name: "roundtable",
        options: [{ name: "prompt", value: "review this" }],
      }),
    ).toMatchObject({
      ok: true,
      command: { kind: "roundtable", speakers: ["firstmate", "flux", "eleusis"] },
    });
  });

  it("treats Codex as FirstMate and rejects empty prompts", () => {
    expect(parseMentionCommand("<@bot> codex inspect the tide", "bot")).toMatchObject({
      ok: true,
      command: { kind: "ask", speaker: "firstmate", prompt: "inspect the tide" },
    });
    expect(
      parseSlashCommand({ name: "ask", options: [{ name: "agent", value: "flux" }] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("allowlists the configured guild and channel, including threads", () => {
    expect(isAllowedLocation({ guildId: "guild-1", channelId: "channel-1" }, allowlist)).toBe(true);
    expect(
      isAllowedLocation(
        { guildId: "guild-1", channelId: "thread-9", parentChannelId: "channel-1" },
        allowlist,
      ),
    ).toBe(true);
    expect(isAllowedLocation({ guildId: "other", channelId: "channel-1" }, allowlist)).toBe(false);
    expect(isAllowedLocation({ guildId: "guild-1", channelId: "other" }, allowlist)).toBe(false);
  });

  it("rejects unauthorized locations and ignores bot-authored events", () => {
    const dedup = createMemoryDedupStore();
    expect(
      decideInbound({
        eventId: "i1",
        eventKind: "interaction",
        location: { guildId: "other", channelId: "channel-1" },
        allowlist,
        command: { kind: "ask", speaker: "flux", prompt: "hi" },
        dedup,
      }),
    ).toMatchObject({ action: "reject", reason: "unauthorized" });
    expect(
      decideInbound({
        eventId: "i2",
        eventKind: "message",
        location: { guildId: "guild-1", channelId: "channel-1" },
        author: { bot: true },
        allowlist,
        command: { kind: "ask", speaker: "flux", prompt: "hi" },
        dedup,
      }),
    ).toMatchObject({ action: "ignore", reason: "bot_loop" });
    expect(isBotAuthored({ webhookId: "hook" })).toBe(true);
  });

  it("deduplicates the same Discord event id", () => {
    const dedup = createMemoryDedupStore();
    const first = decideInbound({
      eventId: "same",
      eventKind: "interaction",
      interactionId: "same",
      location: { guildId: "guild-1", channelId: "channel-1" },
      allowlist,
      command: { kind: "ask", speaker: "eleusis", prompt: "once" },
      dedup,
    });
    const second = decideInbound({
      eventId: "same",
      eventKind: "interaction",
      interactionId: "same",
      location: { guildId: "guild-1", channelId: "channel-1" },
      allowlist,
      command: { kind: "ask", speaker: "eleusis", prompt: "once" },
      dedup,
    });
    expect(first.action).toBe("dispatch");
    expect(second).toMatchObject({ action: "ignore", reason: "duplicate" });
  });
});
