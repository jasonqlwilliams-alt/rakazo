import { PermanentSetupError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import { ComputerBusyError } from "./computer-lifecycle.js";
import { createRunExecutor, MAX_SETUP_FAILURES, setupRetryDelay } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";

const provision = vi.hoisted(() => vi.fn());
const acquire = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: acquire,
  provisionComputer: provision,
}));

function fixture() {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    leaseOwner: null as string | null,
    leaseExpiresAt: null as Date | null,
    setupFailureCount: 0,
    setupRetryAt: null as Date | null,
    checkpoint: null,
    updatedAt: new Date(),
    error: null as string | null,
    completedAt: null as Date | null,
  };
  const task = { id: run.taskId, prompt: "Review the sample function", status: "queued" };
  const messages = [
    { id: "prompt-1", role: "user", blocks: [{ kind: "text", text: task.prompt }], seq: 1 },
  ];
  const attempts: Array<Record<string, unknown>> = [];
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({ ...run })),
      findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { trigger?: unknown; status?: unknown; AND?: Array<{ OR?: unknown }> };
        }) => {
          // Auxiliary outcome/stuck scans are empty. Assert the real due-run predicate.
          if (where.trigger || where.status || !where.AND?.[0]?.OR) return [];
          expect(where.AND[0].OR).toEqual(
            expect.arrayContaining([
              {
                status: "queued",
                OR: [{ setupRetryAt: null }, { setupRetryAt: { lte: expect.any(Date) } }],
              },
            ]),
          );
          return run.status === "queued" &&
            (!run.setupRetryAt || run.setupRetryAt.getTime() <= Date.now())
            ? [{ id: run.id, updatedAt: run.updatedAt }]
            : [];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (typeof where.status === "string" && where.status !== run.status) return { count: 0 };
          if (where.leaseOwner && where.leaseOwner !== run.leaseOwner) return { count: 0 };
          if (typeof where.leaseFence === "number" && where.leaseFence !== run.leaseFence)
            return { count: 0 };
          if (where.checkpoint && !run.checkpoint) return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Reviewer",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "team", homeKey: "team-example" },
      })),
    },
    attempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const attempt = { ...data, id: `attempt-${attempts.length + 1}` };
        attempts.push(attempt);
        return attempt;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(attempts.find((attempt) => attempt.id === where.id)!, data);
        },
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => structuredClone(messages)) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ ...task })) },
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
    scratchpadItem: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  };
  const runtimeRun = vi.fn();
  const enqueue = vi.fn(async () => undefined);
  const finalizeRun = vi.fn(
    async (input: { leaseOwner: string; leaseFence: number; error: string; attemptId?: string }) => {
      if (
        (run.status !== "running" && (input.attemptId || run.status !== "leased")) ||
        run.leaseOwner !== input.leaseOwner ||
        run.leaseFence !== input.leaseFence
      )
        return null;
      Object.assign(run, { status: "failed", completedAt: new Date(), error: input.error });
      task.status = "failed";
      if (input.attemptId) {
        Object.assign(attempts.find((attempt) => attempt.id === input.attemptId)!, {
          status: "failed",
          error: input.error,
        });
      }
      return { continuationRunId: null };
    },
  );
  const deps = {
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    memory: { read: vi.fn(async () => ({ documents: [] })) },
    memoryProviders: { resolve: vi.fn(async () => null) },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue },
    secrets: ["sample-secret"],
  } as unknown as Parameters<typeof createRunExecutor>[0];
  const reconciler = createJobReconciler({
    prisma: prisma as unknown as PrismaClient,
    jobs: deps.jobs,
  });
  return {
    run,
    task,
    messages,
    attempts,
    deps,
    prisma,
    reconciler,
    runtimeRun,
    enqueue,
    finalizeRun,
  };
}

afterEach(() => {
  vi.useRealTimers();
  provision.mockReset();
  acquire.mockReset();
  acquire.mockResolvedValue(null);
});

describe("durable setup failure handling", () => {
  it("rejects a stale queued snapshot instead of resetting newer persisted retry state", async () => {
    const f = fixture();
    const stale = { ...f.run };
    f.run.leaseFence = 2;
    f.run.setupFailureCount = 2;
    f.prisma.run.findUnique.mockResolvedValueOnce(stale);
    await createRunExecutor(f.deps).continueRun(f.run.id, "stale-worker");
    expect(f.run.setupFailureCount).toBe(2);
    expect(f.run.leaseFence).toBe(2);
    expect(provision).not.toHaveBeenCalled();
  });

  it("fails a permanent provisioning refusal and ignores reconciled or stale continuations", async () => {
    const f = fixture();
    const originalPrompt = structuredClone(f.messages);
    provision.mockRejectedValue(
      new PermanentSetupError("Pinned computer reuse checks failed: sample-secret"),
    );
    await f.reconciler.reconcileOnce();
    expect(f.enqueue).toHaveBeenCalledOnce();
    f.enqueue.mockClear();
    await createRunExecutor(f.deps).continueRun(f.run.id, "worker-1");
    expect(provision).toHaveBeenCalledOnce();
    expect(f.run).toMatchObject({ status: "failed", completedAt: expect.any(Date) });
    expect(f.run.error).toContain("Pinned computer reuse checks failed");
    expect(f.run.error).not.toContain("sample-secret");
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    for (let i = 0; i < 3; i++) {
      await f.reconciler.reconcileOnce();
      await createRunExecutor(f.deps).continueRun(f.run.id, `replacement-${i}`);
    }
    expect(provision).toHaveBeenCalledOnce();
    expect(f.runtimeRun).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.task.prompt).toBe("Review the sample function");
    expect(f.messages).toEqual(originalPrompt);
  });

  it("persists a bounded budget and backoff across queue reconciliation and executor replacement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    provision.mockRejectedValue(new Error("daemon temporarily unavailable"));
    for (let failures = 1; failures <= MAX_SETUP_FAILURES; failures++) {
      await createRunExecutor(f.deps).continueRun(f.run.id, `worker-${failures}`);
      expect(provision).toHaveBeenCalledTimes(failures);
      expect(f.runtimeRun).not.toHaveBeenCalled();
      if (failures === MAX_SETUP_FAILURES) break;
      expect(f.run.setupFailureCount).toBe(failures);
      expect(f.run.setupRetryAt?.getTime()).toBe(Date.now() + setupRetryDelay(failures));
      f.enqueue.mockClear();
      await f.reconciler.reconcileOnce();
      await createRunExecutor(f.deps).continueRun(f.run.id, "premature-retry");
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(provision).toHaveBeenCalledTimes(failures);
      vi.setSystemTime(f.run.setupRetryAt!);
      await f.reconciler.reconcileOnce();
      expect(f.enqueue).toHaveBeenCalledOnce();
    }
    expect(f.run.status).toBe("failed");
    expect(f.run.error).toContain("repeated attempts");
    f.enqueue.mockClear();
    await f.reconciler.reconcileOnce();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(["computer lease", "attempt creation"])(
    "bounds pre-attempt %s failures across reconciliation",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture();
      const originalPrompt = structuredClone(f.messages);
      if (stage === "computer lease") {
        acquire.mockRejectedValue(new Error("lease storage unavailable"));
      } else {
        f.prisma.attempt.create.mockRejectedValue(new Error("attempt storage unavailable"));
      }
      for (let failures = 1; failures <= MAX_SETUP_FAILURES; failures++) {
        await createRunExecutor(f.deps).continueRun(f.run.id, `worker-${failures}`);
        expect(f.attempts).toHaveLength(0);
        expect(f.runtimeRun).not.toHaveBeenCalled();
        if (failures === MAX_SETUP_FAILURES) break;
        expect(f.run.status).toBe("queued");
        expect(f.run.setupFailureCount).toBe(failures);
        expect(f.run.setupRetryAt?.getTime()).toBe(Date.now() + setupRetryDelay(failures));
        f.enqueue.mockClear();
        await f.reconciler.reconcileOnce();
        await createRunExecutor(f.deps).continueRun(f.run.id, "premature-worker");
        expect(f.enqueue).not.toHaveBeenCalled();
        vi.setSystemTime(f.run.setupRetryAt!);
        await f.reconciler.reconcileOnce();
        expect(f.enqueue).toHaveBeenCalledOnce();
      }
      expect(f.run.status).toBe("failed");
      expect(f.run.error).toContain("repeated attempts");
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed" }),
      );
      expect(f.finalizeRun.mock.calls.at(-1)?.[0]).not.toHaveProperty("attemptId");
      f.enqueue.mockClear();
      await f.reconciler.reconcileOnce();
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(f.task.prompt).toBe("Review the sample function");
      expect(f.messages).toEqual(originalPrompt);
    },
  );

  it("bounds a transient failure before the run reaches running", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.prisma.run.findUniqueOrThrow.mockRejectedValue(new Error("run read unavailable"));
    for (let failures = 1; failures <= MAX_SETUP_FAILURES; failures++) {
      await createRunExecutor(f.deps).continueRun(f.run.id, `worker-${failures}`);
      if (failures === MAX_SETUP_FAILURES) break;
      expect(f.run.status).toBe("queued");
      expect(f.run.setupFailureCount).toBe(failures);
      expect(f.run.setupRetryAt?.getTime()).toBe(Date.now() + setupRetryDelay(failures));
      f.enqueue.mockClear();
      await f.reconciler.reconcileOnce();
      expect(f.enqueue).not.toHaveBeenCalled();
      vi.setSystemTime(f.run.setupRetryAt!);
      await f.reconciler.reconcileOnce();
      expect(f.enqueue).toHaveBeenCalledOnce();
    }
    expect(f.run.status).toBe("failed");
    expect(f.attempts).toHaveLength(0);
    expect(provision).not.toHaveBeenCalled();
    expect(f.runtimeRun).not.toHaveBeenCalled();
    f.enqueue.mockClear();
    await f.reconciler.reconcileOnce();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("fails a permanent pre-attempt refusal without retrying", async () => {
    const f = fixture();
    acquire.mockRejectedValue(new PermanentSetupError("Computer lease refused: sample-secret"));
    await createRunExecutor(f.deps).continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("failed");
    expect(f.run.error).toContain("Computer lease refused");
    expect(f.run.error).not.toContain("sample-secret");
    expect(f.attempts).toHaveLength(0);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("keeps pre-attempt computer contention outside the budget", async () => {
    const f = fixture();
    acquire.mockRejectedValue(new ComputerBusyError());
    for (let i = 0; i < MAX_SETUP_FAILURES + 1; i++) {
      await createRunExecutor(f.deps).continueRun(f.run.id, "worker");
    }
    expect(f.run.status).toBe("queued");
    expect(f.run.setupFailureCount).toBe(0);
    expect(f.run.setupRetryAt).toBeNull();
    expect(f.attempts).toHaveLength(0);
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("keeps busy-computer deferrals outside the setup budget", async () => {
    const f = fixture();
    provision.mockRejectedValue(new ComputerBusyError());
    for (let i = 0; i < MAX_SETUP_FAILURES + 1; i++) {
      await createRunExecutor(f.deps).continueRun(f.run.id, "worker");
    }
    expect(f.run.status).toBe("queued");
    expect(f.run.setupFailureCount).toBe(0);
    expect(f.run.setupRetryAt).toBeNull();
    expect(f.attempts.every((attempt) => attempt.status === "deferred")).toBe(true);
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("cannot fail or requeue a cancelled run when provisioning loses a race with Stop", async () => {
    const f = fixture();
    provision.mockImplementation(async () => {
      f.run.status = "cancelled";
      f.run.completedAt = new Date();
      throw new PermanentSetupError("Computer setup refused");
    });
    await createRunExecutor(f.deps).continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("cancelled");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.runtimeRun).not.toHaveBeenCalled();
  });
});
