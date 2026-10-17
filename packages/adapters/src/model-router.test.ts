import type { ThinkingLevel } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type ModelRoutingCatalogEntry,
  type ModelRoutingCredential,
  refreshRoutedBotModel,
  routeModel,
} from "./model-router.js";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function entry(
  provider: string,
  id: string,
  outputCost: number,
  extras: Partial<ModelRoutingCatalogEntry> = {},
): ModelRoutingCatalogEntry {
  return {
    provider,
    id,
    reasoning: true,
    thinkingLevels: LEVELS,
    outputCost,
    acceptsImages: true,
    ...extras,
  };
}

const anthropic: ModelRoutingCatalogEntry[] = [
  entry("anthropic", "claude-haiku-4-5", 5),
  entry("anthropic", "claude-haiku-4-5-20251001", 5),
  entry("anthropic", "claude-sonnet-4-5", 15),
  entry("anthropic", "claude-sonnet-5", 10),
  entry("anthropic", "claude-opus-4-5", 25),
  entry("anthropic", "claude-opus-5-5", 20),
  entry("anthropic", "claude-fable-5", 50),
  entry("anthropic", "claude-fable-5-1", 50),
];

const openai: ModelRoutingCatalogEntry[] = [
  entry("openai", "gpt-5.4-pro", 180),
  entry("openai", "gpt-5.4-mini", 4.5),
  entry("openai", "gpt-5.4-nano", 1.25),
  entry("openai", "gpt-5-nano", 0.4),
  entry("openai", "gpt-6-luna", 0.5),
  entry("openai", "gpt-6-sol", 10),
  entry("openai", "gpt-6-astra", 50),
];

function credential(provider: string, modelId: string, isDefault = false): ModelRoutingCredential {
  return { provider, modelId, isDefault };
}

function routed(
  credentials: readonly ModelRoutingCredential[],
  catalog: readonly ModelRoutingCatalogEntry[],
  task: Parameters<typeof routeModel>[2],
) {
  const route = routeModel(credentials, catalog, task);
  expect(route).toBeDefined();
  if (!route) throw new Error("expected a route");
  return route;
}

const ordinary = "Please rewrite this update so it is clearer for the team. ".repeat(5);

describe("routeModel", () => {
  const catalog = [...anthropic, ...openai];
  const connected = [
    credential("anthropic", "claude-sonnet-4-5", true),
    credential("openai", "gpt-6-sol"),
  ];

  it("uses a fast model at low effort for a short question and stays on the default provider", () => {
    expect(routeModel(connected, catalog, { prompt: "Thanks" })).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
      thinkingLevel: "low",
    });
  });

  it("uses the newest balanced model at medium effort for an ordinary turn", () => {
    expect(routeModel(connected, catalog, { prompt: ordinary })).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-5",
      thinkingLevel: "medium",
    });
  });

  it("uses the current flagship at high effort for a hard turn", () => {
    expect(
      routeModel(connected, catalog, {
        prompt: "Refactor this migration and debug the root cause\n```ts\nexport const x = 1;\n```",
      }),
    ).toEqual({
      provider: "anthropic",
      id: "claude-fable-5-1",
      thinkingLevel: "high",
    });
  });

  it("raises effort to max when the turn is long, visual, and a hard coding task", () => {
    const prompt = `${"Investigate and refactor this module. ".repeat(80)}\n\`\`\`ts\nexport const x = 1;\n\`\`\``;
    expect(
      routed(connected, catalog, { prompt, needsVision: true, toolCount: 12 }).thinkingLevel,
    ).toBe("max");
  });

  it("follows a newer unlisted id in the saved family", () => {
    const xai = [entry("xai", "grok-4.6", 6), entry("xai", "grok-4.7", 6)];
    expect(
      routeModel([credential("xai", "grok-4.8", true)], xai, { prompt: ordinary }),
    ).toMatchObject({ provider: "xai", id: "grok-4.8", thinkingLevel: "medium" });
  });

  it("keeps an aggregator inside the saved brand", () => {
    const openrouter = [
      entry("openrouter", "anthropic/claude-haiku-4.5", 5),
      entry("openrouter", "anthropic/claude-sonnet-5", 10),
      entry("openrouter", "anthropic/claude-fable-5", 50),
      entry("openrouter", "qwen/qwen-3-max", 1),
    ];
    expect(
      routed([credential("openrouter", "anthropic/claude-sonnet-4.5", true)], openrouter, {
        prompt: "Thanks",
      }).id,
    ).toBe("anthropic/claude-haiku-4.5");
  });

  it("leaves a custom server on the saved model and clamps effort to the levels it accepts", () => {
    expect(
      routeModel(
        [
          {
            provider: "openai-compatible",
            modelId: "qwen",
            isDefault: true,
            reasoning: true,
            thinkingLevels: ["off", "low", "medium"],
          },
        ],
        [],
        { prompt: "Refactor this migration and debug the root cause" },
      ),
    ).toEqual({ provider: "openai-compatible", id: "qwen", thinkingLevel: "medium" });
  });

  it("skips a text-only model when the turn includes an image", () => {
    const visible = anthropic.map((item) =>
      item.id.startsWith("claude-haiku") ? { ...item, acceptsImages: false } : item,
    );
    expect(
      routed([credential("anthropic", "claude-sonnet-5", true)], visible, {
        prompt: "Thanks",
        needsVision: true,
      }).id,
    ).toBe("claude-sonnet-5");
  });

  it("returns nothing when no model is connected", () => {
    expect(routeModel([], catalog, { prompt: "Thanks" })).toBeUndefined();
  });

  it("treats an empty prompt as a standing assignment, not a short question", () => {
    expect(routed(connected, catalog, { prompt: "" }).id).toBe("claude-sonnet-5");
  });

  it("splits a brand with no size words by price into fast, balanced, and flagship", () => {
    const onlyOpenAi = [credential("openai", "gpt-6-sol", true)];
    expect(routed(onlyOpenAi, openai, { prompt: "Thanks" }).id).toBe("gpt-6-luna");
    expect(routed(onlyOpenAi, openai, { prompt: ordinary }).id).toBe("gpt-6-sol");
    expect(
      routed(onlyOpenAi, openai, {
        prompt: "Refactor this migration and debug the root cause",
      }).id,
    ).toBe("gpt-6-astra");
  });
});

describe("refreshRoutedBotModel", () => {
  it("writes the route onto a bot that is still on Auto", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      spaceModelPreference: {
        findMany: async () => [
          {
            modelId: "claude-sonnet-4-5",
            isDefault: true,
            credential: {
              id: "cred-1",
              provider: "anthropic",
              label: "Anthropic",
              secretId: "secret-1",
              supportsImages: false,
            },
          },
        ],
      },
      secret: { findFirst: async () => null },
      bot: { updateMany },
    };
    const route = await refreshRoutedBotModel(
      { prisma: prisma as never, secretStore: { load: () => "" } },
      { userId: "user-1", spaceId: "space-1" },
      { id: "bot-1", modelProvider: null, modelId: null, thinkingLevel: null },
      { prompt: "Thanks" },
    );
    expect(route).toMatchObject({ provider: "anthropic", thinkingLevel: "low" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "user-1", modelRouting: true },
      data: {
        modelProvider: "anthropic",
        modelId: route?.id,
        thinkingLevel: "low",
      },
    });
  });
});
