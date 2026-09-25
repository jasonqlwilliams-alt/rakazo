import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  savedModelChoiceError,
  selectConfiguredModel,
  validateConnectedModelChoice,
} from "./model-selection.js";

type SelectionInput = Parameters<typeof selectConfiguredModel>[0];

function credential(provider: string, defaultModel: string | null) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    defaultModel,
  };
}

const spaceCredential = credential("space-provider", "space-model");
const overrideCredential = credential("bot-provider", "stored-model");
const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };
const defaults: SelectionInput = {
  bot: null,
  overrideCredential: null,
  defaultCredential: spaceCredential,
  settings: { defaultModelProvider: "settings-provider", defaultModelId: "settings-model" },
  deployment: { provider: "deployment-provider", model: "deployment-model" },
};

describe("configured model selection", () => {
  it.each<{
    name: string;
    input: Partial<SelectionInput>;
    expected: ReturnType<typeof selectConfiguredModel>;
  }>([
    {
      name: "uses the bot's model with its own credential",
      input: { bot, overrideCredential },
      expected: {
        provider: "bot-provider",
        id: "bot-model",
        credential: overrideCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "drops override thinking when its provider has no credential",
      input: { bot },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: null,
      },
    },
    {
      name: "keeps bot thinking with the Space default",
      input: { bot: { modelProvider: null, modelId: null, thinkingLevel: "high" } },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "does not select an incomplete bot override",
      input: { bot: { ...bot, modelId: null }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "uses settings before deployment defaults without inventing a credential",
      input: { defaultCredential: null },
      expected: {
        provider: "settings-provider",
        id: "settings-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "uses deployment defaults when no stored configuration exists",
      input: { defaultCredential: null, settings: null },
      expected: {
        provider: "deployment-provider",
        id: "deployment-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "leaves missing configuration for the caller's runtime fallback or failure path",
      input: { defaultCredential: null, settings: null, deployment: null },
      expected: {
        provider: undefined,
        id: undefined,
        credential: null,
        thinkingLevel: null,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(selectConfiguredModel({ ...defaults, ...input })).toEqual(expected);
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => credential("xai", null) },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.spaceId === actor.spaceId &&
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { id: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            isDefault: true,
            modelId: "newest-model",
          };
        }
        return null;
      },
    );
    const customPrisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "private-model"),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { id: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "missing-model"),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(disconnectedPrisma, actor, "anthropic", "claude-opus-4-6"),
    ).resolves.toBe("Connect that model provider first");
  });

  it("accepts a saved id newer than the catalog only when a catalog family can run it", async () => {
    const savedModels = new Set(["grok-4.8", "grok-mystery"]);
    const prisma = {
      spaceModelPreference: {
        findFirst: async (args: { where: { modelId?: string } }) =>
          args.where.modelId && savedModels.has(args.where.modelId) ? { id: "saved" } : null,
      },
      userModelCredential: { findFirst: async () => credential("xai", "grok-4.8") },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(prisma, actor, "xai", "grok-4.8"),
    ).resolves.toBeUndefined();
    // Resolvable but never saved: a bot or tool cannot pick an arbitrary id.
    await expect(validateConnectedModelChoice(prisma, actor, "xai", "grok-4.9")).resolves.toBe(
      "Unknown model for that provider",
    );
    // Saved but with no catalog family to borrow settings from.
    await expect(validateConnectedModelChoice(prisma, actor, "xai", "grok-mystery")).resolves.toBe(
      "Unknown model for that provider",
    );
  });

  it("decides which ids can be saved for a provider", () => {
    expect(savedModelChoiceError("xai", "grok-4.7")).toBeUndefined();
    expect(savedModelChoiceError("xai", "grok-4.8")).toBeUndefined();
    expect(savedModelChoiceError("anthropic", "claude-opus-6")).toBeUndefined();
    expect(savedModelChoiceError("xai", "claude-opus-6")).toBe("Unknown model for that provider");
    expect(savedModelChoiceError("xai", "grok")).toBe("Unknown model for that provider");
    expect(savedModelChoiceError("xai", "  ")).toBe("Enter a model id");
    expect(savedModelChoiceError("openai-compatible", "anything-goes")).toBeUndefined();
  });
});
