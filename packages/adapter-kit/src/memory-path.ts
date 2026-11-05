/**
 * Memory documents are addressed by a `(scope, botId, path)` key. Scope is already a
 * separate field, but memory is rendered to the model under a scoped heading, and models
 * copy that scope back into `path` — producing forked documents such as
 * `bot: history/digest.md` and `bot/relationships.md` alongside the real ones. Every path
 * that reaches the store is normalised and validated here so a malformed path resolves to
 * the real document, or is rejected, instead of silently creating a second one.
 */

export const DEFAULT_MEMORY_PATH = "MEMORY.md";

/** Leading `bot: `, `user: `, `bot/`, or `user/` — the rendered scope leaking into the path. */
const SCOPE_PREFIX = /^(?:bot|user)[ \t]*[:/][ \t]*/i;

/** A path is a document key, so it carries neither the scope separator nor whitespace. */
const INVALID_PATH_CHARACTERS = /[:\s]/;

const MAX_PREFIX_STRIPS = 4;

export type MemoryPathResolution = { ok: true; path: string } | { ok: false; reason: string };

export class MemoryPathError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MemoryPathError";
  }
}

/**
 * Resolve a caller-supplied memory path to the document key it means.
 * An empty path resolves to {@link DEFAULT_MEMORY_PATH}; a leading scope prefix is
 * stripped; anything still malformed is rejected rather than written to a new document.
 */
export function resolveMemoryPath(raw: string | null | undefined): MemoryPathResolution {
  let path = (raw ?? "").trim();
  if (path === "") return { ok: true, path: DEFAULT_MEMORY_PATH };

  for (let strip = 0; strip < MAX_PREFIX_STRIPS && SCOPE_PREFIX.test(path); strip += 1) {
    path = path.replace(SCOPE_PREFIX, "").trim();
  }

  const hint = `Use a plain relative path such as "${DEFAULT_MEMORY_PATH}" or "history/digest.md", without a scope prefix.`;
  if (path === "") {
    return { ok: false, reason: `Memory path "${raw}" is only a scope prefix. ${hint}` };
  }
  if (INVALID_PATH_CHARACTERS.test(path)) {
    return {
      ok: false,
      reason: `Memory path "${raw}" contains ":" or whitespace, which is not a valid document path. ${hint}`,
    };
  }
  if (path.startsWith("/") || path.split("/").includes("..")) {
    return {
      ok: false,
      reason: `Memory path "${raw}" must be relative and must not traverse upwards. ${hint}`,
    };
  }
  return { ok: true, path };
}

/** Resolve a memory path or throw {@link MemoryPathError}. */
export function requireMemoryPath(raw: string | null | undefined): string {
  const resolved = resolveMemoryPath(raw);
  if (!resolved.ok) throw new MemoryPathError(resolved.reason);
  return resolved.path;
}
