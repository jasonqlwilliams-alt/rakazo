import type { Api, Model, Models } from "@earendil-works/pi-ai";

/**
 * A family is an id with its numbers taken out: `grok-4.8` and `grok-4.7` are both `grok`, and
 * `claude-opus-6` and `claude-opus-5-5` are both `claude-opus`, while `gpt-5.4-pro` and `gpt-5.4`
 * are not one family. The numbers, in order, are the version.
 */
function modelFamily(modelId: string): { key: string; version: number[] } | undefined {
  const words: string[] = [];
  const version: number[] = [];
  for (const token of modelId.toLowerCase().split(/[-._/:]+/)) {
    if (!token) continue;
    for (const digits of token.match(/\d+/g) ?? []) version.push(Number(digits));
    if (!/^\d+$/.test(token)) words.push(token.replace(/\d+/g, "#"));
  }
  if (version.length === 0) return undefined;
  return { key: words.join("-"), version };
}

function compareVersions(a: readonly number[], b: readonly number[]) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The catalog model a newer id of the same family borrows its request settings from: the newest
 * sibling at or below the requested version, else the oldest one above it.
 */
export function closestFamilyModel<T extends { id: string }>(
  catalogModels: readonly T[],
  modelId: string,
): T | undefined {
  const wanted = modelFamily(modelId.trim());
  if (!wanted) return undefined;
  let below: { model: T; version: number[] } | undefined;
  let above: { model: T; version: number[] } | undefined;
  for (const model of catalogModels) {
    const family = modelFamily(model.id);
    if (!family || family.key !== wanted.key) continue;
    if (compareVersions(family.version, wanted.version) <= 0) {
      if (!below || compareVersions(family.version, below.version) > 0) {
        below = { model, version: family.version };
      }
    } else if (!above || compareVersions(family.version, above.version) < 0) {
      above = { model, version: family.version };
    }
  }
  return (below ?? above)?.model;
}

/**
 * Resolve a provider model: the catalog entry itself, or a newer id that clones the API, reasoning
 * map, limits and pricing of its closest catalog sibling so it runs before Pi's catalog lists it.
 */
export function resolveProviderModel(
  models: Models,
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  const exact = models.getModel(provider, modelId);
  if (exact) return exact;
  const sibling = closestFamilyModel(models.getModels(provider), modelId);
  return sibling ? { ...sibling, id: modelId, name: modelId } : undefined;
}
