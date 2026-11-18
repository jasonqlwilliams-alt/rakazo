import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, ConnectorEvent, FileCatalogProvider } from "@rakazo/adapter-kit";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createConnectorStack } from "./composio-connector.js";
import {
  FileCatalogConnector,
  fileCatalogProvidersFromConfig,
  LocalFileCatalogProvider,
} from "./file-catalog.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const page = { files: [{ id: "1", name: "report.txt", bytes: 4, sha256: "ab".repeat(32) }] };
const packet = { packetId: `pkt-retrieval-${"a".repeat(32)}` };

async function execute(
  connector: FileCatalogConnector,
  tool: string,
  args: Record<string, unknown>,
  ctx = context,
) {
  const events: ConnectorEvent[] = [];
  for await (const event of connector.execute({ tool, args, executionId: "call" }, ctx))
    events.push(event);
  return events;
}

function fixture() {
  const search = vi.fn<FileCatalogProvider["search"]>().mockResolvedValue(page);
  const request = vi.fn<FileCatalogProvider["request"]>().mockResolvedValue(packet);
  return { search, request, connector: new FileCatalogConnector({ search, request }) };
}

describe("optional catalog connector", () => {
  it("returns a bounded empty page with a continuation cursor", async () => {
    const search = vi.fn<FileCatalogProvider["search"]>().mockResolvedValue({
      files: [],
      nextCursor: "1000000000000000000",
      scanTruncated: true,
    });
    const connector = new FileCatalogConnector({ search, request: fixture().request });
    expect(await execute(connector, "catalog_search", { query: "target" })).toEqual([
      {
        type: "result",
        data: { files: [], nextCursor: "1000000000000000000", scanTruncated: true },
      },
    ]);
  });
  it("registers tools only when the shared host configuration is set", async () => {
    for (const path of [undefined, "  "]) {
      const stack = createConnectorStack(false, undefined, fileCatalogProvidersFromConfig(path));
      expect((await stack.connector.discoverTools(context)).map((tool) => tool.name)).not.toContain(
        "catalog_search",
      );
    }
    const stack = createConnectorStack(
      false,
      undefined,
      fileCatalogProvidersFromConfig(" /synthetic/catalog.json "),
    );
    expect((await stack.connector.discoverTools(context)).map((tool) => tool.name)).toContain(
      "catalog_search",
    );
  });
  it("declares search as read-only and request as an approval-requiring write", async () => {
    const { connector } = fixture();
    expect(
      (await connector.discoverTools(context)).map(({ name, readOnly }) => ({ name, readOnly })),
    ).toEqual([
      { name: "catalog_search", readOnly: true },
      { name: "catalog_request", readOnly: false },
    ]);
  });

  it("takes requester identity from the authenticated run", async () => {
    const { connector, search, request } = fixture();
    expect(await execute(connector, "catalog_search", { query: "report", limit: 1 })).toEqual([
      { type: "result", data: page },
    ]);
    expect(search).toHaveBeenCalledWith(
      { spaceId: "space", userId: "user", botId: "bot" },
      { query: "report", limit: 1 },
    );
    expect(await execute(connector, "catalog_request", { fileId: "1" })).toEqual([
      { type: "result", data: packet },
    ]);
    expect(request).toHaveBeenCalledWith({ spaceId: "space", userId: "user", botId: "bot" }, "1");
  });

  it.each([
    ["catalog_search", { query: "report", limit: 26 }],
    ["catalog_search", { query: "report", cursor: "../../" }],
    ["catalog_search", { query: "report", botId: "other" }],
    ["catalog_request", { fileId: "1", destination: "/other" }],
    ["catalog_request", { fileId: "0" }],
    ["unknown", {}],
  ])("rejects invalid %s arguments before invoking the host", async (tool, args) => {
    const { connector, search, request } = fixture();
    expect(await execute(connector, tool, args)).toEqual([
      { type: "error", message: "Catalog operation refused." },
    ]);
    expect(search).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects missing bot identity and cancelled runs", async () => {
    const { connector, search } = fixture();
    expect(
      (
        await execute(
          connector,
          "catalog_search",
          { query: "report" },
          { ...context, botId: undefined },
        )
      )[0]?.type,
    ).toBe("error");
    expect(
      (
        await execute(
          connector,
          "catalog_search",
          { query: "report" },
          { ...context, signal: AbortSignal.abort() },
        )
      )[0]?.type,
    ).toBe("error");
    expect(search).not.toHaveBeenCalled();
  });

  it("scrubs backend exceptions and refuses unexpected host fields", async () => {
    const { connector, search } = fixture();
    search.mockRejectedValueOnce(new Error("private host diagnostic"));
    expect(await execute(connector, "catalog_search", { query: "report" })).toEqual([
      { type: "error", message: "Catalog operation refused." },
    ]);
    search.mockResolvedValueOnce({ ...page, path: "private" } as typeof page);
    expect((await execute(connector, "catalog_search", { query: "report" }))[0]?.type).toBe(
      "error",
    );
  });
});

describe("local catalog host conformance", () => {
  const temporaryRoot = join(process.cwd(), ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, "catalog-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("passes offline courier and search security scenarios", () => {
    expect(() =>
      execFileSync(
        "python3",
        [
          "-B",
          "-m",
          "unittest",
          "discover",
          "-s",
          "packages/adapters/src/catalog",
          "-p",
          "test_*.py",
        ],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("executes real SQLite search and Packet Router submission through the provider", async () => {
    const catalog = join(root, "catalog.db");
    execFileSync("python3", [
      "-B",
      "-c",
      `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,size_bytes INTEGER,sha256 TEXT,hash_status TEXT)")
c.execute("INSERT INTO files VALUES(1,?,4,?,'hashed')",('/synthetic-documents/report.txt','ab'*32))
c.commit()
c.close()
`,
      catalog,
    ]);
    for (const directory of ["parking", "vault", "router/inbox/new", "held", "audit"])
      mkdirSync(join(root, directory), { recursive: true });
    const configPath = join(root, "host-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalog,
        undoLog: join(root, "undo.csv"),
        parkingRoot: join(root, "parking"),
        routerRoot: join(root, "router"),
        heldRoot: join(root, "held"),
        auditLog: join(root, "audit/transactions.jsonl"),
        requestSigningKey: "ab".repeat(32),
        principals: [
          {
            key: "seat",
            spaceId: "space",
            userId: "user",
            botId: "bot",
            role: "seat",
            scope: "entity",
            vaultRoot: join(root, "vault"),
            catalogRoots: ["/synthetic-documents"],
          },
        ],
      }),
    );
    const connector = new FileCatalogConnector(new LocalFileCatalogProvider({ configPath }));
    expect(await execute(connector, "catalog_search", { query: "report" })).toEqual([
      { type: "result", data: page },
    ]);
    const events = await execute(connector, "catalog_request", { fileId: "1" });
    expect(events[0]?.type).toBe("result");
    const files = readdirSync(join(root, "router/inbox/new"));
    expect(files).toHaveLength(1);
    const content = readFileSync(join(root, "router/inbox/new", files[0]!), "utf8");
    expect(content).toContain('role_target: "eleusis"');
    expect(content).not.toContain(root);
    expect(
      await execute(
        connector,
        "catalog_search",
        { query: "report" },
        { ...context, spaceId: "other" },
      ),
    ).toEqual([{ type: "error", message: "Catalog operation refused." }]);
  });
});
