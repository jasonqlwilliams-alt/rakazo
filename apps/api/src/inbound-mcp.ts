import type { Actor, MessageBlock } from "@rakazo/contracts";
import { hasValidBearerToken, redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { requireMembership } from "@rakazo/db";
import type { Context, Hono } from "hono";
import type { AppEnv } from "./env.js";
import { loadMessagePage } from "./thread-message-pages.js";

export const INBOUND_MCP_PATH = "/mcp";
export const INBOUND_MCP_MESSAGE_PAGE_SIZE = 50;
export const INBOUND_MCP_TOOL_NAMES = [
  "health",
  "list_bots",
  "list_threads",
  "read_thread",
] as const;

const PROTOCOL_VERSIONS = new Set(["2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const E164_PATTERN = /\+\d{7,15}/g;
const US_PHONE_PATTERN = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const DROP_KEYS = new Set([
  "answer",
  "apiKey",
  "authorization",
  "ciphertext",
  "email",
  "fromNumber",
  "instructions",
  "participantNames",
  "phone",
  "phoneNumber",
  "secret",
  "senderId",
  "senderName",
  "token",
  "toNumber",
  "webhookConfigured",
  "webhookSecretId",
]);

type JsonRpcId = string | number | null;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type InboundMcpHealth = {
  ok: true;
  runtime: string;
  sandbox: string;
  revision: string | null;
};

export type InboundMcpDeps = {
  token?: string;
  prisma: PrismaClient;
  health: () => InboundMcpHealth;
  redact?: string[];
};

const TOOLS = [
  {
    name: "health",
    description: "API health.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations(),
  },
  {
    name: "list_bots",
    description: "List seats with description, not instructions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations(),
  },
  {
    name: "list_threads",
    description: "List threads for a seat.",
    inputSchema: {
      type: "object",
      properties: { botId: { type: "string" } },
      required: ["botId"],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations(),
  },
  {
    name: "read_thread",
    description: "Read a bounded page of thread messages.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        before: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: INBOUND_MCP_MESSAGE_PAGE_SIZE },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations(),
  },
];

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

export function inboundMcpRedactionSecrets(env: AppEnv): string[] {
  return uniqueNonempty([
    env.inboundMcpToken,
    env.mcpToken,
    env.authSecret,
    env.encryptionKey,
    env.deploymentModelKey,
    env.sandboxSupervisorToken,
    env.screenProxySecret,
    env.desktopStackToken,
    env.updaterToken,
    env.composioApiKey,
    env.cursorApiKey,
    env.e2bApiKey,
    env.daytonaApiKey,
    env.boxApiKey,
    env.pipedreamClientId,
    env.pipedreamClientSecret,
    env.sendblueApiKeyId,
    env.sendblueApiSecret,
    env.sendblueSigningSecret,
    env.sendbluePhoneNumber,
    env.smtpUrl,
    env.slackBotToken,
    env.slackSigningSecret,
    env.discordBotToken,
    env.whatsappAccessToken,
    env.whatsappAppSecret,
    env.whatsappVerifyToken,
    env.telegramBotToken,
    env.telegramWebhookSecret,
    env.larkAppSecret,
    env.larkVerificationToken,
    env.larkEncryptKey,
  ]);
}

export function scrubInboundMcpValue(value: unknown, secrets: string[]): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return scrubInboundMcpText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => scrubInboundMcpValue(entry, secrets));
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return null;
  const result: { [key: string]: JsonValue } = {};
  for (const [key, nested] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    result[key] = scrubInboundMcpValue(nested, secrets);
  }
  return result;
}

export function scrubInboundMcpText(value: string, secrets: string[]): string {
  return redactSecrets(value, secrets)
    .replace(EMAIL_PATTERN, "[redacted]")
    .replace(E164_PATTERN, "[redacted]")
    .replace(US_PHONE_PATTERN, "[redacted]");
}

export function mountInboundMcpRoutes(app: Hono, deps: InboundMcpDeps) {
  app.on(["GET", "POST", "DELETE"], INBOUND_MCP_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!deps.token || !hasValidBearerToken(c.req.header("authorization"), deps.token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (c.req.method !== "POST") {
      c.header("allow", "POST");
      return c.json({ error: "Method not allowed" }, 405);
    }

    let parsed: unknown;
    try {
      const raw = await c.req.text();
      parsed = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }

    const protocol = c.req.header("mcp-protocol-version") ?? DEFAULT_PROTOCOL_VERSION;
    c.header(
      "mcp-protocol-version",
      PROTOCOL_VERSIONS.has(protocol) ? protocol : DEFAULT_PROTOCOL_VERSION,
    );

    if (Array.isArray(parsed)) {
      const responses = [];
      for (const entry of parsed) {
        const response = await handleRpc(entry, deps);
        if (response) responses.push(response);
      }
      if (responses.length === 0) return c.body(null, 202);
      return respondRpc(c, responses);
    }

    const response = await handleRpc(parsed, deps);
    if (!response) return c.body(null, 202);
    return respondRpc(c, response);
  });
}

function respondRpc(c: Context, body: unknown) {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    return c.body(`event: message\ndata: ${JSON.stringify(body)}\n\n`, 200, {
      "content-type": "text/event-stream",
    });
  }
  return c.json(body);
}

async function handleRpc(message: unknown, deps: InboundMcpDeps) {
  if (!isJsonRpcRequest(message)) {
    return rpcError(null, -32600, "Invalid request");
  }
  if (!("id" in message)) {
    if (
      message.method === "notifications/initialized" ||
      message.method.startsWith("notifications/")
    ) {
      return null;
    }
    return null;
  }
  const id: JsonRpcId = message.id ?? null;
  try {
    switch (message.method) {
      case "initialize":
        return rpcResult(id, initializeResult(message.params));
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return rpcResult(id, await callTool(message.params, deps));
      default:
        return rpcError(id, -32601, "Method not found");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Internal error";
    return rpcError(id, -32603, detail);
  }
}

function initializeResult(params: unknown) {
  const requested =
    params && typeof params === "object" && "protocolVersion" in params
      ? String((params as { protocolVersion?: unknown }).protocolVersion ?? "")
      : "";
  return {
    protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "rakazo-readonly", version: "0.1.0" },
  };
}

async function callTool(params: unknown, deps: InboundMcpDeps) {
  const name =
    params && typeof params === "object" && "name" in params
      ? String((params as { name?: unknown }).name ?? "")
      : "";
  const args =
    params && typeof params === "object" && "arguments" in params
      ? ((params as { arguments?: unknown }).arguments ?? {})
      : {};
  if (!isObject(args)) return toolError("Invalid arguments");

  try {
    switch (name) {
      case "health":
        return toolResult(deps.health(), deps.redact);
      case "list_bots":
        return toolResult(await listBots(deps), deps.redact);
      case "list_threads":
        return toolResult(await listThreads(deps, String(args.botId ?? "")), deps.redact);
      case "read_thread":
        return toolResult(
          await readThread(deps, String(args.threadId ?? ""), args.before, args.limit),
          deps.redact,
        );
      default:
        return toolError("Unknown tool");
    }
  } catch (error) {
    if (error instanceof InboundMcpToolError) return toolError(error.message);
    throw error;
  }
}

async function listBots(deps: InboundMcpDeps) {
  const actor = await deploymentOwnerActor(deps.prisma);
  if (!actor) return { bots: [] };
  const bots = await deps.prisma.bot.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      description: true,
      updatedAt: true,
      thread: { select: { id: true } },
    },
    orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return {
    bots: bots.flatMap((bot) =>
      bot.thread
        ? [
            {
              id: bot.id,
              name: bot.name,
              title: bot.title,
              description: bot.description,
              threadId: bot.thread.id,
              updatedAt: bot.updatedAt.toISOString(),
            },
          ]
        : [],
    ),
  };
}

async function listThreads(deps: InboundMcpDeps, botId: string) {
  if (!botId) throw new InboundMcpToolError("botId is required");
  const actor = await deploymentOwnerActor(deps.prisma);
  if (!actor) return { threads: [] };
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: {
      id: true,
      name: true,
      thread: { select: { id: true, createdAt: true, externalConversationId: true } },
      groupMembers: {
        where: { group: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null } },
        select: {
          group: {
            select: {
              name: true,
              thread: { select: { id: true, createdAt: true, externalConversationId: true } },
            },
          },
        },
      },
    },
  });
  if (!bot) throw new InboundMcpToolError("Bot not found");
  const threads: Array<{ id: string; kind: "bot" | "group"; name: string; createdAt: string }> = [];
  if (bot.thread && !bot.thread.externalConversationId) {
    threads.push({
      id: bot.thread.id,
      kind: "bot",
      name: bot.name,
      createdAt: bot.thread.createdAt.toISOString(),
    });
  }
  for (const member of bot.groupMembers) {
    const thread = member.group.thread;
    if (!thread || thread.externalConversationId) continue;
    threads.push({
      id: thread.id,
      kind: "group",
      name: member.group.name,
      createdAt: thread.createdAt.toISOString(),
    });
  }
  return { threads };
}

async function readThread(deps: InboundMcpDeps, threadId: string, before: unknown, limit: unknown) {
  if (!threadId) throw new InboundMcpToolError("threadId is required");
  const actor = await deploymentOwnerActor(deps.prisma);
  if (!actor) throw new InboundMcpToolError("Thread not found");
  const pageSize = parsePageSize(limit);
  if (pageSize === undefined)
    throw new InboundMcpToolError("limit must be an integer from 1 to 50");
  const beforeSeq = parseBefore(before);
  if (beforeSeq === undefined && before !== undefined) {
    throw new InboundMcpToolError("before must be a non-negative integer");
  }
  const thread = await deps.prisma.thread.findFirst({
    where: {
      id: threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      externalConversationId: null,
    },
    select: { id: true },
  });
  if (!thread) throw new InboundMcpToolError("Thread not found");
  const page = await loadMessagePage(deps.prisma, thread.id, beforeSeq, pageSize);
  return {
    threadId: page.threadId,
    olderCursor: page.olderCursor,
    messages: page.messages.map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      createdAt: message.createdAt,
      text: readableMessageText(message.blocks),
    })),
  };
}

function readableMessageText(blocks: MessageBlock[]): string {
  return blocks
    .flatMap((block) => {
      if ((block.kind === "text" || block.kind === "meta") && block.text) return [block.text];
      return [];
    })
    .join("\n");
}

function parsePageSize(limit: unknown): number | undefined {
  if (limit === undefined) return INBOUND_MCP_MESSAGE_PAGE_SIZE;
  if (typeof limit !== "number" || !Number.isInteger(limit)) return undefined;
  if (limit < 1 || limit > INBOUND_MCP_MESSAGE_PAGE_SIZE) return undefined;
  return limit;
}

function parseBefore(before: unknown): number | undefined {
  if (before === undefined) return undefined;
  if (typeof before !== "number" || !Number.isInteger(before) || before < 0) return undefined;
  return before;
}

async function deploymentOwnerActor(prisma: PrismaClient): Promise<Actor | null> {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!settings?.ownerUserId) return null;
  try {
    const actor = await requireMembership(prisma, settings.ownerUserId);
    return actor.isDeploymentOwner ? actor : null;
  } catch {
    return null;
  }
}

class InboundMcpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundMcpToolError";
  }
}

function toolResult(payload: unknown, secrets: string[] | undefined) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(scrubInboundMcpValue(payload, secrets ?? [])),
      },
    ],
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function isJsonRpcRequest(
  value: unknown,
): value is { jsonrpc: "2.0"; method: string; id?: JsonRpcId; params?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueNonempty(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ];
}
