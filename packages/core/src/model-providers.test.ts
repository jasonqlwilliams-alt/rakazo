import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  connectedModelOptions,
  featuredModelProviders,
  selectedProviderOutsideSearchResults,
  unlistedSavedModelId,
} from "./model-providers.js";

function provider(provider: string): ModelCatalogEntry {
  return {
    provider,
    providerName: provider,
    id: `${provider}-model`,
    label: `${provider} model`,
    billing: "",
  };
}

describe("featuredModelProviders", () => {
  it("shows popular providers in a stable order", () => {
    const providers = [
      provider("azure"),
      provider("vercel-ai-gateway"),
      provider("google"),
      provider("openai"),
      provider("anthropic"),
      provider("openai-codex"),
      provider("openrouter"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "vercel-ai-gateway",
    ]);
  });

  it("fills missing popular slots from the catalog", () => {
    const providers = [
      provider("azure"),
      provider("openrouter"),
      provider("bedrock"),
      provider("anthropic"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "anthropic",
      "azure",
      "bedrock",
    ]);
  });

  it("keeps a non-featured selected provider visible", () => {
    const providers = [
      provider("openrouter"),
      provider("openai-codex"),
      provider("anthropic"),
      provider("openai"),
      provider("google"),
      provider("vercel-ai-gateway"),
      provider("local"),
    ];

    expect(featuredModelProviders(providers, "local").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "local",
    ]);
  });
});

describe("selectedProviderOutsideSearchResults", () => {
  it("returns the active provider separately from unrelated search results", () => {
    const providers = [provider("openrouter"), provider("anthropic"), provider("bedrock")];

    expect(
      selectedProviderOutsideSearchResults(providers.slice(1), providers, "openrouter"),
    ).toMatchObject({ provider: "openrouter" });
  });

  it("returns nothing when the active provider matches the search", () => {
    const providers = [provider("openrouter"), provider("anthropic")];

    expect(
      selectedProviderOutsideSearchResults(providers, providers, "openrouter"),
    ).toBeUndefined();
  });
});

describe("unlistedSavedModelId", () => {
  const catalog = [{ provider: "xai", id: "grok-4.7" }];

  it("returns a saved id the provider's catalog does not list", () => {
    expect(unlistedSavedModelId(catalog, "xai", "grok-4.8")).toBe("grok-4.8");
    expect(unlistedSavedModelId(catalog, "xai", "grok-4.7")).toBeUndefined();
    expect(unlistedSavedModelId(catalog, "xai", undefined)).toBeUndefined();
    expect(unlistedSavedModelId(catalog, "openai-compatible", "local-model")).toBeUndefined();
    expect(unlistedSavedModelId(catalog, "local", "qwen3:32b")).toBeUndefined();
  });
});

describe("connectedModelOptions", () => {
  const catalog = [
    { provider: "xai", providerName: "xAI", id: "grok-4.6", label: "Grok 4.6" },
    { provider: "xai", providerName: "xAI", id: "grok-4.7", label: "Grok 4.7" },
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "model",
      label: "Model",
      placeholder: true,
    },
  ];

  it("offers every catalog model plus a saved id the catalog does not list", () => {
    expect(
      connectedModelOptions(
        [
          { provider: "xai", label: "xAI", modelId: "grok-4.8" },
          { provider: "openai-compatible", label: "Local", modelId: "local-model" },
        ],
        catalog,
      ).map((option) => [option.key, option.label]),
    ).toEqual([
      ["xai::grok-4.6", "xAI · Grok 4.6"],
      ["xai::grok-4.7", "xAI · Grok 4.7"],
      ["xai::grok-4.8", "xAI · grok-4.8"],
      ["openai-compatible::local-model", "Local · local-model"],
    ]);
  });

  it("does not repeat a saved id the catalog lists", () => {
    expect(
      connectedModelOptions([{ provider: "xai", label: "xAI", modelId: "grok-4.7" }], catalog).map(
        (option) => option.modelId,
      ),
    ).toEqual(["grok-4.6", "grok-4.7"]);
  });
});
