import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@rakazo/contracts";
import { acceptsNewerModelIds } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { modelCredentialDto } from "./model-connect.js";
import { compareModelVersions, modelFamilyParts } from "./model-family.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { listPiCatalog } from "./pi-models.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

const RELEASE_STAGES = new Set(["preview", "latest", "exp"]);
const FAST_TOKENS = new Set(["flash", "haiku", "mini", "nano", "lite", "small", "instant", "fast"]);
const FRONTIER_TOKENS = new Set(["opus", "fable", "pro", "ultra"]);
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// A provider listing this many models, or mostly vendor/model ids, is an aggregator.
// Routing then stays inside the saved model's brand instead of the whole catalog.
const BRAND_POOL_MIN = 30;
const HEAVY_TEXT =
  /\b(debug(?:ging)?|implement|refactor|migrate|architect|investigate|research|analy[sz]e|root[\s-]?cause)\b/i;
const CODE_TEXT = /```|\b(function|class|import |export |const |def |SELECT )\b/;

type Klass = "fast" | "balanced" | "frontier";
type Band = "light" | "standard" | "heavy" | "max";

export type ModelRoutingCredential = {
  provider: string;
  modelId: string | null;
  isDefault: boolean;
  reasoning?: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
  outputCost?: number;
  acceptsImages?: boolean;
};

export type ModelRoutingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
  outputCost?: number;
  acceptsImages?: boolean;
  placeholder?: boolean;
};

export type ModelRouteTask = {
  /** The user turn or routine prompt. Empty means a standing assignment, not a light turn. */
  prompt: string;
  instructions?: string;
  needsVision?: boolean;
  toolCount?: number;
};

export type ModelRoute = {
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
};

type Candidate = {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevels: readonly ThinkingLevel[];
  outputCost?: number;
  acceptsImages?: boolean;
};

let cachedCatalog: ModelRoutingCatalogEntry[] | undefined;

/** Catalog rows with the price and vision flags the router ranks on. Cached with the Pi catalog. */
export function piRoutingCatalog(): ModelRoutingCatalogEntry[] {
  if (cachedCatalog) return cachedCatalog;
  const models = registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
  cachedCatalog = listPiCatalog()
    .filter((entry) => !entry.placeholder && entry.provider !== "scripted")
    .map((entry) => {
      const model = models.getModel(entry.provider, entry.id);
      return {
        provider: entry.provider,
        id: entry.id,
        reasoning: entry.reasoning,
        thinkingLevels: entry.thinkingLevels,
        outputCost: model?.cost.output,
        acceptsImages: model ? model.input.includes("image") : undefined,
      };
    });
  return cachedCatalog;
}

function tokensOf(modelId: string) {
  return modelId
    .toLowerCase()
    .split(/[-._/:]+/)
    .filter((token) => token && !RELEASE_STAGES.has(token) && !/^\d+$/.test(token));
}

function brandKey(modelId: string) {
  const tokens = tokensOf(modelId);
  if (modelId.includes("/")) return tokens[1] ?? tokens[0] ?? modelId.toLowerCase();
  return tokens[0] ?? modelId.toLowerCase();
}

function rankVersion(modelId: string) {
  return modelFamilyParts(modelId)?.version ?? [];
}

function majorOf(modelId: string) {
  return rankVersion(modelId)[0] ?? -1;
}

function tokenClass(modelId: string): Klass | "open" {
  const tokens = tokensOf(modelId);
  if (tokens.some((token) => FAST_TOKENS.has(token))) return "fast";
  if (tokens.some((token) => FRONTIER_TOKENS.has(token))) return "frontier";
  return "open";
}

function isDatedSnapshot(modelId: string, ids: ReadonlySet<string>) {
  const match = /^(.*)-\d{4,8}$/.exec(modelId);
  return Boolean(match?.[1] && ids.has(match[1]));
}

function candidateKey(candidate: { provider: string; id: string }) {
  return `${candidate.provider}\0${candidate.id}`;
}

function familyId(candidate: Candidate) {
  const parts = modelFamilyParts(candidate.id);
  return `${candidate.provider}\0${parts?.key ?? candidate.id}`;
}

/**
 * Size words name a class directly. Names with no size word (luna, sol, astra, grok) split by
 * output price inside the newest generation, so a new size name still lands in a tier.
 */
function assignClasses(models: readonly Candidate[]) {
  const assigned = new Map<string, Klass>();
  const open: Candidate[] = [];
  for (const model of models) {
    const token = tokenClass(model.id);
    if (token === "open") open.push(model);
    else assigned.set(candidateKey(model), token);
  }
  const maxMajor = open.reduce((max, model) => Math.max(max, majorOf(model.id)), -1);
  const newestOpen = open.filter((model) => majorOf(model.id) === maxMajor);
  const costs = newestOpen.map((model) => model.outputCost ?? 0).filter((cost) => cost > 0);
  const min = costs.length ? Math.min(...costs) : 0;
  const max = costs.length ? Math.max(...costs) : 0;
  const split = newestOpen.length >= 2 && min > 0 && max / min >= 4 && new Set(costs).size >= 2;
  if (!split) {
    for (const model of open) assigned.set(candidateKey(model), "balanced");
    return assigned;
  }
  const sorted = [...newestOpen].sort(
    (a, b) => (a.outputCost ?? 0) - (b.outputCost ?? 0) || a.id.localeCompare(b.id),
  );
  if (sorted.length === 2) {
    assigned.set(candidateKey(sorted[0]!), "fast");
    assigned.set(candidateKey(sorted[1]!), "balanced");
    return assigned;
  }
  for (const [index, model] of sorted.entries()) {
    const klass: Klass =
      index === 0 ? "fast" : index === sorted.length - 1 ? "frontier" : "balanced";
    assigned.set(candidateKey(model), klass);
  }
  return assigned;
}

function newestInFamily(models: readonly Candidate[]) {
  const sorted = [...models].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  return sorted.reduce((best, model) =>
    compareModelVersions(rankVersion(model.id), rankVersion(best.id)) > 0 ? model : best,
  );
}

function classOrder(band: Band): Klass[] {
  switch (band) {
    case "light":
      return ["fast", "balanced", "frontier"];
    case "standard":
      return ["balanced", "frontier", "fast"];
    case "heavy":
    case "max":
      return ["frontier", "balanced", "fast"];
    default: {
      const exhaustive: never = band;
      return exhaustive;
    }
  }
}

function routeBand(task: ModelRouteTask): Band {
  const prompt = task.prompt.trim();
  if (!prompt) return "standard";
  let score = 0;
  if (prompt.length > 900) score += 1;
  if (prompt.length > 3500) score += 1;
  if (HEAVY_TEXT.test(prompt)) score += 1;
  if (CODE_TEXT.test(prompt)) score += 1;
  if (task.needsVision) score += 1;
  if ((task.toolCount ?? 0) >= 12) score += 1;
  const instructions = task.instructions ?? "";
  if (HEAVY_TEXT.test(instructions) || CODE_TEXT.test(instructions)) score += 1;
  const hard = HEAVY_TEXT.test(prompt) || CODE_TEXT.test(prompt);
  if (score >= 4) return "max";
  if (hard || score >= 2) return "heavy";
  if (score === 0 && prompt.length < 240 && (task.toolCount ?? 0) < 6) return "light";
  return "standard";
}

function preferredEffort(band: Band): ThinkingLevel {
  switch (band) {
    case "light":
      return "low";
    case "standard":
      return "medium";
    case "heavy":
      return "high";
    case "max":
      return "max";
    default: {
      const exhaustive: never = band;
      return exhaustive;
    }
  }
}

function clampEffort(
  preferred: ThinkingLevel,
  levels: readonly ThinkingLevel[],
  reasoning: boolean,
): ThinkingLevel {
  if (!reasoning) return levels.includes("off") ? "off" : (levels[0] ?? "off");
  const usable = levels.filter((level) => level !== "off");
  const pool = usable.length ? usable : levels;
  if (pool.includes(preferred)) return preferred;
  const target = EFFORT_ORDER.indexOf(preferred);
  for (let index = target; index >= 0; index -= 1) {
    const level = EFFORT_ORDER[index];
    if (level && level !== "off" && pool.includes(level)) return level;
  }
  for (const level of EFFORT_ORDER) {
    if (level !== "off" && pool.includes(level)) return level;
  }
  return pool[0] ?? "medium";
}

function pickFromClass(models: readonly Candidate[], band: Band, klass: Klass) {
  const heads = [...groupByFamily(models).values()].map((group) => newestInFamily(group));
  const maxMajor = heads.reduce((max, model) => Math.max(max, majorOf(model.id)), -1);
  let pool = heads.filter((model) => majorOf(model.id) === maxMajor);
  if (!pool.length) pool = heads;
  const priced = pool.some((model) => (model.outputCost ?? 0) > 0);
  if (priced && klass === "frontier") {
    const positive = pool.filter((model) => (model.outputCost ?? 0) > 0);
    const target = Math.max(...positive.map((model) => model.outputCost ?? 0));
    pool = positive.filter((model) => (model.outputCost ?? 0) === target);
  } else {
    const best = pool.reduce<number[]>(
      (current, model) =>
        compareModelVersions(rankVersion(model.id), current) > 0 ? rankVersion(model.id) : current,
      [],
    );
    pool = pool.filter((model) => compareModelVersions(rankVersion(model.id), best) === 0);
    if (priced) {
      const positive = pool.filter((model) => (model.outputCost ?? 0) > 0);
      const costs = positive.map((model) => model.outputCost ?? 0);
      const target = klass === "fast" && band === "light" ? Math.min(...costs) : Math.max(...costs);
      const matched = positive.filter((model) => (model.outputCost ?? 0) === target);
      if (matched.length) pool = matched;
    }
  }
  return [...pool].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))[0];
}

function groupByFamily(models: readonly Candidate[]) {
  const groups = new Map<string, Candidate[]>();
  for (const model of models) {
    const key = familyId(model);
    const group = groups.get(key);
    if (group) group.push(model);
    else groups.set(key, [model]);
  }
  return groups;
}

function poolMode(provider: string, models: readonly ModelRoutingCatalogEntry[]) {
  if (!acceptsNewerModelIds(provider) || models.length === 0) return "saved" as const;
  const slashed = models.filter((model) => model.id.includes("/")).length;
  if (slashed / models.length >= 0.5 || models.length > BRAND_POOL_MIN) return "brand" as const;
  return "catalog" as const;
}

function toCandidate(
  entry: ModelRoutingCatalogEntry,
  credential?: ModelRoutingCredential,
): Candidate {
  return {
    provider: entry.provider,
    id: entry.id,
    reasoning: credential?.reasoning ?? Boolean(entry.reasoning),
    thinkingLevels:
      credential?.thinkingLevels ??
      entry.thinkingLevels ??
      (entry.reasoning ? ["low", "medium", "high"] : ["off"]),
    outputCost: credential?.outputCost ?? entry.outputCost,
    acceptsImages: credential?.acceptsImages ?? entry.acceptsImages,
  };
}

function siblingEntry(
  catalog: readonly ModelRoutingCatalogEntry[],
  provider: string,
  modelId: string,
) {
  const wanted = modelFamilyParts(modelId);
  if (!wanted) return undefined;
  const siblings = catalog.filter(
    (entry) =>
      entry.provider === provider &&
      !entry.placeholder &&
      modelFamilyParts(entry.id)?.key === wanted.key,
  );
  return siblings.reduce<ModelRoutingCatalogEntry | undefined>((best, entry) => {
    if (!best) return entry;
    return compareModelVersions(rankVersion(entry.id), rankVersion(best.id)) > 0 ? entry : best;
  }, undefined);
}

function candidatesForCredential(
  credential: ModelRoutingCredential,
  catalog: readonly ModelRoutingCatalogEntry[],
) {
  const providerEntries = catalog.filter(
    (entry) => entry.provider === credential.provider && !entry.placeholder,
  );
  const mode = poolMode(credential.provider, providerEntries);
  if (mode === "saved") {
    if (!credential.modelId) return [];
    const exact = providerEntries.find((entry) => entry.id === credential.modelId);
    return [
      toCandidate(exact ?? { provider: credential.provider, id: credential.modelId }, credential),
    ];
  }
  const brand = credential.modelId ? brandKey(credential.modelId) : undefined;
  const picked = providerEntries.filter((entry) => !brand || brandKey(entry.id) === brand);
  const ids = new Set(picked.map((entry) => entry.id));
  const withoutSnapshots = picked.filter((entry) => !isDatedSnapshot(entry.id, ids));
  const candidates = withoutSnapshots.map((entry) => toCandidate(entry));
  if (credential.modelId && !candidates.some((candidate) => candidate.id === credential.modelId)) {
    const sibling = siblingEntry(catalog, credential.provider, credential.modelId);
    candidates.push(
      toCandidate(
        {
          provider: credential.provider,
          id: credential.modelId,
          reasoning: sibling?.reasoning,
          thinkingLevels: sibling?.thinkingLevels,
          outputCost: sibling?.outputCost,
          acceptsImages: sibling?.acceptsImages,
        },
        credential,
      ),
    );
  }
  return candidates;
}

/**
 * Pick a connected model and effort for this turn.
 *
 * Stays on the workspace default provider, and on an aggregator stays inside the saved model's
 * brand, then takes the newest model in the tier the turn needs. Effort follows the turn and is
 * clamped to the levels that model actually accepts.
 */
export function routeModel(
  credentials: readonly ModelRoutingCredential[],
  catalog: readonly ModelRoutingCatalogEntry[],
  task: ModelRouteTask,
): ModelRoute | undefined {
  const pool = credentials.flatMap((credential) => candidatesForCredential(credential, catalog));
  if (!pool.length) return undefined;
  const defaultProvider = credentials.find((credential) => credential.isDefault)?.provider;
  const onDefault = defaultProvider
    ? pool.filter((candidate) => candidate.provider === defaultProvider)
    : [];
  let candidates = onDefault.length ? onDefault : pool;
  if (task.needsVision && candidates.some((candidate) => candidate.acceptsImages === true)) {
    candidates = candidates.filter((candidate) => candidate.acceptsImages === true);
  }
  const classes = assignClasses(candidates);
  const band = routeBand(task);
  for (const klass of classOrder(band)) {
    const inClass = candidates.filter(
      (candidate) => classes.get(candidateKey(candidate)) === klass,
    );
    const chosen = inClass.length ? pickFromClass(inClass, band, klass) : undefined;
    if (!chosen) continue;
    return {
      provider: chosen.provider,
      id: chosen.id,
      thinkingLevel: clampEffort(preferredEffort(band), chosen.thinkingLevels, chosen.reasoning),
    };
  }
  return undefined;
}

type RoutingSecretStore = {
  load(ciphertext: string, recordId: string): string;
};

/**
 * Choose the route and write it onto the bot when Auto is still on.
 * The run uses the returned route even if a later pin wins the update.
 */
export async function refreshRoutedBotModel(
  deps: { prisma: PrismaClient; secretStore: RoutingSecretStore },
  scope: { userId: string; spaceId: string },
  bot: {
    id: string;
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  },
  task: ModelRouteTask,
): Promise<ModelRoute | undefined> {
  const preferences = await deps.prisma.spaceModelPreference.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId },
    include: { credential: true },
  });
  const credentials: ModelRoutingCredential[] = [];
  for (const preference of preferences) {
    const credential = preference.credential;
    const row: ModelRoutingCredential = {
      provider: credential.provider,
      modelId: preference.modelId,
      isDefault: preference.isDefault,
    };
    if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID && preference.modelId) {
      const secret = await deps.prisma.secret.findFirst({
        where: { id: credential.secretId, userId: scope.userId, spaceId: null },
        select: { ciphertext: true },
      });
      if (secret) {
        try {
          const dto = modelCredentialDto(
            {
              id: credential.id,
              provider: credential.provider,
              label: credential.label,
              isDefault: preference.isDefault,
              defaultModel: preference.modelId,
              supportsImages: credential.supportsImages,
            },
            deps.secretStore.load(secret.ciphertext, credential.secretId),
          );
          row.reasoning = dto.reasoning ?? false;
          row.thinkingLevels = dto.thinkingLevels;
          row.acceptsImages = dto.supportsImages ?? false;
        } catch {
          // An unreadable connection still routes, without claiming reasoning or vision.
        }
      }
    }
    credentials.push(row);
  }
  const route = routeModel(credentials, piRoutingCatalog(), task);
  if (!route) return undefined;
  if (
    bot.modelProvider !== route.provider ||
    bot.modelId !== route.id ||
    bot.thinkingLevel !== route.thinkingLevel
  ) {
    await deps.prisma.bot.updateMany({
      where: {
        id: bot.id,
        spaceId: scope.spaceId,
        userId: scope.userId,
        modelRouting: true,
      },
      data: {
        modelProvider: route.provider,
        modelId: route.id,
        thinkingLevel: route.thinkingLevel,
      },
    });
  }
  return route;
}
