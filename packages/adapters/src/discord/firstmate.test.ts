import { describe, expect, it, vi } from "vitest";
import { firstMateUnavailableMessage, HttpFirstMateTransport } from "./firstmate.js";
import type { DiscordCorrelation } from "./types.js";

const correlation: DiscordCorrelation = {
  eventId: "evt",
  eventKind: "interaction",
  interactionId: "i1",
  guildId: "g",
  channelId: "c",
};

describe("FirstMate transport", () => {
  it("returns a transparent unavailable reply when the transport is not configured", async () => {
    const transport = new HttpFirstMateTransport({ timeoutMs: 1000 });
    const result = await transport.ask({ prompt: "status?", correlation });
    expect(result).toEqual({
      ok: false,
      unavailable: true,
      message: firstMateUnavailableMessage(),
    });
    expect(result.ok === false && result.message).not.toMatch(/Flux|Eleusis|Jason/i);
  });

  it("posts to the configured external transport and returns its text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "FirstMate standing by." }), { status: 200 }),
      );
    const transport = new HttpFirstMateTransport(
      { url: "https://firstmate.example/ask", token: "fm-token", timeoutMs: 1000 },
      { fetch: fetchImpl },
    );
    const result = await transport.ask({ prompt: "status?", correlation });
    expect(result).toEqual({ ok: true, text: "FirstMate standing by." });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://firstmate.example/ask",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer fm-token" }),
      }),
    );
  });

  it("does not invent an answer when the transport fails", async () => {
    const transport = new HttpFirstMateTransport(
      { url: "https://firstmate.example/ask", timeoutMs: 1000 },
      { fetch: vi.fn().mockResolvedValue(new Response("nope", { status: 503 })) },
    );
    const result = await transport.ask({ prompt: "status?", correlation });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unavailable).not.toBe(true);
    if (!result.ok) expect(result.message).toContain("HTTP 503");
  });
});
