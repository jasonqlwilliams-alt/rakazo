#!/usr/bin/env node
// Moves Rakazo's Pi packages to their newest shared release. Used by the weekly
// .github/workflows/pi-bump.yml pull request; safe to run by hand.
//
//   node scripts/pi-bump.mjs          bump every workspace manifest, print step outputs
//   node scripts/pi-bump.mjs models   print the Pi catalog as provider/model lines
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Pi releases these together; a mismatched pair does not install cleanly. */
export const PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];
const WORKSPACE_DIRS = ["apps", "packages"];
const WORKSPACE_PACKAGES = ["infra/sandboxes/supervisor", "infra/updater"];
const REGISTRY = "https://registry.npmjs.org";

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Order stable x.y.z versions; anything else sorts first so it is never picked. */
export function compareVersions(a, b) {
  const left = STABLE_VERSION.exec(a);
  const right = STABLE_VERSION.exec(b);
  if (!left || !right) return Number(Boolean(left)) - Number(Boolean(right));
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest stable version every package has published, capped at each package's `latest` tag
 * so a release the maintainers have not promoted yet is skipped.
 * @param {Array<{ versions: Record<string, unknown>, "dist-tags": { latest?: string } }>} docs
 */
export function newestSharedVersion(docs) {
  const perPackage = docs.map((doc) => {
    const latest = doc["dist-tags"]?.latest;
    return new Set(
      Object.keys(doc.versions ?? {}).filter(
        (version) =>
          STABLE_VERSION.test(version) && latest && compareVersions(version, latest) <= 0,
      ),
    );
  });
  const [first, ...rest] = perPackage;
  const shared = [...(first ?? [])].filter((version) => rest.every((set) => set.has(version)));
  return shared.sort(compareVersions).at(-1);
}

/**
 * Pin every Pi package a manifest depends on to `version`, keeping the file's formatting.
 * @returns {{ text: string, previous: string[] }}
 */
export function pinPiPackages(text, version) {
  const previous = [];
  let next = text;
  for (const name of PI_PACKAGES) {
    const pattern = new RegExp(`("${name}"\\s*:\\s*")([^"]+)(")`, "g");
    next = next.replace(pattern, (_match, head, current, tail) => {
      previous.push(current);
      return `${head}${version}${tail}`;
    });
  }
  return { text: next, previous };
}

async function workspaceManifests(root) {
  const dirs = [...WORKSPACE_PACKAGES];
  for (const parent of WORKSPACE_DIRS) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
    }
  }
  const manifests = [];
  for (const dir of dirs) {
    const file = path.join(root, dir, "package.json");
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text && PI_PACKAGES.some((name) => text.includes(`"${name}"`))) {
      manifests.push({ file, text });
    }
  }
  return manifests;
}

async function registryDoc(name, fetchImpl) {
  const response = await fetchImpl(`${REGISTRY}/${name.replace("/", "%2F")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}`);
  return response.json();
}

/**
 * Bump the workspace to the newest shared Pi release.
 * @returns {Promise<{ changed: boolean, previous?: string, version: string, files: string[] }>}
 */
export async function bumpPi({ root, fetchImpl = fetch }) {
  const docs = await Promise.all(PI_PACKAGES.map((name) => registryDoc(name, fetchImpl)));
  const version = newestSharedVersion(docs);
  if (!version) throw new Error(`No shared stable release of ${PI_PACKAGES.join(" and ")}`);
  const manifests = await workspaceManifests(root);
  if (manifests.length === 0) throw new Error("No workspace package depends on Pi");
  const pinned = manifests.map((manifest) => ({
    ...manifest,
    ...pinPiPackages(manifest.text, version),
  }));
  const current = [...new Set(pinned.flatMap((manifest) => manifest.previous))];
  if (current.length === 1 && current[0] === version) {
    return { changed: false, previous: version, version, files: [] };
  }
  const newer = current.filter((pin) => compareVersions(pin, version) > 0);
  if (newer.length) {
    throw new Error(`Pi is pinned to ${newer.join(", ")}, newer than npm's ${version}`);
  }
  for (const manifest of pinned) await writeFile(manifest.file, manifest.text);
  return {
    changed: true,
    previous: current.sort(compareVersions).at(-1),
    version,
    files: pinned.map((manifest) => path.relative(root, manifest.file)),
  };
}

/** Every model the installed Pi catalog lists, as sorted `provider/model` lines. */
async function catalogModelLines(root) {
  const entry = path.join(
    root,
    "packages/adapters/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
  );
  const { builtinModels } = await import(pathToFileURL(entry).href);
  return builtinModels()
    .getModels()
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] === "models") {
    process.stdout.write(`${(await catalogModelLines(root)).join("\n")}\n`);
    return;
  }
  const result = await bumpPi({ root });
  // stdout is key=value lines for $GITHUB_OUTPUT; the summary goes to stderr.
  process.stdout.write(
    `changed=${result.changed}\nprevious=${result.previous ?? ""}\nversion=${result.version}\n`,
  );
  console.error(
    result.changed
      ? `Pi ${result.previous} -> ${result.version} in ${result.files.join(", ")}`
      : `Pi is already at ${result.version}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
