import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { resolveProviderModel } from "./model-family.js";
import { listPiCatalog, resolveCatalogEntry } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

describe("current model compatibility", () => {
  it.each([
    [
      "anthropic",
      "claude-sonnet-5-5",
      "Claude Sonnet 5.5",
      ["low", "medium", "high", "xhigh", "max"],
    ],
    [
      "anthropic",
      "claude-haiku-5-5",
      "Claude Haiku 5.5",
      ["off", "low", "medium", "high", "xhigh", "max"],
    ],
    ["google", "gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
    // Codex maps minimal to low upstream, as it already does for gpt-6-sol.
    [
      "openai-codex",
      "gpt-6.1-sol",
      "GPT-6.1 Sol",
      ["minimal", "low", "medium", "high", "xhigh", "max"],
    ],
  ])(
    "resolves %s/%s from the Pi catalog in the picker and runtime",
    (provider, id, name, levels) => {
      const models = modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      );
      const model = models.getModel(provider, id);
      expect(model).toMatchObject({ provider, id, name });
      // The catalog lists the id itself, so lookup never falls back to a cloned sibling.
      expect(resolveProviderModel(models, provider, id)).toBe(model);
      expect(getSupportedThinkingLevels(model!)).toEqual(levels);
      expect(model?.input).toContain("image");

      const entry = listPiCatalog().find((item) => item.provider === provider && item.id === id);
      expect(entry).toMatchObject({ provider, id, thinkingLevels: levels });
      expect(resolveCatalogEntry(provider, id)).toEqual(entry);
    },
  );

  it("keeps Claude Sonnet 5.5's adaptive-thinking compatibility from the provider library", () => {
    expect(builtinModels().getModel("anthropic", "claude-sonnet-5-5")?.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    });
  });
});
