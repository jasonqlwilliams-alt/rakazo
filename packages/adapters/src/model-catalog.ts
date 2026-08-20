import type { Model, Models, MutableModels, Provider } from "@earendil-works/pi-ai";

/**
 * Models this deployment runs that the pinned `@earendil-works/pi-ai` release does not
 * ship in its bundled catalog yet.
 *
 * This exists because of a real outage. The live workspace runs `xai/grok-4.6`, which the
 * pinned release does not know, and the only thing that made it resolvable was a hand-edit
 * of `node_modules/@earendil-works/pi-ai/dist/providers/data/xai.json` in one checkout.
 * That edit is invisible to git and to the lockfile, so it survives exactly until the next
 * `pnpm install`, and a checkout without it answers every single run with the text
 * "Unknown model xai/grok-4.6" while still recording the run as completed -- a fleet that
 * looks healthy and replies with an error string.
 *
 * Declaring the model here instead means the catalog travels with the repository. Removing
 * an entry once the upstream release carries it is safe: the entry is only added when the
 * provider does not already define that id, so upstream always wins.
 */
export const DEPLOYMENT_MODELS: readonly Model<never>[] = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    compat: { supportsLongCacheRetention: false },
    thinkingLevelMap: {
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
      off: null,
    },
  } as unknown as Model<never>,
];

/**
 * Adds any {@link DEPLOYMENT_MODELS} the catalog is missing, leaving everything else alone.
 *
 * A provider is a plain record whose `getModels` returns its catalog, so the extension is a
 * wrapper around that one function; the provider's auth, base URL and streaming stay the
 * provider's own.
 *
 * A catalog that cannot be extended -- a stub in a test, or a future release that stops
 * exposing the mutable surface -- is handed back untouched rather than throwing, because
 * failing here would take down every run rather than one model.
 */
export function withDeploymentModels(models: Models, extra = DEPLOYMENT_MODELS): Models {
  if (!isMutable(models)) return models;
  for (const [providerId, added] of groupByProvider(extra)) {
    const provider = models.getProvider(providerId);
    if (!provider) continue;
    const existing = provider.getModels();
    const missing = added.filter((model) => !existing.some((known) => known.id === model.id));
    if (missing.length === 0) continue;
    const merged = [...existing, ...missing];
    models.setProvider({ ...provider, getModels: () => merged } as Provider);
  }
  return models;
}

function isMutable(models: Models): models is MutableModels {
  return (
    typeof models.getProvider === "function" &&
    typeof (models as MutableModels).setProvider === "function"
  );
}

function groupByProvider(models: readonly Model<never>[]): Map<string, Model<never>[]> {
  const grouped = new Map<string, Model<never>[]>();
  for (const model of models) {
    const entries = grouped.get(model.provider) ?? [];
    entries.push(model);
    grouped.set(model.provider, entries);
  }
  return grouped;
}
