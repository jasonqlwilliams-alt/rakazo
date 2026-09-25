import type { ModelCatalogEntry } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";

export const POPULAR_MODEL_PROVIDER_IDS = [
  "openrouter",
  "openai-codex",
  "anthropic",
  "openai",
  "google",
  "vercel-ai-gateway",
] as const;

const DEFAULT_PROVIDER_COUNT = POPULAR_MODEL_PROVIDER_IDS.length;
const POPULAR_MODEL_PROVIDER_ID_SET = new Set<string>(POPULAR_MODEL_PROVIDER_IDS);

/** Keep provider selection short while ensuring a deployment's current default is never hidden. */
export function featuredModelProviders(
  providers: readonly ModelCatalogEntry[],
  selectedProvider: string,
): ModelCatalogEntry[] {
  const byId = new Map(providers.map((entry) => [entry.provider, entry]));
  const ordered = [
    ...POPULAR_MODEL_PROVIDER_IDS.map((id) => byId.get(id)).filter(
      (entry): entry is ModelCatalogEntry => entry !== undefined,
    ),
    ...providers.filter((entry) => !POPULAR_MODEL_PROVIDER_ID_SET.has(entry.provider)),
  ];
  const featured = ordered.slice(0, DEFAULT_PROVIDER_COUNT);
  const selected = byId.get(selectedProvider);

  if (!selected || featured.some((entry) => entry.provider === selectedProvider)) return featured;
  return [...featured.slice(0, DEFAULT_PROVIDER_COUNT - 1), selected];
}

/** Return the active choice separately when it is not one of the search results. */
export function selectedProviderOutsideSearchResults(
  filteredProviders: readonly ModelCatalogEntry[],
  allProviders: readonly ModelCatalogEntry[],
  selectedProvider: string,
): ModelCatalogEntry | undefined {
  if (filteredProviders.some((entry) => entry.provider === selectedProvider)) {
    return undefined;
  }
  return allProviders.find((entry) => entry.provider === selectedProvider);
}

/**
 * A catalog provider's saved model id that its catalog does not list: a newer model someone typed
 * in. OpenAI-compatible connections always hold a typed id, so they never count.
 */
export function unlistedSavedModelId(
  catalog: readonly Pick<ModelCatalogEntry, "provider" | "id">[],
  provider: string,
  savedModelId: string | null | undefined,
): string | undefined {
  if (!savedModelId || provider === OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
  const listed = catalog.some((entry) => entry.provider === provider && entry.id === savedModelId);
  return listed ? undefined : savedModelId;
}

export type ConnectedModelOption = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
};

export function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

export function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

/**
 * The models a bot can pick from its owner's connections: every catalog model of a connected
 * provider, plus the connection's saved id when the catalog does not list it (a newer model typed
 * in, or an OpenAI-compatible server's model).
 */
export function connectedModelOptions(
  credentials: readonly { provider: string; label: string; modelId?: string }[],
  catalog: readonly Pick<
    ModelCatalogEntry,
    "provider" | "providerName" | "id" | "label" | "placeholder"
  >[],
): ConnectedModelOption[] {
  const options = new Map<string, ConnectedModelOption>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    for (const entry of providerModels) {
      const key = modelOptionKey(entry.provider, entry.id);
      if (options.has(key)) continue;
      options.set(key, {
        key,
        provider: entry.provider,
        modelId: entry.id,
        label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
      });
    }
    const savedModelId = credential.modelId;
    if (!savedModelId || providerModels.some((entry) => entry.id === savedModelId)) continue;
    const key = modelOptionKey(credential.provider, savedModelId);
    if (options.has(key)) continue;
    options.set(key, {
      key,
      provider: credential.provider,
      modelId: savedModelId,
      label: `${credential.label} · ${savedModelId}`,
    });
  }
  return [...options.values()];
}
