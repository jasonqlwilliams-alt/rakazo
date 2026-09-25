import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bumpPi, newestSharedVersion, pinPiPackages } from "./pi-bump.mjs";

function doc(latest: string, ...versions: string[]) {
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
  };
}

describe("newestSharedVersion", () => {
  it("picks the newest stable release both packages published", () => {
    expect(
      newestSharedVersion([
        doc("0.88.0", "0.87.1", "0.88.0"),
        doc("0.88.1", "0.87.1", "0.88.0", "0.88.1"),
      ]),
    ).toBe("0.88.0");
  });

  it("skips prereleases and anything past the latest tag", () => {
    expect(
      newestSharedVersion([
        doc("0.87.1", "0.87.1", "0.88.0", "0.89.0-beta.1"),
        doc("0.88.0", "0.87.1", "0.88.0", "0.89.0-beta.1"),
      ]),
    ).toBe("0.87.1");
    expect(newestSharedVersion([doc("0.9.0", "0.9.0"), doc("0.10.0", "0.10.0")])).toBeUndefined();
  });

  it("orders versions numerically", () => {
    expect(
      newestSharedVersion([doc("0.10.0", "0.9.0", "0.10.0"), doc("0.10.0", "0.9.0", "0.10.0")]),
    ).toBe("0.10.0");
  });
});

describe("pinPiPackages", () => {
  it("pins both packages and keeps the rest of the manifest untouched", () => {
    const text = `{
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.87.1",
    "@earendil-works/pi-ai": "^0.87.1",
    "@earendil-works/pi-telemetry": "0.87.1"
  }
}
`;
    const { text: next, previous } = pinPiPackages(text, "0.88.0");
    expect(previous).toEqual(["^0.87.1", "0.87.1"]);
    expect(next).toBe(`{
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.88.0",
    "@earendil-works/pi-ai": "0.88.0",
    "@earendil-works/pi-telemetry": "0.87.1"
  }
}
`);
  });
});

describe("bumpPi", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function workspace(pin: string) {
    const root = await mkdtemp(path.join(tmpdir(), "pi-bump-"));
    roots.push(root);
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    await mkdir(path.join(root, "packages/adapters"), { recursive: true });
    await writeFile(path.join(root, "apps/web/package.json"), '{ "name": "web" }\n');
    const manifest = path.join(root, "packages/adapters/package.json");
    await writeFile(
      manifest,
      `{\n  "dependencies": {\n    "@earendil-works/pi-agent-core": "${pin}",\n    "@earendil-works/pi-ai": "${pin}"\n  }\n}\n`,
    );
    return { root, manifest };
  }

  function registry(latest: string) {
    const requested: string[] = [];
    const fetchImpl = async (url: string) => {
      requested.push(url);
      return Response.json(doc(latest, "0.87.1", latest));
    };
    return { requested, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("moves every Pi pin to the newest shared release", async () => {
    const { root, manifest } = await workspace("0.87.1");
    const { requested, fetchImpl } = registry("0.88.0");

    await expect(bumpPi({ root, fetchImpl })).resolves.toEqual({
      changed: true,
      previous: "0.87.1",
      version: "0.88.0",
      files: ["packages/adapters/package.json"],
    });
    expect(requested).toEqual([
      "https://registry.npmjs.org/@earendil-works%2Fpi-ai",
      "https://registry.npmjs.org/@earendil-works%2Fpi-agent-core",
    ]);
    expect(await readFile(manifest, "utf8")).toContain('"@earendil-works/pi-ai": "0.88.0"');
    expect(await readFile(manifest, "utf8")).toContain('"@earendil-works/pi-agent-core": "0.88.0"');
  });

  it("reports no change when Pi is current", async () => {
    const { root, manifest } = await workspace("0.88.0");
    const before = await readFile(manifest, "utf8");

    await expect(bumpPi({ root, fetchImpl: registry("0.88.0").fetchImpl })).resolves.toMatchObject({
      changed: false,
      version: "0.88.0",
    });
    expect(await readFile(manifest, "utf8")).toBe(before);
  });

  it("refuses to move Pi backwards", async () => {
    const { root } = await workspace("0.89.0");

    await expect(bumpPi({ root, fetchImpl: registry("0.88.0").fetchImpl })).rejects.toThrow(
      "newer than npm's 0.88.0",
    );
  });
});
