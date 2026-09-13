import type {
  AdapterContext,
  ComputerRef,
  ResearchObservation,
  ResearchProvider,
  ResearchStartRequest,
} from "@rakazo/adapter-kit";
import type { ResearchErrorCode } from "@rakazo/contracts";
import { ResearchErrorCodeSchema, ResearchFindingsSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { EmulatorResearchJob } from "./research-emulator.js";
import { EMULATOR_RESEARCH_FINDINGS, EmulatorResearchProvider } from "./research-emulator.js";
import { RESEARCH_BRIEF_MAX_BYTES, RESEARCH_BUDGET_MAX_MS } from "./research-request.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "test-computer",
  botId: "test-bot",
  kind: "fake",
  providerRef: "test-computer",
};

function request(
  jobId: string,
  overrides: Partial<ResearchStartRequest> = {},
): ResearchStartRequest {
  return {
    jobId,
    workdir: `bots/test-bot/research/${jobId}`,
    brief: { title: "Fixture topic", goal: "Find what the fixture says about the topic." },
    depth: "standard",
    budgetMs: 30 * 60_000,
    ...overrides,
  };
}

interface ConformanceHarness {
  provider: ResearchProvider;
  /** A new provider over the same provider-side state, as after a worker restart. */
  restart(): ResearchProvider;
  complete(jobId: string, findings?: unknown): void;
  fail(jobId: string, errorCode: ResearchErrorCode): void;
  timeOut(jobId: string): void;
  vanish(jobId: string): void;
  startedJobs(): number;
}

const factories: Record<string, () => ConformanceHarness> = {
  emulator() {
    const jobs = new Map<string, EmulatorResearchJob>();
    const provider = new EmulatorResearchProvider({ autoCompleteAfterObservations: null, jobs });
    return {
      provider,
      restart: () => new EmulatorResearchProvider({ autoCompleteAfterObservations: null, jobs }),
      complete: (jobId, findings) => provider.complete(jobId, findings),
      fail: (jobId, errorCode) => provider.fail(jobId, errorCode),
      timeOut: (jobId) => provider.timeOut(jobId),
      vanish: (jobId) => provider.vanish(jobId),
      startedJobs: () => jobs.size,
    };
  },
};

function expectConsistentReceipt(observation: ResearchObservation, jobId: string) {
  expect(observation.receipt.jobId).toBe(jobId);
  expect(observation.receipt.status).toBe(observation.status);
  if (observation.status !== "completed") {
    expect(observation.findings).toBeUndefined();
    expect(observation.receipt.findingsSha256).toBeUndefined();
  }
}

for (const [name, create] of Object.entries(factories)) {
  describe(`${name} research conformance (offline)`, () => {
    it("replays a start without a second job and keeps the first request", async () => {
      const harness = create();
      const first = await harness.provider.start(computer, request("replay"), ctx);
      expect(first.status).toBe("running");
      expect(first.receipt.requestSha256).toMatch(/^[0-9a-f]{64}$/);
      const replay = await harness.provider.start(
        computer,
        request("replay", { depth: "deep" }),
        ctx,
      );
      expect(replay.status).toBe("running");
      expect(replay.receipt.requestSha256).toBe(first.receipt.requestSha256);
      expect(harness.startedJobs()).toBe(1);
      expectConsistentReceipt(replay, "replay");
    });

    it("completes with findings that pass the shared schema and a stable digest", async () => {
      const harness = create();
      const job = request("complete");
      await harness.provider.start(computer, job, ctx);
      expect((await harness.provider.observe(computer, job, ctx)).status).toBe("running");
      harness.complete(job.jobId);
      const done = await harness.provider.observe(computer, job, ctx);
      expect(done.status).toBe("completed");
      expect(ResearchFindingsSchema.parse(done.findings)).toEqual(EMULATOR_RESEARCH_FINDINGS);
      expect(done.receipt).toMatchObject({ truncated: false, permissionDenials: 0 });
      expect(done.receipt.findingsSha256).toMatch(/^[0-9a-f]{64}$/);
      const again = await harness.provider.observe(computer, job, ctx);
      expect(again.receipt.findingsSha256).toBe(done.receipt.findingsSha256);
      expectConsistentReceipt(again, job.jobId);
    });

    it("ends with invalid output instead of publishing findings that break the schema", async () => {
      const harness = create();
      const job = request("invalid-output");
      await harness.provider.start(computer, job, ctx);
      harness.complete(job.jobId, {
        ...EMULATOR_RESEARCH_FINDINGS,
        claims: [{ text: "Uncited fact.", label: "confirmed", sourceIds: [] }],
      });
      const observed = await harness.provider.observe(computer, job, ctx);
      expect(observed).toMatchObject({ status: "failed", errorCode: "invalid_output" });
      expectConsistentReceipt(observed, job.jobId);
    });

    it("rejects an invalid start as a failed observation", async () => {
      const cases: Array<[string, Partial<ResearchStartRequest>]> = [
        ["absolute-workdir", { workdir: "/home/user/research" }],
        ["parent-workdir", { workdir: "bots/../research" }],
        ["long-budget", { budgetMs: RESEARCH_BUDGET_MAX_MS + 1 }],
        ["large-brief", { brief: { title: "Large", goal: "x".repeat(RESEARCH_BRIEF_MAX_BYTES) } }],
      ];
      for (const [jobId, overrides] of cases) {
        const harness = create();
        const observed = await harness.provider.start(computer, request(jobId, overrides), ctx);
        expect(observed, jobId).toMatchObject({ status: "failed", errorCode: "invalid_request" });
        expectConsistentReceipt(observed, jobId);
      }
      const harness = create();
      const unknownField = { ...request("unknown-field"), env: { SECRET: "fake" } };
      expect(
        (await harness.provider.start(computer, unknownField as ResearchStartRequest, ctx)).status,
      ).toBe("failed");
    });

    it("reports every classified failure without findings", async () => {
      for (const errorCode of ResearchErrorCodeSchema.options) {
        const harness = create();
        const job = request(`fail-${errorCode}`);
        await harness.provider.start(computer, job, ctx);
        harness.fail(job.jobId, errorCode);
        const observed = await harness.provider.observe(computer, job, ctx);
        expect(observed).toMatchObject({ status: "failed", errorCode });
        expectConsistentReceipt(observed, job.jobId);
      }
    });

    it("marks a timeout as truncated and publishes no partial findings", async () => {
      const harness = create();
      const job = request("timeout");
      await harness.provider.start(computer, job, ctx);
      harness.timeOut(job.jobId);
      const observed = await harness.provider.observe(computer, job, ctx);
      expect(observed.status).toBe("timed_out");
      expect(observed.receipt.truncated).toBe(true);
      expectConsistentReceipt(observed, job.jobId);
    });

    it("cancels idempotently and keeps a finished job finished", async () => {
      const harness = create();
      const job = request("cancel");
      await harness.provider.start(computer, job, ctx);
      expect((await harness.provider.cancel(computer, job, ctx)).status).toBe("cancelled");
      const twice = await harness.provider.cancel(computer, job, ctx);
      expect(twice.status).toBe("cancelled");
      expect((await harness.provider.observe(computer, job, ctx)).status).toBe("cancelled");
      expectConsistentReceipt(twice, job.jobId);

      const finished = request("cancel-after-complete");
      await harness.provider.start(computer, finished, ctx);
      harness.complete(finished.jobId);
      expect((await harness.provider.cancel(computer, finished, ctx)).status).toBe("completed");
    });

    it("observes the same job from a restarted provider", async () => {
      const harness = create();
      const job = request("restart");
      const first = await harness.provider.start(computer, job, ctx);
      const restarted = harness.restart();
      expect((await restarted.observe(computer, job, ctx)).status).toBe("running");
      expect((await restarted.start(computer, job, ctx)).receipt.requestSha256).toBe(
        first.receipt.requestSha256,
      );
      expect(harness.startedJobs()).toBe(1);
      harness.complete(job.jobId);
      expect((await restarted.observe(computer, job, ctx)).status).toBe("completed");
    });

    it("never starts again once a job vanished, and reports untraced jobs as uncertain", async () => {
      const harness = create();
      const job = request("vanished");
      await harness.provider.start(computer, job, ctx);
      harness.vanish(job.jobId);
      const replay = await harness.provider.start(computer, job, ctx);
      expect(replay.status).toBe("uncertain");
      expect(harness.startedJobs()).toBe(1);
      expectConsistentReceipt(replay, job.jobId);

      const untraced = request("never-started");
      for (const observed of [
        await harness.provider.observe(computer, untraced, ctx),
        await harness.provider.cancel(computer, untraced, ctx),
      ]) {
        expect(observed.status).toBe("uncertain");
        expect(observed.receipt.requestSha256).toBeUndefined();
        expectConsistentReceipt(observed, untraced.jobId);
      }
    });

    it("honors an aborted context before recording anything", async () => {
      const harness = create();
      const aborted = { ...ctx, signal: AbortSignal.abort() };
      await expect(harness.provider.start(computer, request("aborted"), aborted)).rejects.toThrow();
      expect(harness.startedJobs()).toBe(0);
      await expect(
        harness.provider.observe(computer, request("aborted"), aborted),
      ).rejects.toThrow();
      await expect(
        harness.provider.cancel(computer, request("aborted"), aborted),
      ).rejects.toThrow();
    });
  });
}

describe("emulator research provider", () => {
  it("completes a running job on its own after the configured observations", async () => {
    const provider = new EmulatorResearchProvider({ autoCompleteAfterObservations: 2 });
    const job = request("auto");
    await provider.start(computer, job, ctx);
    expect((await provider.observe(computer, job, ctx)).status).toBe("running");
    expect((await provider.observe(computer, job, ctx)).status).toBe("completed");
    expect(provider.describe().capabilities.offline).toBe(true);
  });
});
