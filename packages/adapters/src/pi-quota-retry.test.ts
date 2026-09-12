import type { AssistantMessage, Context, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiCompatibleModel } from "./pi-openai-compatible-provider.js";
import { classifyQuotaError, quotaRetryConfig, streamWithQuotaRetry } from "./pi-quota-retry.js";

const model = openAiCompatibleModel("fixture", "http://127.0.0.1:1/v1");
const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 0 }] };
function message(errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: errorMessage ? "error" : "stop",
    errorMessage,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function fixture(replies: Array<{ error?: string; partial?: boolean; retryAfter?: string }>) {
  const streamSimple = vi.fn<Models["streamSimple"]>((_model, _context, options) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected model call");
    const stream = new AssistantMessageEventStream();
    const result = message(reply.error);
    void (async () => {
      if (reply.retryAfter)
        await options?.onResponse?.(
          { status: 429, headers: { "Retry-After": reply.retryAfter } },
          model,
        );
      stream.push({ type: "start", partial: result });
      if (reply.partial) {
        result.content = [{ type: "text", text: "partial" }];
        stream.push({ type: "text_delta", delta: "partial", contentIndex: 0, partial: result });
      }
      if (reply.error) stream.push({ type: "error", reason: "error", error: result });
      else stream.push({ type: "done", reason: "stop", message: result });
      stream.end();
    })();
    return stream;
  });
  const progress = vi.fn();
  const run = (options?: SimpleStreamOptions) =>
    streamWithQuotaRetry({ streamSimple }, model, context, options, progress);
  return { streamSimple, progress, run };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("quota classification and configuration", () => {
  it.each([
    { status: 429 },
    { error: { code: "insufficient_quota" } },
    { error: { status: "RESOURCE_EXHAUSTED" } },
    { message: "Rate limit exceeded" },
    { message: "Too many requests" },
    { metadata: { raw: '{"error":{"message":"tokens-per-minute exceeded"}}' } },
    { message: "TPM limit exceeded" },
    { headers: { "Retry-After": "90" } },
  ])("recognizes %j", (error) => expect(classifyQuotaError(error)).toBeDefined());

  it("parses Retry-After dates and ignores invalid headers", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(
      classifyQuotaError(
        { headers: new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:01:30 GMT" }) },
        now,
      ),
    ).toEqual({ retryAfterMs: 90_000 });
    expect(classifyQuotaError({ headers: { "Retry-After": "invalid" } })).toBeUndefined();
    expect(classifyQuotaError({ message: "401 Unauthorized" })).toBeUndefined();
  });

  it("uses bounded integer settings and supports disabling retries", () => {
    expect(quotaRetryConfig({})).toEqual({ delayMs: 60_000, maxRetries: 3 });
    expect(
      quotaRetryConfig({ RAKAZO_QUOTA_RETRY_MS: "-1", RAKAZO_QUOTA_RETRY_MAX: "Infinity" }),
    ).toEqual({ delayMs: 60_000, maxRetries: 3 });
    expect(
      quotaRetryConfig({ RAKAZO_QUOTA_RETRY_MS: "1000", RAKAZO_QUOTA_RETRY_MAX: "0" }),
    ).toEqual({ delayMs: 1000, maxRetries: 0 });
  });
});

describe("one model request quota retry", () => {
  it.each([undefined, "90", "1"])(
    "waits for the configured floor or longer Retry-After=%s",
    async (retryAfter) => {
      vi.useFakeTimers();
      const f = fixture([{ error: "429 quota exceeded", retryAfter }, {}]);
      const stream = f.run();
      const waiting = retryAfter === "90" ? 90_000 : 60_000;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.progress).toHaveBeenCalledWith(`Quota, retrying in ${waiting / 1000}s (1/3).`);
      await vi.advanceTimersByTimeAsync(waiting - 1);
      expect(f.streamSimple).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await stream.result()).stopReason).toBe("stop");
      expect(f.streamSimple).toHaveBeenCalledTimes(2);
      expect(f.streamSimple.mock.calls[1]?.[1]).toBe(context);
      expect(f.streamSimple.mock.calls[1]?.[2]?.maxRetries).toBe(0);
      expect(f.progress).toHaveBeenLastCalledWith("");
      const events = [];
      for await (const event of stream) events.push(event.type);
      expect(events).toEqual(["start", "done"]);
    },
  );

  it("does not delay a non-quota error", async () => {
    const f = fixture([{ error: "401 Unauthorized" }]);
    expect((await f.run().result()).errorMessage).toBe("401 Unauthorized");
    expect(f.progress).not.toHaveBeenCalled();
    expect(f.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("emits a clear final receipt after three retries", async () => {
    vi.useFakeTimers();
    const f = fixture(Array.from({ length: 4 }, () => ({ error: "insufficient_quota" })));
    const stream = f.run();
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await stream.result()).errorMessage).toBe(
      "Quota retry failed after 3 retries. Try again later.",
    );
    expect(f.streamSimple).toHaveBeenCalledTimes(4);
  });

  it("does not replay a partial stream", async () => {
    const f = fixture([{ error: "429 rate limit", partial: true }]);
    expect((await f.run().result()).errorMessage).toBe("429 rate limit");
    expect(f.streamSimple).toHaveBeenCalledTimes(1);
    expect(f.progress).not.toHaveBeenCalled();
  });

  it("cancels the wait without another request", async () => {
    vi.useFakeTimers();
    const f = fixture([{ error: "429" }]);
    const controller = new AbortController();
    const stream = f.run({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("handles a thrown SDK quota error and its headers", async () => {
    vi.useFakeTimers();
    const f = fixture([{}]);
    f.streamSimple.mockImplementationOnce(() => {
      throw Object.assign(new Error("busy"), {
        status: 429,
        headers: new Headers({ "retry-after": "90" }),
      });
    });
    const stream = f.run();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(f.streamSimple).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await stream.result()).stopReason).toBe("stop");
  });
});
