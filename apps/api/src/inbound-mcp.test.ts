import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { InboundMcpDeps } from "./inbound-mcp.js";
import { loadEnv } from "./env.js";
import {
  INBOUND_MCP_PATH,
  INBOUND_MCP_TOOL_NAMES,
  inboundMcpRedactionSecrets,
  mountInboundMcpRoutes,
  scrubInboundMcpText,
} from "./inbound-mcp.js";

const TOKEN = "inbound-mcp-token-value-32chars-aa";
const WEBHOOK_TOKEN = "webhook-test-secret-value-32chars!!";
const PERSONA = "SECRET_PERSONA_PROMPT";
const SECRET = "super-secret-credential-value";

function ownerPrisma(
  overrides: {
    bots?: unknown[];
    bot?: unknown;
    thread?: unknown;
    messages?: Array<{
      id: string;
      threadId: string;
      seq: number;
      role: string;
      blocks: unknown;
      botId?: string | null;
      replyToMessageId?: string | null;
      runId?: string | null;
      createdAt: Date;
    }>;
  } = {},
) {
  return {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "owner" })),
    },
    spaceMember: {
      findFirst: vi.fn(async () => ({
        userId: "owner",
        spaceId: "space-1",
        member: { user: { email: "owner@example.test" } },
      })),
    },
    bot: {
      findMany: vi.fn(async () => overrides.bots ?? []),
      findFirst: vi.fn(async () => overrides.bot ?? null),
    },
    thread: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; externalConversationId: null } }) => {
          if (where.externalConversationId !== null) return null;
          if (overrides.thread && (overrides.thread as { id: string }).id === where.id) {
            return overrides.thread;
          }
          return null;
        },
      ),
    },
    message: {
      findMany: vi.fn(async () => overrides.messages ?? []),
    },
    run: {
      findMany: vi.fn(async () => []),
    },
  };
}

function mount(
  prisma:
    | ReturnType<typeof ownerPrisma>
    | { deploymentSettings: { findUnique: () => Promise<unknown> } },
  token: string | undefined | false = TOKEN,
) {
  const app = new Hono();
  mountInboundMcpRoutes(app, {
    token: token === false ? undefined : token,
    prisma: prisma as unknown as InboundMcpDeps["prisma"],
    health: () => ({ ok: true, runtime: "pi", sandbox: "docker", revision: "abc1234" }),
    redact: [TOKEN, SECRET],
  });
  return { app, findUnique: prisma.deploymentSettings.findUnique };
}

async function rpc(
  app: Hono,
  method: string,
  params?: unknown,
  authorization: string | null = `Bearer ${TOKEN}`,
  extra: { id?: string | number | null; headers?: Record<string, string> } = {},
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (extra.id !== undefined) body.id = extra.id;
  else if (!method.startsWith("notifications/")) body.id = 1;
  if (params !== undefined) body.params = params;
  return app.request(INBOUND_MCP_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
      ...extra.headers,
    },
    body: JSON.stringify(body),
  });
}

function toolText(body: { result?: { content?: Array<{ text?: string }>; isError?: boolean } }) {
  return body.result?.content?.[0]?.text ?? "";
}

describe("inbound MCP auth", () => {
  it("refuses missing, wrong, and webhook bearers, and stays closed when unset", async () => {
    const enabled = mount(ownerPrisma());
    for (const authorization of [
      null,
      "",
      "Bearer",
      `Bearer ${WEBHOOK_TOKEN}`,
      `Bearer ${TOKEN}x`,
      TOKEN,
    ]) {
      const response = await rpc(
        enabled.app,
        "initialize",
        { protocolVersion: "2025-03-26" },
        authorization,
      );
      expect(response.status).toBe(401);
    }
    expect(enabled.findUnique).not.toHaveBeenCalled();

    const disabled = mount(ownerPrisma(), false);
    const response = await rpc(disabled.app, "tools/list");
    expect(response.status).toBe(401);
    expect(disabled.findUnique).not.toHaveBeenCalled();
  });

  it("does not advertise GET or DELETE after a valid bearer", async () => {
    const { app, findUnique } = mount(ownerPrisma());
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(INBOUND_MCP_PATH, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(405);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("inbound MCP read-only scope", () => {
  it("lists only the read-only tools and rejects write names", async () => {
    const { app } = mount(ownerPrisma());
    const listed = await rpc(app, "tools/list");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      result: {
        tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([...INBOUND_MCP_TOOL_NAMES]);
    expect(body.result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    for (const name of ["send_message", "create_run", "add_mcp_server", "webhook"]) {
      const call = await rpc(app, "tools/call", { name, arguments: {} });
      const payload = (await call.json()) as { result: { isError?: boolean } };
      expect(payload.result.isError).toBe(true);
      expect(toolText(payload)).toBe("Unknown tool");
    }
  });

  it("lists seats with description and never instructions, email, or SMS threads", async () => {
    const prisma = ownerPrisma({
      bots: [
        {
          id: "bot-1",
          name: "Triage",
          title: "Inbox",
          description: "Sort the queue",
          instructions: PERSONA,
          updatedAt: new Date("2026-09-19T00:00:00.000Z"),
          thread: { id: "thread-bot" },
        },
      ],
      bot: {
        id: "bot-1",
        name: "Triage",
        thread: {
          id: "thread-sms",
          createdAt: new Date("2026-09-19T00:00:00.000Z"),
          externalConversationId: "sms-1",
        },
        groupMembers: [
          {
            group: {
              name: "Room",
              thread: {
                id: "thread-group",
                createdAt: new Date("2026-09-19T00:00:01.000Z"),
                externalConversationId: null,
              },
            },
          },
        ],
      },
    });
    const { app } = mount(prisma);
    const bots = await rpc(app, "tools/call", { name: "list_bots", arguments: {} });
    const botsPayload = JSON.parse(toolText((await bots.json()) as never)) as {
      bots: Array<Record<string, unknown>>;
    };
    expect(botsPayload.bots).toEqual([
      {
        id: "bot-1",
        name: "Triage",
        title: "Inbox",
        description: "Sort the queue",
        threadId: "thread-bot",
        updatedAt: "2026-09-19T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(botsPayload)).not.toContain(PERSONA);
    expect(JSON.stringify(botsPayload)).not.toContain("owner@example.test");
    expect(JSON.stringify(botsPayload)).not.toContain("instructions");

    const threads = await rpc(app, "tools/call", {
      name: "list_threads",
      arguments: { botId: "bot-1" },
    });
    const threadsPayload = JSON.parse(toolText((await threads.json()) as never)) as {
      threads: Array<{ id: string; kind: string }>;
    };
    expect(threadsPayload.threads.map((thread) => thread.id)).toEqual(["thread-group"]);
  });

  it("reads a bounded text page and scrubs secrets, people, and SMS data", async () => {
    const prisma = ownerPrisma({
      thread: { id: "thread-bot" },
      messages: [
        {
          id: "msg-2",
          threadId: "thread-bot",
          seq: 2,
          role: "bot",
          blocks: [
            { kind: "text", text: `call +15550000002 with ${SECRET}` },
            { kind: "ask", text: "Need a key", answer: SECRET, input: "secret" },
          ],
          runId: null,
          createdAt: new Date("2026-09-19T00:00:02.000Z"),
        },
        {
          id: "msg-1",
          threadId: "thread-bot",
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "Ping owner@example.test at +15550001111" }],
          runId: null,
          createdAt: new Date("2026-09-19T00:00:01.000Z"),
        },
      ],
    });
    const { app } = mount(prisma);

    const missing = await rpc(app, "tools/call", {
      name: "read_thread",
      arguments: { threadId: "thread-sms" },
    });
    expect(toolText((await missing.json()) as never)).toBe("Thread not found");

    const oversized = await rpc(app, "tools/call", {
      name: "read_thread",
      arguments: { threadId: "thread-bot", limit: 51 },
    });
    expect(toolText((await oversized.json()) as never)).toMatch(/limit/);

    const page = await rpc(app, "tools/call", {
      name: "read_thread",
      arguments: { threadId: "thread-bot", limit: 2 },
    });
    const payload = JSON.parse(toolText((await page.json()) as never)) as {
      messages: Array<{ text: string; seq: number }>;
    };
    expect(payload.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(payload.messages[0]?.text).toBe("Ping [redacted] at [redacted]");
    expect(payload.messages[1]?.text).toBe("call [redacted] with [redacted]");
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain("owner@example.test");
    expect(JSON.stringify(payload)).not.toContain("+15550001111");
    expect(JSON.stringify(payload)).not.toContain("Need a key");
  });

  it("returns health without opening bots or threads", async () => {
    const { app, findUnique } = mount(ownerPrisma());
    const response = await rpc(app, "tools/call", { name: "health", arguments: {} });
    expect(JSON.parse(toolText((await response.json()) as never))).toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc1234",
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("inbound MCP scrubbing", () => {
  it("redacts emails, E.164 numbers, and known secrets", () => {
    expect(scrubInboundMcpText(`token ${SECRET} mail a@b.co +15551234567`, [SECRET])).toBe(
      "token [redacted] mail [redacted] [redacted]",
    );
  });

  it("scrubs deployment, messaging, and outbound MCP secrets from env", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://rakazo:db-pass-aaaa@127.0.0.1:5433/rakazo",
      REALTIME_DATABASE_URL: "postgres://rakazo:rt-pass-bbbb@127.0.0.1:5433/rakazo_rt",
      NODE_ENV: "test",
      OPENROUTER_API_KEY: "sk-or-v1-deployment-model-key-aaaa",
      WHATSAPP_VERIFY_TOKEN: "whatsapp-verify-token-value-aaaa",
      LARK_VERIFICATION_TOKEN: "lark-verification-token-value-aaaa",
      SENDBLUE_PHONE_NUMBER: "sendblue-phone-not-e164-aaaa",
      RAKAZO_MCP_TOKEN: "outbound-mcp-token-value-32chars",
      RAKAZO_INBOUND_MCP_TOKEN: "inbound-mcp-token-value-32chars-aa",
    });
    const text = [
      env.deploymentModelKey,
      env.whatsappVerifyToken,
      env.larkVerificationToken,
      env.sendbluePhoneNumber,
      env.mcpToken,
      env.databaseUrl,
      env.realtimeDatabaseUrl,
    ].join(" ");
    expect(text).toContain("sk-or-v1-deployment-model-key-aaaa");
    expect(text).toContain("db-pass-aaaa");
    expect(text).toContain("rt-pass-bbbb");
    expect(scrubInboundMcpText(text, inboundMcpRedactionSecrets(env))).toBe(
      "[redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]",
    );
  });
});
