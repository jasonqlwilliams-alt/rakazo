import type { Api, Model, Models } from "@earendil-works/pi-ai";

/** Release stages name the same model at another point in its rollout, not another family. */
const RELEASE_STAGES = new Set(["preview", "latest", "exp"]);

/**
 * A family is an id with its numbers and release stage taken out: `grok-4.8` and `grok-4.7` are
 * both `grok`, `claude-opus-6` and `claude-opus-5-5` are both `claude-opus`, and `gemini-3.1-pro`
 * and `gemini-3.1-pro-preview` are both `gemini-pro`, while `gpt-5.4-pro` and `gpt-5.4` are not one
 * family. The numbers, in order, are the version.
 */
function modelFamily(
  modelId: string,
): { key: string; stage: string; version: number[] } | undefined {
  const words: string[] = [];
  const stages: string[] = [];
  const version: number[] = [];
  for (const token of modelId.toLowerCase().split(/[-._/:]+/)) {
    if (!token) continue;
    if (RELEASE_STAGES.has(token)) {
      stages.push(token);
      continue;
    }
    for (const digits of token.match(/\d+/g) ?? []) version.push(Number(digits));
    if (!/^\d+$/.test(token)) words.push(token.replace(/\d+/g, "#"));
  }
  if (version.length === 0) return undefined;
  return { key: words.join("-"), stage: stages.join("-"), version };
}

function compareVersions(a: readonly number[], b: readonly number[]) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

type Sibling<T> = { model: T; version: number[]; sameStage: boolean };

/** Whether `candidate` is closer than `current`, where `direction` 1 wants the newer version. */
function isCloser<T>(candidate: Sibling<T>, current: Sibling<T> | undefined, direction: 1 | -1) {
  if (!current) return true;
  const diff = compareVersions(candidate.version, current.version) * direction;
  return diff > 0 || (diff === 0 && candidate.sameStage && !current.sameStage);
}

/**
 * The catalog model a newer id of the same family borrows its request settings from: the newest
 * sibling at or below the requested version, else the oldest one above it. Between siblings of one
 * version, the one at the requested release stage wins.
 */
export function closestFamilyModel<T extends { id: string }>(
  catalogModels: readonly T[],
  modelId: string,
): T | undefined {
  const wanted = modelFamily(modelId.trim());
  if (!wanted) return undefined;
  let below: Sibling<T> | undefined;
  let above: Sibling<T> | undefined;
  for (const model of catalogModels) {
    const family = modelFamily(model.id);
    if (!family || family.key !== wanted.key) continue;
    const sibling = { model, version: family.version, sameStage: family.stage === wanted.stage };
    if (compareVersions(family.version, wanted.version) <= 0) {
      if (isCloser(sibling, below, 1)) below = sibling;
    } else if (isCloser(sibling, above, -1)) {
      above = sibling;
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
