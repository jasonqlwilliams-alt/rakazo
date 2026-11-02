import type { AgentRunRequest, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const DELEGATION = {
  version: 1,
  requestId: "req_request-1",
  parentRequestId: null,
  actor: "owner",
  delegate: "assistant",
  label: "Owner via assistant",
  grantId: "grant-1",
  clientId: "client-1",
  scopes: ["assistant.read", "assistant.message"],
  mayStartWork: false,
  hop: 1,
  verifiedAt: "2026-11-01T12:00:00.000Z",
};

function connectorTool(name: string, readOnly: boolean): ConnectorTool {
  return {
    name,
    description: readOnly ? "Read an item" : "Create an item",
    readOnly,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    route: { connectorId: "demo", resourceId: "resource-1", toolName: name },
  };
}

type Call = { name: string; args: Record<string, unknown> };

/** One run through the real executor, with a scripted model that makes the given tool calls. */
function fixture({
  delegation = DELEGATION as unknown,
  trigger = "bot_message",
  calls = [] as Call[],
  rules = [] as ActionApprovalRule[],
  webhookRoutine = null as {
    active: boolean;
    webhookEnabled: boolean;
    unattendedTools: string[];
  } | null,
  /** Offer the connector tools behind a lazy catalog; `unresolved` leaves its calls unresolved. */
  catalog = undefined as "resolved" | "unresolved" | undefined,
  priorState = false,
} = {}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    leaseFence: 0,
    routineId: webhookRoutine ? "routine-1" : null,
    delegation,
  };
  const effects: Array<{ id: string; kind: string; idempotencyKey: string; status: string }> = [];
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Analyst",
        title: "Analyst",
        description: "Test analyst",
        instructions: "Private bot persona",
        disabledBuiltinTools: [],
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated", homeKey: "home-1" },
      })),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: priorState ? "Private summary" : null,
        historyCompactedUpToSeq: priorState ? 0 : null,
      })),
    },
    message: {
      findMany: vi.fn(async () =>
        priorState
          ? [
              {
                id: "prior-message",
                threadId: run.threadId,
                seq: 1,
                role: "user",
                botId: null,
                runId: "prior-run",
                blocks: [{ kind: "text", text: "Private thread history" }],
                createdAt: new Date("2026-11-01T11:00:00.000Z"),
                replyTo: null,
              },
            ]
          : [],
      ),
      findUnique: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Check RKZ-1" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    routine: { findFirst: vi.fn(async () => webhookRoutine) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    board: { findUnique: vi.fn(async () => null) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Omit<(typeof effects)[number], "id"> }) => {
        const effect = { ...data, id: `effect-${effects.length + 1}` };
        effects.push(effect);
        return { ...effect };
      }),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const results: unknown[] = [];
  const offered: {
    tools: string[];
    instructions: string;
    prompt: string;
    history: AgentRunRequest["history"];
  } = {
    tools: [],
    instructions: "",
    prompt: "",
    history: [],
  };
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id ?? null } };
  });
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    offered.tools = request.tools.map((tool) => tool.name);
    offered.instructions = request.instructions;
    offered.prompt = request.prompt;
    offered.history = request.history;
    for (const [index, call] of calls.entries()) {
      const result = await request.executeTool!(call.name, call.args, `call-${index + 1}`);
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const memoryRead = vi.fn(async () => ({ documents: [] }));
  const recall = vi.fn(async () => ({ ok: true, value: [{ memory: "Private recall" }] }));
  const tools = [connectorTool("demo_get_item", true), connectorTool("demo_create_item", false)];
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        catalog
          ? [
              {
                name: "demo_execute_tool",
                description: "Execute a catalog tool",
                inputSchema: { type: "object" },
                route: { connectorId: "demo", toolName: "__catalog_execute" },
              },
            ]
          : tools,
      resolveCall: async (call: ConnectorCall) =>
        catalog === "resolved" ? resolveCatalogCall(call, catalogEntries(tools)) : undefined,
      execute,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      execute: async function* () {
        yield { type: "exit" as const, code: 0 };
      },
      exportWorkspace: async function* () {},
    },
    home: { commit: vi.fn(async () => "rev-1") },
    memory: { read: memoryRead, commit: vi.fn() },
    memoryProviders: {
      resolve: async () => (priorState ? { provider: { recall }, defaultScope: "isolated" } : null),
    },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    ticketBoardEnabled: priorState,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    prisma,
    effects,
    results,
    offered,
    execute,
    runtimeRun,
    memoryRead,
    recall,
    pauseRunForInput,
    finalizeRun,
    run: () => executor.continueRun(run.id, "worker-1"),
  };
}

const ADMIN_AND_HOST_TOOLS = [
  "shell",
  "update_bot",
  "spawn_bot",
  "request_secret",
  "schedule_create",
];

describe("delegated runs", () => {
  it("offer only the tools the delegation allows and say so in the prompt", async () => {
    const owner = fixture({ delegation: null });
    await owner.run();
    const delegated = fixture();
    await delegated.run();

    for (const name of ADMIN_AND_HOST_TOOLS) expect(owner.offered.tools).toContain(name);
    for (const name of [...ADMIN_AND_HOST_TOOLS, "demo_create_item", "web_fetch", "send_to_bot"]) {
      expect(delegated.offered.tools).not.toContain(name);
    }
    expect(delegated.offered.tools).toEqual(
      expect.arrayContaining(["message_bot", "message_user", "demo_get_item"]),
    );
    expect(delegated.offered.instructions).toContain(
      "delegated request from Owner via assistant (request req_request-1)",
    );
    expect(owner.offered.instructions).not.toContain("delegated request");
  });

  it("run an action inside the granted scopes", async () => {
    const f = fixture({ calls: [{ name: "demo_get_item", args: { id: "item-1" } }] });
    await f.run();
    expect(f.results).toEqual([expect.not.objectContaining({ error: expect.anything() })]);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("keeps owner context out of a delegated run without read access", async () => {
    const noRead = fixture({
      delegation: { ...DELEGATION, scopes: ["assistant.message"] },
      priorState: true,
      trigger: "webhook",
    });
    await noRead.run();
    expect(noRead.offered.prompt).toContain("Check RKZ-1");
    expect(noRead.offered.history).toEqual([]);
    expect(noRead.offered.instructions).not.toContain("Private summary");
    expect(noRead.offered.instructions).not.toContain("Private recall");
    expect(noRead.offered.instructions).not.toContain("Private bot persona");
    expect(noRead.memoryRead).not.toHaveBeenCalled();
    expect(noRead.recall).not.toHaveBeenCalled();
    expect(noRead.prisma.scratchpadItem.findMany).not.toHaveBeenCalled();
    expect(noRead.prisma.board.findUnique).not.toHaveBeenCalled();

    const canRead = fixture({ priorState: true, trigger: "webhook" });
    await canRead.run();
    expect(JSON.stringify(canRead.offered.history)).toContain("Private thread history");
    expect(JSON.stringify(canRead.offered.history)).toContain("Private recall");
    expect(canRead.memoryRead).toHaveBeenCalled();
    expect(canRead.offered.instructions).toContain("Private bot persona");
    expect(canRead.recall).toHaveBeenCalled();
    expect(canRead.prisma.scratchpadItem.findMany).toHaveBeenCalled();
    expect(canRead.prisma.board.findUnique).toHaveBeenCalled();
  });

  it("refuse administration before it runs, whatever the delegation grants", async () => {
    const f = fixture({
      delegation: { ...DELEGATION, mayStartWork: true },
      calls: ADMIN_AND_HOST_TOOLS.map((name) => ({ name, args: { name: "New name" } })),
    });
    await f.run();
    expect(f.results).toHaveLength(ADMIN_AND_HOST_TOOLS.length);
    for (const result of f.results) {
      expect(result).toEqual({ error: expect.stringContaining("is administration") });
    }
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });

  it("refuse an action outside the granted scopes", async () => {
    const f = fixture({
      delegation: { ...DELEGATION, scopes: ["assistant.read"] },
      calls: [
        { name: "demo_create_item", args: { id: "item-1" } },
        { name: "message_bot", args: { bot_id: "bot-2", message: "do it" } },
        { name: "web_fetch", args: { url: "https://example.com" } },
      ],
    });
    await f.run();
    expect(f.results).toEqual([
      { error: expect.stringContaining("not available to delegated requests") },
      { error: expect.stringContaining("needs message access") },
      { error: expect.stringContaining("not available to delegated requests") },
    ]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });

  it("do not gain authority from the receiving bot's own grants", async () => {
    const f = fixture({
      trigger: "webhook",
      webhookRoutine: {
        active: true,
        webhookEnabled: true,
        unattendedTools: ["shell", "demo_create_item"],
      },
      rules: [
        { effect: "always_allow", matchKind: "tool", matchValue: "shell" },
        { effect: "always_allow", matchKind: "tool", matchValue: "demo_create_item" },
      ],
      calls: [
        { name: "shell", args: { command: "true" } },
        { name: "demo_create_item", args: { id: "item-1" } },
      ],
    });
    await f.run();
    expect(f.results).toEqual([
      { error: expect.stringContaining("is administration") },
      { error: expect.stringContaining("not available to delegated requests") },
    ]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("park work the delegation may start for the owner, even where the owner allowed it", async () => {
    const f = fixture({
      trigger: "webhook",
      delegation: { ...DELEGATION, mayStartWork: true },
      webhookRoutine: {
        active: true,
        webhookEnabled: true,
        unattendedTools: ["scratchpad_add"],
      },
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "scratchpad_add" }],
      calls: [{ name: "scratchpad_add", args: { title: "Review result" } }],
    });
    await f.run();
    expect(isApprovalPausedResult(f.results[0])).toBe(true);
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("decide a catalog call on the tool it runs, and refuse one that does not resolve", async () => {
    const catalogCall = (name: string) => ({
      name: "demo_execute_tool",
      args: { id: `resource-1:${name}`, arguments: { id: "item-1" } },
    });
    const resolved = fixture({
      catalog: "resolved",
      calls: [catalogCall("demo_get_item"), catalogCall("demo_create_item")],
    });
    await resolved.run();
    expect(resolved.results[0]).not.toHaveProperty("error");
    expect(resolved.results[1]).toEqual({
      error: expect.stringContaining("not available to delegated requests"),
    });
    expect(resolved.execute).toHaveBeenCalledOnce();

    const unresolved = fixture({ catalog: "unresolved", calls: [catalogCall("demo_get_item")] });
    await unresolved.run();
    expect(unresolved.results).toEqual([{ error: expect.stringContaining("did not resolve") }]);
    expect(unresolved.execute).not.toHaveBeenCalled();
  });

  it("fail before the model starts when the stored delegation is damaged", async () => {
    const f = fixture({ trigger: "webhook", delegation: { requestId: "req_request-1" } });
    await f.run();
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "This delegated request's context is invalid, so it was not run.",
      }),
    );
  });
});
