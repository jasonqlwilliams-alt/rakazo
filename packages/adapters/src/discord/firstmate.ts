import type { FirstMateTransportConfig } from "./config.js";
import type {
  BridgeLogger,
  FirstMateAskRequest,
  FirstMateAskResult,
  FirstMateTransport,
} from "./types.js";

const UNAVAILABLE_MESSAGE =
  "FirstMate is not configured on this Rakazo deployment. The external transport URL is unset, so this bridge will not invent a FirstMate answer or route the question through a Rakazo bot.";

export class HttpFirstMateTransport implements FirstMateTransport {
  constructor(
    private readonly config: FirstMateTransportConfig,
    private readonly deps: { fetch?: typeof fetch; logger?: BridgeLogger } = {},
  ) {}

  async ask(request: FirstMateAskRequest): Promise<FirstMateAskResult> {
    const url = this.config.url;
    if (!url) {
      return { ok: false, unavailable: true, message: UNAVAILABLE_MESSAGE };
    }

    const fetchImpl = this.deps.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onOuterAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "firstmate",
          prompt: request.prompt,
          correlation: {
            eventId: request.correlation.eventId,
            eventKind: request.correlation.eventKind,
            interactionId: request.correlation.interactionId,
            guildId: request.correlation.guildId,
            channelId: request.correlation.channelId,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.deps.logger?.warn("firstmate.transport_http_error", { status: response.status });
        return {
          ok: false,
          message: `FirstMate transport returned HTTP ${response.status}.`,
        };
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const text = readReplyText(payload);
      if (!text) {
        return { ok: false, message: "FirstMate transport returned no text reply." };
      }
      return { ok: true, text };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, message: "FirstMate transport timed out." };
      }
      this.deps.logger?.warn("firstmate.transport_failed", {
        error: error instanceof Error ? error.name : "error",
      });
      return { ok: false, message: "FirstMate transport failed." };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

export function firstMateUnavailableMessage(): string {
  return UNAVAILABLE_MESSAGE;
}

function readReplyText(payload: Record<string, unknown>): string | undefined {
  for (const key of ["text", "reply", "content"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
