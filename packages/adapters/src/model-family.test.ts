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

describe("custom model ids on catalog providers", () => {
  it("clones the closest sibling's request settings under the new id", () => {
    const models = builtinModels();
    const sibling = models.getModel("xai", "grok-4.7");
    expect(models.getModel("xai", "grok-4.8")).toBeUndefined();

    expect(resolveProviderModel(models, "xai", "grok-4.8")).toEqual({
      ...sibling,
      id: "grok-4.8",
      name: "grok-4.8",
    });
    expect(resolveProviderModel(models, "xai", "grok-4.7")).toBe(sibling);
    expect(resolveProviderModel(models, "xai", "grok-mystery")).toBeUndefined();
  });

  it.each([
    ["gemini-3.1-pro", "gemini-3.1-pro-preview"],
    ["gemini-3-flash", "gemini-3-flash-preview"],
  ])("runs the GA id %s with its listed preview's settings", (modelId, preview) => {
    const models = builtinModels();
    expect(models.getModel("google", modelId)).toBeUndefined();

    expect(resolveProviderModel(models, "google", modelId)).toEqual({
      ...models.getModel("google", preview),
      id: modelId,
      name: modelId,
    });
    expect(resolveCatalogEntry("google", modelId)?.thinkingLevels).toEqual(
      resolveCatalogEntry("google", preview)?.thinkingLevels,
    );
  });

  it("reports the family's thinking levels and vision for the new id", () => {
    const sibling = resolveCatalogEntry("xai", "grok-4.7");
    expect(resolveCatalogEntry("xai", "grok-4.8")).toEqual({
      ...sibling,
      id: "grok-4.8",
      label: "grok-4.8",
    });
    expect(resolveCatalogEntry("openai-compatible", "grok-4.8")).toBeUndefined();
    expect(modelAcceptsImageInput("xai", "grok-4.8")).toBe(true);

    const row = { id: "c1", provider: "xai", label: "xAI", isDefault: true };
    expect(modelCredentialDto({ ...row, defaultModel: "grok-4.8" }).thinkingLevels).toEqual(
      sibling?.thinkingLevels,
    );
    expect(modelCredentialDto({ ...row, defaultModel: "grok-4.7" }).thinkingLevels).toBeUndefined();
  });
});

describe("Pi runtime with a custom model id", () => {
  function request(modelId: string): AgentRunRequest {
    return {
      botId: "bot",
      threadId: "thread",
      runId: randomUUID(),
      prompt: "Hello",
      instructions: "Be brief.",
      history: [],
      tools: [],
      model: { provider: "xai", id: modelId, apiKey: "test-key" },
    };
  }

  async function run(modelId: string) {
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
      for await (const event of new PiAgentRuntime().run(request(modelId))) events.push(event);
    })();
    return { sent, events, outcome };
  }

  it("sends a newer family id to the provider with its sibling's API and reasoning", async () => {
    const { sent, outcome } = await run("grok-4.8");
    await expect(outcome).rejects.toThrow("offline");
    expect(sent).toEqual([
      {
        url: "https://api.x.ai/v1/responses",
        body: expect.objectContaining({ model: "grok-4.8", reasoning: expect.any(Object) }),
      },
    ]);
  });

  it("fails the run instead of answering when no family can run the id", async () => {
    const { sent, events, outcome } = await run("grok-mystery");
    await expect(outcome).rejects.toThrow("Unknown model xai/grok-mystery");
    expect(sent).toEqual([]);
    expect(events.filter((event) => event.type === "text" || event.type === "done")).toEqual([]);
  });
});
