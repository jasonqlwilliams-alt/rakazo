import type { Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderModel } from "./model-family.js";
import { GEMINI_4_ARGON_ID, registerGoogleModels } from "./pi-google-models.js";

type ThinkingConfig = { thinkingLevel?: string; thinkingBudget?: number };

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixtureResponse(): Response {
  const chunk = {
    candidates: [{ content: { role: "model", parts: [{ text: "Ready." }] }, finishReason: "STOP" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** The thinking config Google receives for one turn, captured offline. */
async function sentThinking(modelId: string, reasoning?: "low" | "medium" | "high") {
  let body: { generationConfig?: { thinkingConfig?: ThinkingConfig } } | undefined;
  const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return fixtureResponse();
  });
  vi.stubGlobal("fetch", mockFetch);
  const models = registerGoogleModels(builtinModels());
  const model = (resolveProviderModel(models, "google", modelId) ?? {
    ...models.getModel("google", "gemini-2.5-flash"),
    id: modelId,
  }) as Model<"google-generative-ai">;
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "Hello.", timestamp: 1 }] },
    { apiKey: "test-key", reasoning },
  );
  for await (const _event of stream) {
    // Drain the stream so the request completes.
  }
  const result = await stream.result();
  expect(result.errorMessage).toBeUndefined();
  expect(mockFetch).toHaveBeenCalledOnce();
  return body?.generationConfig?.thinkingConfig;
}

describe("Google models newer than Pi's catalog", () => {
  it("adds Gemini 4 Argon to the Google provider once", () => {
    const models = registerGoogleModels(registerGoogleModels(builtinModels()));
    const argon = models.getModels("google").filter((model) => model.id === GEMINI_4_ARGON_ID);
    expect(argon).toHaveLength(1);
    expect(argon[0]).toMatchObject({
      name: "Gemini 4 Argon",
      api: "google-generative-ai",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
  });

  it("runs a newer Gemini 4 Argon id with Gemini 4 Argon's settings", () => {
    const models = registerGoogleModels(builtinModels());
    expect(resolveProviderModel(models, "google", "gemini-4.1-argon")).toMatchObject({
      id: "gemini-4.1-argon",
      contextWindow: 1_048_576,
    });
    expect(resolveProviderModel(models, "google", "gemini-4-mystery")).toBeUndefined();
  });

  it.each(["low", "medium", "high"] as const)("sends Gemini 4 thinking level %s", async (level) => {
    const thinking = await sentThinking(GEMINI_4_ARGON_ID, level);
    expect(thinking?.thinkingLevel).toBe(level.toUpperCase());
    expect(thinking?.thinkingBudget).toBeUndefined();
  });

  it("sends the lowest Gemini 4 level when thinking is off, since it cannot be disabled", async () => {
    const thinking = await sentThinking(GEMINI_4_ARGON_ID);
    expect(thinking).toMatchObject({ thinkingLevel: "LOW" });
    expect(thinking?.thinkingBudget).toBeUndefined();
  });

  it("sends levels for newer Argon versions", async () => {
    const thinking = await sentThinking("gemini-4.1-argon", "high");
    expect(thinking?.thinkingLevel).toBe("HIGH");
    expect(thinking?.thinkingBudget).toBeUndefined();
  });

  it("leaves other Gemini 4 families on Pi's own thinking format", async () => {
    const thinking = await sentThinking("gemini-4-pro", "high");
    expect(thinking?.thinkingBudget).toEqual(expect.any(Number));
    expect(thinking?.thinkingLevel).toBeUndefined();
  });

  it("leaves earlier Gemini models on Pi's own thinking format", async () => {
    const thinking = await sentThinking("gemini-2.5-flash", "high");
    expect(thinking?.thinkingBudget).toEqual(expect.any(Number));
    expect(thinking?.thinkingLevel).toBeUndefined();
  });
});
