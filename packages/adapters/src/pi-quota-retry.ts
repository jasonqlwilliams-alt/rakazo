import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ProviderResponse,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { dispatcherFetch } from "./undici-fetch.js";

const QUOTA_MESSAGE =
  /\b429\b|insufficient_quota|resource_exhausted|rate[ _-]?limit|too many requests|tokens?[- ]per[- ]minute|\b[tr]pm\b.*(?:exceed|limit)|quota.*(?:exceed|exhaust|limit)|(?:exceed|exhaust).*quota/i;

function retryAfter(value: unknown, now: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** Inspect provider errors only, never normal model content or tool results. */
export function classifyQuotaError(
  error: unknown,
  now = Date.now(),
): { retryAfterMs: number } | undefined {
  let quota = false;
  let delay: number | undefined;
  const seen = new Set<unknown>();
  function inspect(value: unknown, depth: number) {
    if (depth > 6 || seen.has(value)) return;
    if (typeof value === "string") {
      quota ||= QUOTA_MESSAGE.test(value);
      // OpenRouter can embed a provider's JSON error in metadata.raw.
      if (value.length <= 16_384 && /^[\s]*[[{]/.test(value)) {
        try {
          inspect(JSON.parse(value), depth + 1);
        } catch {
          /* Plain error text. */
        }
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    quota ||= [record.status, record.statusCode, record.code, record.httpStatusCode].some(
      (v) => v === 429 || v === "429",
    );
    const headers = record.headers;
    const raw =
      headers instanceof Headers
        ? headers.get("retry-after")
        : headers && typeof headers === "object"
          ? Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1]
          : undefined;
    const parsed = retryAfter(raw, now);
    if (parsed !== undefined) delay = Math.max(delay ?? 0, parsed);
    for (const key of [
      "message",
      "errorMessage",
      "code",
      "status",
      "type",
      "error",
      "cause",
      "body",
      "metadata",
      "raw",
      "response",
      "$response",
      "$metadata",
    ]) {
      inspect(record[key], depth + 1);
    }
  }
  inspect(error, 0);
  return quota ? { retryAfterMs: delay ?? 0 } : undefined;
}

export function quotaRetryConfig(env: NodeJS.ProcessEnv = process.env) {
  function integer(raw: string | undefined, fallback: number, minimum: number) {
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
  }
  return {
    delayMs: integer(env.RAKAZO_QUOTA_RETRY_MS, 60_000, 1),
    maxRetries: integer(env.RAKAZO_QUOTA_RETRY_MAX, 3, 0),
  };
}

async function waitForRetry(ms: number, signal?: AbortSignal) {
  // Node timers overflow above a signed 32-bit delay; never turn a long server
  // Retry-After into an immediate retry.
  while (ms > 0) {
    const chunk = Math.min(ms, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, chunk);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    ms -= chunk;
  }
}

/** Retry one model request before content is visible; never replay an agent turn. */
export function streamWithQuotaRetry(
  models: Pick<Models, "streamSimple">,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  progress: (text: string) => void,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  const config = quotaRetryConfig();
  const signal = options?.signal;
  const emptyMessage = (error: unknown): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  });
  void (async () => {
    let retrying = false;
    try {
      for (let retries = 0; ; retries++) {
        signal?.throwIfAborted();
        let response: ProviderResponse | undefined;
        let started: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
        let emitted = false;
        let failure: AssistantMessage | undefined;
        let thrown: unknown;
        const attemptOptions: SimpleStreamOptions = {
          ...options,
          maxRetries: 0,
          onResponse: async (value, selected) => {
            response = value;
            await options?.onResponse?.(value, selected);
          },
        };
        // Pi's OpenAI callback runs only on success; capture failed HTTP headers
        // before its SDK flattens the error. Keep the compatible URL/DNS guard
        // and its matching undici dispatcher intact.
        if (model.api === "openai-completions") {
          const fetch =
            options?.fetch ??
            (model.provider === "openai-compatible" ? dispatcherFetch : globalThis.fetch);
          attemptOptions.fetch = async (input, init) => {
            const result = await fetch(input, init);
            response = {
              status: result.status,
              headers: Object.fromEntries(result.headers.entries()),
            };
            return result;
          };
        }
        try {
          const stream = models.streamSimple(model, context, attemptOptions);
          for await (const event of stream) {
            if (event.type === "start") {
              started = event;
              continue;
            }
            if (event.type === "error") {
              failure = event.error;
              break;
            }
            // Once any content escaped, retrying could duplicate user-visible
            // output or tool calls. Fail normally instead.
            if (retrying) {
              progress("");
              retrying = false;
            }
            if (!emitted && started) output.push(started);
            emitted = true;
            output.push(event);
            if (event.type === "done") return;
          }
          failure ??= await stream.result();
        } catch (error) {
          thrown = error;
          failure = emptyMessage(error);
        }
        if (signal?.aborted) throw signal.reason;
        const quota = classifyQuotaError({ error: thrown ?? failure, response });
        if (!quota || failure.stopReason === "aborted") {
          output.push({
            type: "error",
            reason: failure.stopReason === "aborted" ? "aborted" : "error",
            error: failure,
          });
          return;
        }
        if (emitted || retries >= config.maxRetries) {
          output.push({
            type: "error",
            reason: "error",
            error: {
              ...failure,
              stopReason: "error",
              content: [],
              errorMessage: emitted
                ? "Mid-response quota stop was not retried. Try again later."
                : `Quota retry failed after ${retries} retries. Try again later.`,
            },
          });
          return;
        }
        const delay = Math.max(config.delayMs, quota.retryAfterMs);
        retrying = true;
        progress(
          `Quota, retrying in ${Math.ceil(delay / 1000)}s (${retries + 1}/${config.maxRetries}).`,
        );
        await waitForRetry(delay, signal);
      }
    } catch (error) {
      output.push({
        type: "error",
        reason: signal?.aborted ? "aborted" : "error",
        error: emptyMessage(error),
      });
    } finally {
      if (retrying) progress("");
      output.end();
    }
  })();
  return output;
}
