import { randomUUID } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCredentialDto } from "./model-connect.js";
import { closestFamilyModel, resolveProviderModel } from "./model-family.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { resolveCatalogEntry } from "./pi-models.js";
import { PiAgentRuntime } from "./pi-runtime.js";

afterEach(() => vi.unstubAllGlobals());

const ids = (...list: string[]) => list.map((id) => ({ id }));

describe("closest family model", () => {
  it.each([
    ["grok-4.8", ids("grok-4.3", "grok-4.6", "grok-4.7"), "grok-4.7"],
    [
      "claude-opus-6",
      ids("claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"),
      "claude-opus-5-5",
    ],
    ["claude-opus-5-5-20261001", ids("claude-opus-5", "claude-opus-5-5"), "claude-opus-5-5"],
    ["gpt-6.1-luna", ids("gpt-5.6-luna", "gpt-6-luna", "gpt-6-sol"), "gpt-6-luna"],
    ["gemini-3.9-flash", ids("gemini-3.8-flash", "gemini-3-flash-preview"), "gemini-3.8-flash"],
    ["o5", ids("o1", "o3", "o3-mini"), "o3"],
    // A release stage is not a family: the GA id borrows its listed preview.
    [
      "gemini-3.1-pro",
      ids("gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"),
      "gemini-3.1-pro-preview",
    ],
    ["gemini-3-flash", ids("gemini-2.5-flash", "gemini-3-flash-preview"), "gemini-3-flash-preview"],
    // Between siblings of one version, the requested release stage wins.
    ["gemini-3.2-flash", ids("gemini-3.1-flash-preview", "gemini-3.1-flash"), "gemini-3.1-flash"],
    [
      "gemini-3.2-flash-preview",
      ids("gemini-3.1-flash", "gemini-3.1-flash-preview"),
      "gemini-3.1-flash-preview",
    ],
    // Older than every sibling: borrow the oldest newer one.
    ["grok-4.1", ids("grok-4.3", "grok-4.7"), "grok-4.3"],
  ])("%s borrows from its family", (modelId, catalog, expected) => {
    expect(closestFamilyModel(catalog, modelId)?.id).toBe(expected);
  });

  it.each([
    ["gpt-5.4-pro", ids("gpt-5.4", "gpt-5.5")],
    ["grok-mystery", ids("grok-4.7")],
    ["claude-opus-6", ids("claude-sonnet-5")],
  ])("%s has no family to borrow from", (modelId, catalog) => {
    expect(closestFamilyModel(catalog, modelId)).toBeUndefined();
  });
});

const UNLISTED_GROK = "grok-4.999";

function listedGrokId() {
  const sibling = closestFamilyModel(builtinModels().getModels("xai"), UNLISTED_GROK);
  if (!sibling) throw new Error("Pi lists no Grok model");
  return sibling.id;
}

describe("custom model ids on catalog providers", () => {
  it("clones the closest sibling's request settings under the new id", () => {
    const models = builtinModels();
    const sibling = models.getModel("xai", listedGrokId());
    expect(sibling).toBeDefined();
    expect(models.getModel("xai", UNLISTED_GROK)).toBeUndefined();

    expect(resolveProviderModel(models, "xai", UNLISTED_GROK)).toEqual({
      ...sibling,
      id: UNLISTED_GROK,
      name: UNLISTED_GROK,
    });
    expect(resolveProviderModel(models, "xai", listedGrokId())).toBe(sibling);
    expect(resolveProviderModel(models, "xai", "grok-mystery")).toBeUndefined();
  });

  it("reports the family's thinking levels and vision for the new id", () => {
    const sibling = resolveCatalogEntry("xai", listedGrokId());
    expect(sibling?.thinkingLevels?.length).toBeGreaterThan(0);
    expect(resolveCatalogEntry("xai", UNLISTED_GROK)).toEqual({
      ...sibling,
      id: UNLISTED_GROK,
      label: UNLISTED_GROK,
    });
    expect(resolveCatalogEntry("openai-compatible", UNLISTED_GROK)).toBeUndefined();
    expect(modelAcceptsImageInput("xai", UNLISTED_GROK)).toBe(
      modelAcceptsImageInput("xai", listedGrokId()),
    );

    const row = { id: "c1", provider: "xai", label: "xAI", isDefault: true };
    expect(modelCredentialDto({ ...row, defaultModel: UNLISTED_GROK }).thinkingLevels).toEqual(
      sibling?.thinkingLevels,
    );
    expect(
      modelCredentialDto({ ...row, defaultModel: listedGrokId() }).thinkingLevels,
    ).toBeUndefined();
  });
});

describe("Pi runtime with a custom model id", () => {
  function request(modelId: string, provider: string): AgentRunRequest {
    return {
      botId: "bot",
      threadId: "thread",
      runId: randomUUID(),
      prompt: "Hello",
      instructions: "Be brief.",
      history: [],
      tools: [],
      model: { provider, id: modelId, apiKey: "test-key" },
    };
  }

  async function run(modelId: string, provider = "xai") {
    const sent: Array<{ url: string; body: { model?: string; reasoning?: unknown } }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Response.json({ error: { message: "offline" } }, { status: 400 });
    });
    const events: AgentRuntimeEvent[] = [];
    const outcome = (async () => {
      for await (const event of new PiAgentRuntime().run(request(modelId, provider))) {
        events.push(event);
      }
    })();
    return { sent, events, outcome };
  }

  it("sends a newer family id to the provider with its sibling's API and reasoning", async () => {
    const { sent, outcome } = await run(UNLISTED_GROK);
    await expect(outcome).rejects.toThrow("offline");
    expect(sent).toEqual([
      {
        url: "https://api.x.ai/v1/responses",
        body: expect.objectContaining({ model: UNLISTED_GROK, reasoning: expect.any(Object) }),
      },
    ]);
  });

  it("fails the run instead of answering when no family can run the id", async () => {
    const { sent, events, outcome } = await run("grok-mystery");
    await expect(outcome).rejects.toThrow("Unknown model xai/grok-mystery");
    expect(sent).toEqual([]);
    expect(events.filter((event) => event.type === "text" || event.type === "done")).toEqual([]);
  });

  it("keeps a family id on its own provider when OpenRouter lists the same id", async () => {
    const { provider, modelId, sibling } = familyIdOpenRouterAlsoLists();
    const { sent, outcome } = await run(modelId, provider);
    await expect(outcome).rejects.toThrow("offline");
    expect(sent.length).toBeGreaterThan(0);
    for (const { url, body } of sent) {
      expect(url.startsWith(sibling.baseUrl)).toBe(true);
      expect(body.model).toBe(modelId);
    }
    expect(modelAcceptsImageInput(provider, modelId)).toBe(
      modelAcceptsImageInput(provider, sibling.id),
    );
  });

  it("names no family when the provider's list is not a release catalog", async () => {
    const { sent, outcome } = await run("qwen3:32b", "local");
    await expect(outcome).rejects.toThrow(/^Unknown model local\/qwen3:32b$/);
    expect(sent).toEqual([]);
  });
});

function familyIdOpenRouterAlsoLists() {
  const models = builtinModels();
  const openRouterIds = models.getModels("openrouter").map((model) => model.id);
  for (const provider of models.getProviders()) {
    if (provider.id === "openrouter") continue;
    const listed = provider.getModels();
    for (const modelId of openRouterIds) {
      if (listed.some((model) => model.id === modelId)) continue;
      const sibling = closestFamilyModel(listed, modelId);
      if (sibling?.api === "openai-completions") return { provider: provider.id, modelId, sibling };
    }
  }
  throw new Error("Pi lists no family id that OpenRouter also lists");
}
