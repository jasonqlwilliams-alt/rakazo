import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

function fixture({
  trigger,
  events,
}: {
  trigger: "routine" | "user";
  events: AgentRuntimeEvent[];
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    routineId: trigger === "routine" ? "routine-1" : null,
    leaseFence: 0,
  };
  const notify = vi.fn(async () => undefined);
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const publishMessage = vi.fn(async () => ({ message: { id: "message-1" }, eventSeq: 1 }));
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    yield* events;
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: true },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
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
        nextMessageSeq: 0,
        historyCompactedUpToSeq: null,
      })),
    },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "hourly check" })) },
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
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect: { findMany: vi.fn(async () => []) },
    $transaction: publishMessage,
  } as unknown as PrismaClient;
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      finalizeRun,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: notify },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    runtimeRun,
    finalizeRun,
    publishMessage,
    notify,
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("routine silent finish", () => {
  it("posts nothing and sends no push when a routine run ends without text", async () => {
    const f = fixture({ trigger: "routine", events: [{ type: "done" }] });
    await f.run();
    expect(f.runtimeRun.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ allowSilentEmpty: true, allowSilentToolFinish: true }),
    );
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [],
        markUnread: false,
      }),
    );
    expect(f.publishMessage).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("does not post narration when a tool-using routine run ends without a final answer", async () => {
    const f = fixture({
      trigger: "routine",
      events: [
        { type: "text", text: "Checking the human-gated list." },
        { type: "tool", name: "list_items", args: {}, executionId: "exec-1" },
        { type: "done" },
      ],
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", markUnread: false }),
    );
    const [{ blocks }] = f.finalizeRun.mock.calls[0] as unknown as [{ blocks: MessageBlock[] }];
    expect(blocks.filter((block) => block.kind === "text")).toEqual([]);
    expect(f.publishMessage).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("posts only the final answer when a routine run narrates before a tool", async () => {
    const f = fixture({
      trigger: "routine",
      events: [
        { type: "text", text: "Checking the human-gated list." },
        { type: "tool", name: "list_items", args: {}, executionId: "exec-1" },
        { type: "text", text: "Two items need you." },
        { type: "done", text: "Checking the human-gated list.Two items need you." },
      ],
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", markUnread: true }),
    );
    const [{ blocks }] = f.finalizeRun.mock.calls[0] as unknown as [{ blocks: MessageBlock[] }];
    expect(blocks.filter((block) => block.kind === "text")).toEqual([
      { kind: "text", text: "Two items need you." },
    ]);
    expect(f.publishMessage).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "completion", body: "Two items need you." }),
      expect.anything(),
    );
  });

  it("still posts narration as its own message in a chat run", async () => {
    const f = fixture({
      trigger: "user",
      events: [
        { type: "text", text: "Checking the human-gated list." },
        { type: "tool", name: "list_items", args: {}, executionId: "exec-1" },
        { type: "text", text: "Two items need you." },
        { type: "done", text: "Checking the human-gated list.Two items need you." },
      ],
    });
    await f.run();
    expect(f.publishMessage).toHaveBeenCalledTimes(1);
    const [{ blocks }] = f.finalizeRun.mock.calls[0] as unknown as [{ blocks: MessageBlock[] }];
    expect(blocks.filter((block) => block.kind === "text")).toEqual([
      { kind: "text", text: "Two items need you." },
    ]);
  });

  it("posts and notifies when a routine run produces text", async () => {
    const f = fixture({
      trigger: "routine",
      events: [
        { type: "text", text: "Daily report ready" },
        { type: "done", text: "Daily report ready" },
      ],
    });
    await f.run();
    expect(f.runtimeRun.mock.calls[0]![0].allowSilentEmpty).toBe(true);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "Daily report ready" }],
        markUnread: true,
      }),
    );
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "completion",
        title: "Assistant finished",
        body: "Daily report ready",
      }),
      expect.anything(),
    );
  });

  it("keeps the empty-run fallback for a chat run that ends without text", async () => {
    const f = fixture({ trigger: "user", events: [{ type: "done" }] });
    await f.run();
    expect(f.runtimeRun.mock.calls[0]![0].allowSilentEmpty).toBeFalsy();
    expect(f.runtimeRun.mock.calls[0]![0].allowSilentToolFinish).toBeFalsy();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "done." }],
        markUnread: true,
      }),
    );
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "completion",
        title: "Assistant finished",
        body: "done.",
      }),
      expect.anything(),
    );
  });
});
