import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { executeResearchTool, type ResearchDeps } from "./research-service.js";

const brief = { title: "Pricing survey", goal: "Compare vendor pricing pages" };
const context: AdapterContext & { botId: string } = {
  operationId: "op-1",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const run = { id: "run", threadId: "thread" };

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    operationKey: "op-1",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    threadId: "thread",
    messageId: "msg-1",
    computerId: "computer",
    title: "Pricing survey",
    request: {},
    status: "queued",
    errorCode: null,
    receipt: null,
    artifactIds: [],
    launchDispatched: false,
    cancelRequested: false,
    startedAt: null,
    deadlineAt: null,
    wakeRunId: null,
    version: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    nextPollAt: new Date("2026-09-13T00:00:00.000Z"),
    errorCount: 0,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

function uniqueError(target?: string[]) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: target ? { target } : {},
  });
}

function harness(options: {
  transaction: object | (() => Promise<never>);
  existing?: ReturnType<typeof job> | null;
}) {
  const enqueue = vi.fn(async () => undefined);
  const notify = vi.fn(async () => undefined);
  const prisma = {
    spaceResearchSettings: {
      findUnique: async () => ({ settings: { model: "emulator" } }),
    },
    researchJob: {
      findUnique: async () => options.existing ?? null,
    },
    $transaction: async (fn: (tx: object) => Promise<unknown>) => {
      if (typeof options.transaction === "function") return options.transaction();
      return fn(options.transaction);
    },
  };
  const deps = {
    prisma,
    jobs: {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    } as JobPublisher,
    events: { notify },
    artifacts: { put: vi.fn(), get: vi.fn() },
    research: { provider: () => ({}) },
  } as unknown as ResearchDeps;
  return { deps, enqueue, notify };
}

describe("research_start snapshot and unique recovery", () => {
  it("returns the persisted job status instead of hardcoding queued", async () => {
    const existing = job({
      status: "running",
      receipt: { status: "running", provider: "emulator" },
    });
    const { deps, enqueue, notify } = harness({
      transaction: {
        thread: { update: async () => undefined },
        researchJob: { findUnique: async () => existing },
      },
    });
    const result = await executeResearchTool(deps, context, run, "research_start", brief);
    expect(result).toMatchObject({
      researchId: "job-1",
      title: "Pricing survey",
      status: "running",
      receipt: { status: "running", provider: "emulator" },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "research.poll", payload: { jobId: "job-1" } }),
    );
  });

  it("replays the matching job when create loses the operationKey unique race", async () => {
    const existing = job({
      status: "completed",
      nextPollAt: null,
      errorCode: "unavailable",
    });
    const { deps, enqueue, notify } = harness({
      transaction: async () => {
        throw uniqueError(["operationKey"]);
      },
      existing,
    });
    const result = await executeResearchTool(deps, context, run, "research_start", brief);
    expect(result).toMatchObject({
      researchId: "job-1",
      status: "completed",
      errorCode: "unavailable",
    });
    expect(result).not.toHaveProperty("error");
    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports computer busy when the active-computer unique index is a different job", async () => {
    const { deps } = harness({
      transaction: async () => {
        throw uniqueError(["computerId"]);
      },
      existing: null,
    });
    const result = await executeResearchTool(deps, context, run, "research_start", brief);
    expect(result).toMatchObject({ error: expect.stringContaining("already running") });
  });

  it("replays when an unnamed unique conflict still matches the operationKey", async () => {
    const existing = job({ status: "running" });
    const { deps } = harness({
      transaction: async () => {
        throw uniqueError();
      },
      existing,
    });
    const result = await executeResearchTool(deps, context, run, "research_start", brief);
    expect(result).toMatchObject({ researchId: "job-1", status: "running" });
  });

  it("does not treat a message sequence unique conflict as a busy computer", async () => {
    const { deps } = harness({
      transaction: async () => {
        throw uniqueError(["threadId", "seq"]);
      },
      existing: job(),
    });
    await expect(
      executeResearchTool(deps, context, run, "research_start", brief),
    ).rejects.toMatchObject({
      code: "P2002",
      meta: { target: ["threadId", "seq"] },
    });
  });
});
