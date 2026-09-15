import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { ROUTINE_HIDDEN_NARRATION_NOTE } from "./user-progress.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const steeringQuestion = {
  id: "steering-1",
  messageId: "message-user-1",
  text: "What is the status of X?",
  blocks: [{ kind: "text", text: "What is the status of X?" }] as MessageBlock[],
};

function answered(block: MessageBlock, answer: string): MessageBlock {
  return { ...block, status: "answered", answer } as MessageBlock;
}

function fixture({
  trigger,
  events,
  steering = [],
  priorBotMessages = [],
}: {
  trigger: "routine" | "user";
  events: AgentRuntimeEvent[];
  steering?: (typeof steeringQuestion)[];
  priorBotMessages?: MessageBlock[][];
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
  const thread = { unread: false };
  const postedMessages: MessageBlock[][] = [];
  const notify = vi.fn(async () => undefined);
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    await request.claimSteering?.([]);
    yield* events;
  });
  const tx = {
    thread: {
      update: vi.fn(async ({ data }: { data: { unread?: boolean } }) => {
        if (data.unread) thread.unread = true;
        return { nextMessageSeq: postedMessages.length + 1, nextEventSeq: 1 };
      }),
    },
    run: { findUnique: vi.fn(async () => run) },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        postedMessages.push(data.blocks);
        return { id: `message-bot-${postedMessages.length}` };
      }),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
  };
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
    message: {
      findMany: vi.fn(async ({ where }: { where: { runId?: string; role?: string } }) =>
        where.runId === run.id && where.role === "bot"
          ? priorBotMessages.map((blocks) => ({ blocks, clientNonce: null }))
          : [],
      ),
      findFirst: vi.fn(async () => null),
    },
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
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
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
      claimSteering: vi.fn(async () => steering),
      finalizeRun,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: notify },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    runtimeRun,
    finalizeRun,
    postedMessages,
    thread,
    notify,
    request: () => runtimeRun.mock.calls[0]![0],
    finalBlocks: () =>
      (finalizeRun.mock.calls[0] as unknown as [{ blocks: MessageBlock[] }])[0].blocks,
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

const textBlocks = (blocks: MessageBlock[]) => blocks.filter((block) => block.kind === "text");

describe("routine silent finish", () => {
  it("posts nothing and sends no push when a routine run ends without text", async () => {
    const f = fixture({ trigger: "routine", events: [{ type: "done" }] });
    await f.run();
    expect(f.request().allowSilentFinish?.()).toBe(true);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [],
        markUnread: false,
      }),
    );
    expect(f.postedMessages).toEqual([]);
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
    expect(textBlocks(f.finalBlocks())).toEqual([]);
    expect(f.postedMessages).toEqual([]);
    expect(f.thread.unread).toBe(false);
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
    expect(textBlocks(f.finalBlocks())).toEqual([{ kind: "text", text: "Two items need you." }]);
    expect(f.postedMessages).toEqual([]);
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "completion", body: "Two items need you." }),
      expect.anything(),
    );
  });

  it("posts the reply and marks unread once a routine run claims a user message", async () => {
    const f = fixture({
      trigger: "routine",
      steering: [steeringQuestion],
      events: [
        { type: "text", text: "X shipped yesterday." },
        { type: "tool", name: "list_items", args: {}, executionId: "exec-1" },
        { type: "done" },
      ],
    });
    await f.run();
    expect(f.request().allowSilentFinish?.()).toBe(false);
    expect(f.postedMessages).toEqual([[{ kind: "text", text: "X shipped yesterday." }]]);
    expect(f.thread.unread).toBe(true);
  });

  it("does not mark unread or push when a routine run writes only whitespace", async () => {
    const f = fixture({
      trigger: "routine",
      events: [
        { type: "text", text: "\n\n" },
        { type: "tool", name: "list_items", args: {}, executionId: "exec-1" },
        { type: "text", text: "\n" },
        { type: "done" },
      ],
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", markUnread: false }),
    );
    expect(textBlocks(f.finalBlocks())).toEqual([]);
    expect(f.postedMessages).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("tells the model that text next to a tool call is hidden only while silence is on", async () => {
    const silent = fixture({ trigger: "routine", events: [{ type: "done" }] });
    await silent.run();
    expect(silent.request().instructions).toContain(ROUTINE_HIDDEN_NARRATION_NOTE);

    const answeredRoutine = fixture({
      trigger: "routine",
      priorBotMessages: [
        [answered({ kind: "ask", text: "Merge #12 now?", status: "pending" }, "yes")],
      ],
      events: [{ type: "done" }],
    });
    await answeredRoutine.run();
    expect(answeredRoutine.request().instructions).not.toContain(ROUTINE_HIDDEN_NARRATION_NOTE);

    const chat = fixture({ trigger: "user", events: [{ type: "done" }] });
    await chat.run();
    expect(chat.request().instructions).not.toContain(ROUTINE_HIDDEN_NARRATION_NOTE);
  });

  it("posts the reply once a routine run resumes from an answered question", async () => {
    const f = fixture({
      trigger: "routine",
      priorBotMessages: [
        [
          answered(
            {
              kind: "ask",
              text: "Merge #12 now?",
              status: "pending",
              actions: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
            "yes",
          ),
        ],
      ],
      events: [
        { type: "text", text: "Merging #12." },
        { type: "tool", name: "merge_pull_request", args: {}, executionId: "exec-1" },
        { type: "done" },
      ],
    });
    await f.run();
    expect(f.request().allowSilentFinish?.()).toBe(false);
    expect(f.postedMessages).toEqual([[{ kind: "text", text: "Merging #12." }]]);
    expect(f.thread.unread).toBe(true);
  });

  it("posts the reply once a routine run resumes from an approval", async () => {
    const f = fixture({
      trigger: "routine",
      priorBotMessages: [
        [
          answered(
            buildApprovalAskBlock("effect-1", "merge_pull_request", { number: 12 }, []),
            "allow",
          ),
        ],
      ],
      events: [
        { type: "text", text: "Merging #12." },
        { type: "tool", name: "merge_pull_request", args: { number: 12 }, executionId: "exec-1" },
        { type: "done" },
      ],
    });
    await f.run();
    expect(f.request().allowSilentFinish?.()).toBe(false);
    expect(f.postedMessages).toEqual([[{ kind: "text", text: "Merging #12." }]]);
    expect(f.thread.unread).toBe(true);
  });

  it("keeps the empty-run fallback after an approval resume that writes nothing", async () => {
    const f = fixture({
      trigger: "routine",
      priorBotMessages: [
        [
          answered(
            buildApprovalAskBlock("effect-1", "merge_pull_request", { number: 12 }, []),
            "allow",
          ),
        ],
      ],
      events: [{ type: "done" }],
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "done." }],
        markUnread: true,
      }),
    );
  });

  it("stays silent when a routine run only has an unanswered question from before", async () => {
    const f = fixture({
      trigger: "routine",
      priorBotMessages: [
        [buildApprovalAskBlock("effect-1", "merge_pull_request", { number: 12 }, [])],
      ],
      events: [{ type: "done" }],
    });
    await f.run();
    expect(f.request().allowSilentFinish?.()).toBe(true);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], markUnread: false }),
    );
  });

  it("keeps the empty-run fallback once a routine run claims a user message", async () => {
    const f = fixture({
      trigger: "routine",
      steering: [steeringQuestion],
      events: [{ type: "done" }],
    });
    await f.run();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "done." }],
        markUnread: true,
      }),
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
    expect(f.postedMessages).toEqual([[{ kind: "text", text: "Checking the human-gated list." }]]);
    expect(f.thread.unread).toBe(true);
    expect(textBlocks(f.finalBlocks())).toEqual([{ kind: "text", text: "Two items need you." }]);
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
    expect(f.request().allowSilentEmpty).toBeFalsy();
    expect(f.request().allowSilentFinish?.()).toBe(false);
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
