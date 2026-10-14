import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";

const GOOGLE_PROVIDER_ID = "google";

export const GEMINI_4_ARGON_ID = "gemini-4-argon";

const LEVEL_ONLY_GEMINI_ARGON = /^gemini-\d+(?:[.-]\d+)*-argon(?:-(?:preview|latest|exp))?$/;

/** Gemini 4 Argon as Google's Gemini API model page publishes it, until Pi's catalog lists it. */
function gemini4Argon(baseUrl: string | undefined): Model<"google-generative-ai"> {
  return {
    id: GEMINI_4_ARGON_ID,
    name: "Gemini 4 Argon",
    api: "google-generative-ai",
    provider: GOOGLE_PROVIDER_ID,
    baseUrl: baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    // Deliberately record standard $4/$20 rates so estimates never understate; Google lists introductory half rates through 2026-11-30.
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

/**
 * Pi picks Google's thinking wire format by model id and sends a token budget to every id it does
 * not recognize as level-based, while Gemini 4 Argon documents only discrete levels. Send the level.
 * Thinking cannot be turned off, so "off" lands on the lowest supported level.
 */
function withLevelOnlyThinking(google: Provider): Provider["streamSimple"] {
  return (model, context, options) => {
    if (!model.reasoning || !LEVEL_ONLY_GEMINI_ARGON.test(model.id.toLowerCase())) {
      return google.streamSimple(model, context, options);
    }
    const level = clampThinkingLevel(model, options?.reasoning ?? "off");
    const googleOptions: GoogleOptions = {
      ...buildBaseOptions(model, context, options, options?.apiKey),
      toolChoice: options?.toolChoice as GoogleOptions["toolChoice"],
      thinking: {
        enabled: true,
        level: level.toUpperCase() as NonNullable<GoogleOptions["thinking"]>["level"],
      },
    };
    return google.stream(model, context, googleOptions);
  };
}

/**
 * Add Gemini 4 Argon to Pi's Google provider until Pi's catalog lists it, and send Argon
 * thinking as a level either way.
 */
export function registerGoogleModels(models: MutableModels): MutableModels {
  const google = models.getProvider(GOOGLE_PROVIDER_ID);
  if (!google) return models;
  const listed = google.getModels();
  const additions = listed.some((model) => model.id === GEMINI_4_ARGON_ID)
    ? []
    : [gemini4Argon(google.baseUrl)];
  models.setProvider({
    ...google,
    getModels: () => [...google.getModels(), ...additions],
    streamSimple: withLevelOnlyThinking(google),
  });
  return models;
}
