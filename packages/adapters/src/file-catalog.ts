import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  FileCatalogIdentity,
  FileCatalogProvider,
  FileCatalogQuery,
} from "@rakazo/adapter-kit";
import { z } from "zod";

const fileId = z.string().regex(/^[1-9][0-9]{0,14}$/);
const querySchema = z
  .object({
    query: z.string().trim().min(1).max(120),
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,14})$/)
      .optional(),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .strict();
const requestSchema = z.object({ fileId }).strict();
const packetResult = z
  .object({ packetId: z.string().regex(/^pkt-retrieval-[0-9a-f]{32}$/) })
  .strict();
const pageResult = z
  .object({
    files: z
      .array(
        z
          .object({
            id: fileId,
            name: z
              .string()
              .max(160)
              .regex(/^[^/\\]*$/),
            bytes: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(25),
    nextCursor: z
      .string()
      .regex(/^[1-9][0-9]{0,14}$/)
      .optional(),
  })
  .strict();

const tools: ConnectorTool[] = [
  {
    name: "catalog_search",
    description:
      "Search authorized file names. Returns bounded metadata and a continuation cursor.",
    readOnly: true,
    inputSchema: z.toJSONSchema(querySchema),
  },
  {
    name: "catalog_request",
    description: "Submit a file retrieval packet for the courier to hold and verify.",
    readOnly: false,
    inputSchema: z.toJSONSchema(requestSchema),
  },
];

/** Optional connector; the composition root must explicitly install it after activation approval. */
export class FileCatalogConnector implements ConnectorProvider {
  constructor(private readonly provider: FileCatalogProvider) {}

  describe() {
    return {
      id: "file-catalog",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools(_context: AdapterContext): Promise<ConnectorTool[]> {
    return structuredClone(tools);
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (!context.botId || context.signal.aborted) {
      yield { type: "error", message: "Catalog unavailable." };
      return;
    }
    // Identity comes only from the authenticated run, never the tool arguments.
    const identity = { spaceId: context.spaceId, userId: context.userId, botId: context.botId };
    try {
      let data: unknown;
      if (call.tool === "catalog_search") {
        data = pageResult.parse(await this.provider.search(identity, querySchema.parse(call.args)));
      } else if (call.tool === "catalog_request") {
        data = packetResult.parse(
          await this.provider.request(identity, requestSchema.parse(call.args).fileId),
        );
      } else {
        throw new Error("Unknown catalog tool");
      }
      yield { type: "result", data };
    } catch {
      yield { type: "error", message: "Catalog operation refused." };
    }
  }
}

/** Host-only Python stdlib adapter. Config and storage never enter a seat's sandbox. */
export class LocalFileCatalogProvider implements FileCatalogProvider {
  constructor(private readonly options: { configPath: string; python?: string }) {}

  private invoke(
    operation: "search" | "request",
    identity: FileCatalogIdentity,
    args: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.options.python ?? "python3",
        [
          "-B",
          fileURLToPath(new URL("./catalog/host.py", import.meta.url)),
          "--config",
          this.options.configPath,
          operation,
        ],
        {
          timeout: 10_000,
          maxBuffer: 32 * 1024,
          encoding: "utf8",
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout) => {
          if (error) {
            reject(new Error("Catalog operation refused"));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Catalog operation refused"));
          }
        },
      );
      child.stdin?.on("error", () => reject(new Error("Catalog operation refused")));
      child.stdin?.end(JSON.stringify({ identity, args }));
    });
  }

  async search(identity: FileCatalogIdentity, query: FileCatalogQuery) {
    return pageResult.parse(await this.invoke("search", identity, querySchema.parse(query)));
  }

  async request(identity: FileCatalogIdentity, id: string) {
    return packetResult.parse(
      await this.invoke("request", identity, requestSchema.parse({ fileId: id })),
    );
  }
}
