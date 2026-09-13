import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { MessageBlock, ResearchFindings } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import { clearThread, createDb, createThreadEvents, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderResearchReport } from "./antigravity-research.js";
import { LocalArtifactStore } from "./artifacts.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { createJobReconciler } from "./job-reconciler.js";
import { EMULATOR_RESEARCH_FINDINGS, EmulatorResearchProvider } from "./research-emulator.js";
import { pollResearchJob, RESEARCH_MAX_LAUNCH_ERRORS } from "./research-poll.js";
import {
  executeResearchTool,
  RESEARCH_STATUS_MAX_BYTES,
  type ResearchConnection,
  reconcileResearchJobs,
} from "./research-service.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Valid findings whose JSON is well past the status result bound but under the schema cap. */
function largeFindings(): ResearchFindings {
  return {
    ...EMULATOR_RESEARCH_FINDINGS,
    gaps: Array.from({ length: 60 }, (_, index) => `${index}: ${"g".repeat(1_000)}`),
  };
}

describePostgres("research job lifecycle and recovery (PostgreSQL + research emulator)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let dataDir: string;
  const users: string[] = [];
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-research-"));
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.researchJob.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function setup(options: { computerState?: "running" | "stopped" } = {}) {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Research test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Research test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Research test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const state = options.computerState ?? "running";
    const computer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scope: "dedicated",
        scopeKey: `research-test:${id}`,
        homeKey: `research-home-${id}`,
        kind: "fake",
        state,
        providerRef: state === "running" ? `fake-research-home-${id}` : null,
      },
    });
    const bot = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Research test",
        color: "test-color",
        computerId: computer.id,
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Test",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    await prisma.spaceResearchSettings.create({
      data: { spaceId: id, userId: id, settings: { model: "emulator" } },
    });
    const emulator = new EmulatorResearchProvider({ autoCompleteAfterObservations: null });
    const connection: ResearchConnection = { provider: () => emulator };
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const events = { ...createThreadEvents(prisma), notify: vi.fn(async () => undefined) };
    const sandbox = new FakeSandboxProvider();
    const deps = {
      prisma,
      jobs,
      events,
      artifacts: new LocalArtifactStore(dataDir),
      research: connection,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      dataDir,
    };
    const context: AdapterContext & { botId: string } = {
      operationId: randomUUID(),
      traceId: "test",
      spaceId: id,
      userId: id,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const tool = (
      name: string,
      args: Record<string, unknown>,
      overrides: Partial<typeof context> = {},
    ) => executeResearchTool(deps, { ...context, ...overrides }, run, `research_${name}`, args);
    const start = async (overrides: Partial<typeof context> = {}) => {
      const result = await tool(
        "start",
        { title: "Pricing survey", goal: "Compare vendor pricing pages" },
        overrides,
      );
      if (!("researchId" in result)) throw new Error(`Start failed: ${JSON.stringify(result)}`);
      return result.researchId;
    };
    const state_ = (jobId: string) =>
      prisma.researchJob.findUniqueOrThrow({ where: { id: jobId } });
    const poll = (jobId: string) => pollResearchJob(deps, { jobId });
    const clear = () => clearThread(prisma, { spaceId: id, botId: bot.id, threadId: thread.id });
    const wakes = () =>
      prisma.run.findMany({ where: { threadId: thread.id, trigger: "research" } });
    const card = async () => {
      const row = await prisma.message.findFirst({ where: { threadId: thread.id } });
      return row ? (row.blocks as MessageBlock[]) : null;
    };
    const finish = async (jobId: string, findings: unknown = EMULATOR_RESEARCH_FINDINGS) => {
      emulator.complete(jobId, findings);
      await poll(jobId);
    };
    return {
      id,
      bot,
      computer,
      thread,
      run,
      emulator,
      connection,
      enqueue,
      events,
      deps,
      context,
      tool,
      start,
      state: state_,
      poll,
      clear,
      wakes,
      card,
      finish,
    };
  }

  it("persists the row and card together before any computer I/O, launches once, and wakes once", async () => {
    const h = await setup();
    const id = await h.start();
    expect(h.emulator.jobs.size).toBe(0);
    expect(await h.state(id)).toMatchObject({
      status: "queued",
      computerId: h.computer.id,
      launchDispatched: false,
    });
    expect(await h.card()).toEqual([
      { kind: "research", researchId: id, title: "Pricing survey", status: "queued" },
    ]);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "research.poll", payload: { jobId: id } }),
    );
    // Replaying the same approved operation returns the same job.
    expect(await h.start()).toBe(id);
    expect(await prisma.researchJob.count({ where: { userId: h.id } })).toBe(1);

    await h.poll(id);
    expect(h.emulator.jobs.size).toBe(1);
    expect(await h.state(id)).toMatchObject({ status: "running", launchDispatched: true });
    expect(await h.card()).toMatchObject([{ kind: "research", status: "running" }]);
    expect(h.events.notify).toHaveBeenCalledTimes(2);
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(0);

    await h.finish(id);
    expect(await h.state(id)).toMatchObject({ status: "completed", nextPollAt: null });
    const [wake] = await h.wakes();
    expect(wake).toMatchObject({ status: "queued", botId: h.bot.id, userId: h.id });
    expect((await h.state(id)).wakeRunId).toBe(wake!.id);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: wake!.id } }),
    );
    const researchEvents = await prisma.event.findMany({
      where: { threadId: h.thread.id, type: "thread.research" },
      orderBy: { seq: "asc" },
    });
    expect(researchEvents.map((event) => (event.payload as { status: string }).status)).toEqual([
      "running",
      "completed",
    ]);
    expect(await prisma.memoryDocument.count({ where: { spaceId: h.id } })).toBe(0);
    expect(await prisma.memoryRevision.count({ where: { document: { spaceId: h.id } } })).toBe(0);
    // A stale re-poll after completion neither wakes again nor touches the computer.
    await prisma.researchJob.update({ where: { id }, data: { nextPollAt: new Date() } });
    const observe = vi.spyOn(h.emulator, "observe");
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
    expect((await h.state(id)).nextPollAt).toBeNull();
  });

  it("attaches findings.json and report.md through the artifact store and renders history text", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    await h.finish(id);
    const job = await h.state(id);
    expect(job.artifactIds).toHaveLength(2);
    const artifacts = await prisma.artifact.findMany({
      where: { id: { in: job.artifactIds } },
      orderBy: { name: "asc" },
    });
    expect(artifacts.map((row) => row.name)).toEqual(["findings.json", "report.md"]);
    const encoder = new TextEncoder();
    expect(artifacts[0]!.hash).toBe(
      sha256(encoder.encode(JSON.stringify(EMULATOR_RESEARCH_FINDINGS, null, 2))),
    );
    expect(artifacts[1]!.hash).toBe(
      sha256(encoder.encode(renderResearchReport(EMULATOR_RESEARCH_FINDINGS))),
    );
    for (const row of artifacts) {
      expect(row).toMatchObject({ spaceId: h.id, userId: h.id, botId: h.bot.id, runId: h.run.id });
      const bytes = await h.deps.artifacts.get(row.storageKey, h.context);
      expect(sha256(bytes)).toBe(row.hash);
    }
    const blocks = (await h.card())!;
    expect(blocks[0]).toEqual({
      kind: "research",
      researchId: id,
      title: "Pricing survey",
      status: "completed",
    });
    expect(
      blocks.filter((block) => block.kind === "file").map((block) => block.artifactId),
    ).toEqual(expect.arrayContaining(job.artifactIds));
    expect(blocksToAgentHistoryText(blocks)).toContain("[research: Pricing survey - completed]");
    // Status returns the findings from the stored artifact with its receipt.
    expect(await h.tool("status", { researchId: id })).toMatchObject({
      researchId: id,
      status: "completed",
      receipt: expect.objectContaining({ status: "completed", provider: "emulator" }),
      findings: EMULATOR_RESEARCH_FINDINGS,
    });
  });

  it("bounds research_status to a summary with counts once findings exceed the budget", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    const findings = largeFindings();
    expect(new TextEncoder().encode(JSON.stringify(findings, null, 2)).byteLength).toBeGreaterThan(
      RESEARCH_STATUS_MAX_BYTES,
    );
    await h.finish(id, findings);
    const result = await h.tool("status", { researchId: id });
    expect(result).not.toHaveProperty("findings");
    expect(result).toMatchObject({
      status: "completed",
      summary: findings.summary,
      counts: { claims: 2, sources: 1, gaps: 60, applyNotes: 1 },
      findingsPath: `research/${id}/findings.json`,
    });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(
      RESEARCH_STATUS_MAX_BYTES,
    );
  });

  it("allows one active research job per computer and frees the slot when the job ends", async () => {
    const h = await setup();
    const first = await h.start();
    const second = await h.tool(
      "start",
      { title: "Second", goal: "Another goal" },
      { operationId: randomUUID() },
    );
    expect(second).toMatchObject({ error: expect.stringContaining("already running") });
    expect(await prisma.researchJob.count({ where: { computerId: h.computer.id } })).toBe(1);
    expect(await prisma.message.count({ where: { threadId: h.thread.id } })).toBe(1);
    await h.poll(first);
    expect(
      await h.tool("start", { title: "Third", goal: "Yet another" }, { operationId: randomUUID() }),
    ).toHaveProperty("error");
    await h.finish(first);
    const next = await h.tool(
      "start",
      { title: "After", goal: "Runs once the first ended" },
      { operationId: randomUUID() },
    );
    expect(next).toMatchObject({ status: "queued" });
    expect(
      await prisma.researchJob.count({
        where: { computerId: h.computer.id, status: { in: ["queued", "running"] } },
      }),
    ).toBe(1);
  });

  it("lets only one of two concurrent pollers observe the computer", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    const observe = vi.spyOn(h.emulator, "observe");
    await Promise.all([h.poll(id), h.poll(id)]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(await h.state(id)).toMatchObject({ leaseToken: null, leaseExpiresAt: null });
  });

  it("reconciles durable poll and wake intents after queue failure", async () => {
    const h = await setup();
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    const id = await h.start();
    expect((await h.state(id)).nextPollAt).not.toBeNull();
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await reconcileResearchJobs(h.deps);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "research.poll", payload: { jobId: id } }),
    );
    await h.poll(id);
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    await h.finish(id);
    const [wake] = await h.wakes();
    expect(wake?.status).toBe("queued");
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await createJobReconciler({ prisma, jobs: h.deps.jobs }).reconcileOnce();
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: wake!.id } }),
    );
  });

  it("never creates a job whose card transaction fails, and refuses without a computer", async () => {
    const h = await setup();
    await expect(h.start({ userId: "wrong-owner" })).rejects.toThrow();
    expect(await prisma.researchJob.count({ where: { userId: h.id } })).toBe(0);
    expect(await prisma.message.count({ where: { threadId: h.thread.id } })).toBe(0);
    await prisma.bot.update({ where: { id: h.bot.id }, data: { computerId: null } });
    expect(await h.tool("start", { title: "No computer", goal: "Nothing" })).toMatchObject({
      error: "This bot has no computer.",
    });
    await prisma.spaceResearchSettings.delete({ where: { spaceId: h.id } });
    expect(await h.tool("start", { title: "Disabled", goal: "Nothing" })).toMatchObject({
      error: "Research is not enabled for this space.",
    });
  });

  it("cancels locally when the user cancels before dispatch, and on the computer after", async () => {
    const before = await setup();
    const beforeId = await before.start();
    expect(await before.tool("cancel", { researchId: beforeId })).toMatchObject({
      status: "queued",
      cancellationPending: true,
    });
    await before.poll(beforeId);
    expect(await before.state(beforeId)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      nextPollAt: null,
    });
    expect(before.emulator.jobs.size).toBe(0);
    expect(await before.wakes()).toHaveLength(1);

    const after = await setup();
    const afterId = await after.start();
    await after.poll(afterId);
    await after.tool("cancel", { researchId: afterId });
    await after.poll(afterId);
    expect(after.emulator.jobs.get(afterId)!.status).toBe("cancelled");
    expect(await after.state(afterId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(await after.card()).toMatchObject([{ kind: "research", status: "cancelled" }]);
    expect(await after.tool("status", { researchId: afterId })).toMatchObject({
      status: "cancelled",
      receipt: expect.objectContaining({ truncated: true }),
    });
    expect(await after.tool("cancel", { researchId: afterId })).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancels when chat clears, before dispatch without touching the computer", async () => {
    const before = await setup();
    const beforeId = await before.start();
    await before.clear();
    await before.poll(beforeId);
    expect((await before.state(beforeId)).status).toBe("cancelled");
    expect(before.emulator.jobs.size).toBe(0);
    expect(await before.wakes()).toHaveLength(0);

    const after = await setup();
    const afterId = await after.start();
    await after.poll(afterId);
    await after.clear();
    await after.poll(afterId);
    expect(await after.state(afterId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(after.emulator.jobs.get(afterId)!.status).toBe("cancelled");
    expect(await prisma.message.count({ where: { threadId: after.thread.id } })).toBe(0);
    expect(await after.wakes()).toHaveLength(0);
  });

  it("cancels when the original bot is deleted", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    await prisma.bot.delete({ where: { id: h.bot.id } });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(0);
  });

  it("does not wake an owner whose membership is revoked during the computer request", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    h.emulator.complete(id);
    const original = h.emulator.observe.bind(h.emulator);
    vi.spyOn(h.emulator, "observe").mockImplementationOnce(async (...args) => {
      const observation = await original(...args);
      await prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: h.id, userId: h.id } },
      });
      return observation;
    });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(0);
    expect(await h.state(id)).toMatchObject({ status: "completed", nextPollAt: null });
    // Nothing was attached for an owner who can no longer read the thread.
    expect((await h.state(id)).artifactIds).toEqual([]);
    expect(await prisma.artifact.count({ where: { userId: h.id } })).toBe(0);
  });

  it("isolates users and spaces before any computer request", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    const observe = vi.spyOn(h.emulator, "observe");
    const cancel = vi.spyOn(h.emulator, "cancel");
    expect(await h.tool("cancel", { researchId: id }, { userId: "other-user" })).toMatchObject({
      error: "Unknown research job.",
    });
    expect(await h.tool("status", { researchId: id }, { spaceId: "other-space" })).toMatchObject({
      error: "Research is not enabled for this space.",
    });
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: false });
    expect(observe).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records provider failures with their error code and wakes once", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    h.emulator.fail(id, "permission_denied");
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "failed",
      errorCode: "permission_denied",
      artifactIds: [],
    });
    expect(await h.tool("status", { researchId: id })).toMatchObject({
      status: "failed",
      errorCode: "permission_denied",
    });
    expect(await h.wakes()).toHaveLength(1);
    const invalid = await setup();
    const invalidId = await invalid.start();
    await invalid.poll(invalidId);
    await invalid.finish(invalidId, { summary: "no claims" });
    expect(await invalid.state(invalidId)).toMatchObject({
      status: "failed",
      errorCode: "invalid_output",
    });
  });

  it("stops a job that outlives its budget and records it as timed out", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    await prisma.researchJob.update({
      where: { id },
      data: { deadlineAt: new Date(Date.now() - 1_000) },
    });
    await h.poll(id);
    expect(h.emulator.jobs.get(id)!.status).toBe("cancelled");
    expect(await h.state(id)).toMatchObject({ status: "timed_out", nextPollAt: null });
    expect(await h.tool("status", { researchId: id })).toMatchObject({
      status: "timed_out",
      receipt: expect.objectContaining({ status: "timed_out", truncated: true }),
    });
    expect(await h.wakes()).toHaveLength(1);
  });

  it("retries a computer that cannot be reached and gives up as unavailable before launch", async () => {
    const h = await setup();
    const id = await h.start();
    vi.spyOn(h.emulator, "start").mockRejectedValue(new Error("computer unreachable"));
    await h.poll(id);
    const after = await h.state(id);
    // The dispatch mark stays; the retry is backed off and replays the idempotent start.
    expect(after).toMatchObject({ launchDispatched: true, status: "queued", errorCount: 1 });
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(h.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "research.poll", payload: { jobId: id } }),
    );
    vi.restoreAllMocks();
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 0 });
    expect(h.emulator.jobs.size).toBe(1);
    // Cancelling a dispatched job the computer never traced ends it cancelled, not uncertain.
    const lost = await setup();
    const lostId = await lost.start();
    vi.spyOn(lost.emulator, "start").mockRejectedValueOnce(new Error("computer unreachable"));
    await lost.poll(lostId);
    await lost.tool("cancel", { researchId: lostId });
    await lost.poll(lostId);
    expect(await lost.state(lostId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(lost.emulator.jobs.size).toBe(0);
    const fresh = await setup();
    const freshId = await fresh.start();
    await prisma.computer.delete({ where: { id: fresh.computer.id } });
    await fresh.poll(freshId);
    expect(await fresh.state(freshId)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
      nextPollAt: null,
    });
    expect(await fresh.wakes()).toHaveLength(1);
  });

  it("ends a launched job as uncertain when research is disabled for the space mid-flight", async () => {
    const h = await setup();
    const id = await h.start();
    await h.poll(id);
    await prisma.spaceResearchSettings.delete({ where: { spaceId: h.id } });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "uncertain", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(1);
    const before = await setup();
    const beforeId = await before.start();
    await prisma.spaceResearchSettings.delete({ where: { spaceId: before.id } });
    await before.poll(beforeId);
    expect(await before.state(beforeId)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
    });
  });

  it("gives up as unavailable after repeated launch failures", async () => {
    const h = await setup();
    const id = await h.start();
    vi.spyOn(h.emulator, "start").mockRejectedValue(new Error("computer unreachable"));
    await prisma.researchJob.update({
      where: { id },
      data: { errorCount: RESEARCH_MAX_LAUNCH_ERRORS - 1 },
    });
    await h.poll(id);
    vi.restoreAllMocks();
    expect(await h.state(id)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
      nextPollAt: null,
    });
  });

  it("provisions a stopped computer for the launch without any run lease", async () => {
    const h = await setup({ computerState: "stopped" });
    const id = await h.start();
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", launchDispatched: true });
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: h.computer.id } })).toMatchObject(
      { state: "running", executionRunId: null },
    );
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "computer.sleep" }));
  });
});
