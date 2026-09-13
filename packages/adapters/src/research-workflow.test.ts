import type {
  AdapterContext,
  ComputerRef,
  ResearchProvider,
  ResearchStartRequest,
} from "@rakazo/adapter-kit";
import type { ResearchStatus } from "@rakazo/contracts";
import {
  MessageBlock,
  ProductEventSchema,
  ResearchFindingsSchema,
  RunActivityRowSchema,
  RunSchema,
  ThreadMessageSchema,
} from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorResearchProvider } from "./research-emulator.js";

const context: AdapterContext = {
  operationId: "fixture-operation",
  traceId: "fixture-trace",
  spaceId: "fixture-workspace",
  userId: "fixture-user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "fixture-computer",
  botId: "fixture-bot",
  kind: "fake",
  providerRef: "fixture-computer",
};
const request: ResearchStartRequest = {
  jobId: "fixture-research",
  workdir: "bots/fixture-bot/research/fixture-research",
  brief: {
    title: "Check the fixture fact",
    goal: "Find a supported claim and distinguish it from inference.",
    context: "An offline research harness demonstration.",
    preferredSources: ["https://research.test/sources/1"],
    successCriteria: "Return a cited claim, a labeled inference, gaps, and apply notes.",
    nonGoals: "Do not contact a live provider or apply changes.",
  },
  depth: "deep",
  budgetMs: 60_000,
};

afterEach(() => vi.useRealTimers());

describe("research library workflow (offline)", () => {
  it("returns cited findings across a worker restart and serializes the future thread contracts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const emulator = new EmulatorResearchProvider();
    let provider: ResearchProvider = emulator;
    const started = await provider.start(computer, request, context);
    const replayed = await provider.start(computer, { ...request, depth: "standard" }, context);
    expect(replayed).toEqual(started);
    expect(emulator.jobs.size).toBe(1);

    provider = new EmulatorResearchProvider({ jobs: emulator.jobs });
    const running = await provider.observe(computer, request, context);
    expect(running.status).toBe("running");
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    const completed = await provider.observe(computer, request, context);
    expect(completed.status).toBe("completed");
    const findings = ResearchFindingsSchema.parse(completed.findings);
    expect(findings.claims.some((claim) => claim.label === "confirmed")).toBe(true);
    expect(findings.claims.some((claim) => claim.label === "inference")).toBe(true);
    expect(findings.gaps.length).toBeGreaterThan(0);
    expect(findings.applyNotes.length).toBeGreaterThan(0);
    for (const claim of findings.claims.filter((claim) => claim.label === "confirmed")) {
      expect(claim.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of claim.sourceIds) {
        expect(findings.sources.some((source) => source.id === sourceId)).toBe(true);
      }
    }
    expect(completed.receipt).toMatchObject({
      jobId: request.jobId,
      provider: "emulator",
      adapterVersion: provider.describe().adapterVersion,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:30.000Z",
      truncated: false,
      permissionDenials: 0,
      requestSha256: started.receipt.requestSha256,
      findingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const durable = JSON.parse(JSON.stringify(completed));
    completed.findings!.summary = "A consumer changed its local copy.";
    expect(await provider.observe(computer, request, context)).toEqual(durable);
    expect(await provider.cancel(computer, request, context)).toEqual(durable);

    // These are contract round trips, not executor dispatch or client rendering.
    const states: ResearchStatus[] = ["queued", started.status, durable.status];
    states.forEach((status, seq) => {
      const block = MessageBlock.parse({
        kind: "research",
        researchId: request.jobId,
        title: request.brief.title,
        status,
      });
      const event = ProductEventSchema.parse({
        id: `fixture-event-${seq}`,
        spaceId: context.spaceId,
        threadId: "fixture-thread",
        botId: computer.botId,
        seq,
        type: "thread.research",
        createdAt: new Date().toISOString(),
        payload: block,
      });
      const message = ThreadMessageSchema.parse({
        id: `fixture-message-${seq}`,
        threadId: event.threadId,
        seq,
        role: "system",
        blocks: [block],
        botId: computer.botId,
        createdAt: event.createdAt,
      });
      expect(ProductEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
      expect(ThreadMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    });
    const run = RunSchema.parse({
      id: "fixture-run",
      botId: computer.botId,
      threadId: "fixture-thread",
      taskId: "fixture-task",
      status: "queued",
      trigger: "research",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
    const activity = RunActivityRowSchema.parse({
      runId: run.id,
      botId: run.botId,
      botName: "Fixture bot",
      groupId: null,
      groupName: null,
      threadId: run.threadId,
      status: run.status,
      trigger: run.trigger,
      notificationsEnabled: false,
      promptSnippet: request.brief.title,
      updatedAt: run.createdAt,
    });
    expect(run.trigger).toBe("research");
    expect(activity.trigger).toBe("research");
  });

  it("recovers a lost start response by observing and keeps cancellation durable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const emulator = new EmulatorResearchProvider({ autoCompleteAfterObservations: null });
    const start = vi.fn(async () => {
      await emulator.start(computer, request, context);
      throw new Error("Fixture transport lost the start response");
    });
    await expect(start()).rejects.toThrow("lost the start response");
    const provider: ResearchProvider = new EmulatorResearchProvider({
      jobs: emulator.jobs,
      autoCompleteAfterObservations: null,
    });
    const recovered = await provider.observe(computer, request, context);
    expect(recovered.status).toBe("running");
    expect(start).toHaveBeenCalledTimes(1);
    expect(emulator.jobs.size).toBe(1);
    const cancelled = await provider.cancel(computer, request, context);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.receipt.truncated).toBe(true);
    const replayed = await provider.start(computer, request, context);
    expect(replayed).toEqual(cancelled);
    expect(await provider.observe(computer, request, context)).toEqual(cancelled);
    expect(emulator.jobs.size).toBe(1);
    const absent = await provider.observe(
      computer,
      { jobId: "untraced-job", workdir: "research/untraced-job" },
      context,
    );
    expect(absent.status).toBe("uncertain");
    expect(emulator.jobs.size).toBe(1);
    for (const observation of [recovered, cancelled, replayed, absent]) {
      expect(observation.findings).toBeUndefined();
      expect(observation.receipt.findingsSha256).toBeUndefined();
    }
  });
});
