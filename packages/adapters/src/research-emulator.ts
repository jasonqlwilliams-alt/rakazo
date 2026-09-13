import type {
  AdapterContext,
  ComputerRef,
  ResearchJobRef,
  ResearchObservation,
  ResearchObservedStatus,
  ResearchProvider,
  ResearchStartRequest,
} from "@rakazo/adapter-kit";
import type { ResearchErrorCode, ResearchFindings } from "@rakazo/contracts";
import { ResearchFindingsSchema } from "@rakazo/contracts";
import { researchDigest, researchStartRequestSchema } from "./research-request.js";

/** Provider-side record of one job; share the map across instances to emulate a worker restart. */
export interface EmulatorResearchJob {
  jobId: string;
  requestSha256?: string;
  status: ResearchObservedStatus;
  findings?: ResearchFindings;
  errorCode?: ResearchErrorCode;
  truncated: boolean;
  startedAt: string;
  finishedAt?: string;
  observations: number;
}

export const EMULATOR_RESEARCH_FINDINGS: ResearchFindings = {
  summary: "The emulator found one confirmed fact and one inference.",
  claims: [
    { text: "The fixture page states the confirmed fact.", label: "confirmed", sourceIds: ["s1"] },
    { text: "The fixture suggests a follow-up is useful.", label: "inference", sourceIds: [] },
  ],
  sources: [
    {
      id: "s1",
      kind: "url",
      locator: "https://research.test/sources/1",
      title: "Fixture source",
      retrievedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  gaps: ["The fixture does not cover a second source."],
  applyNotes: ["Nothing to apply in the emulator."],
};

/** Offline research provider with durable job identity and explicit outcome controls. */
export class EmulatorResearchProvider implements ResearchProvider {
  readonly jobs: Map<string, EmulatorResearchJob>;
  private readonly autoCompleteAfterObservations: number | null;

  constructor(
    options: {
      /** Observations of a running job before it completes; null waits for `complete`. */
      autoCompleteAfterObservations?: number | null;
      jobs?: Map<string, EmulatorResearchJob>;
    } = {},
  ) {
    this.jobs = options.jobs ?? new Map();
    this.autoCompleteAfterObservations =
      options.autoCompleteAfterObservations === undefined
        ? 2
        : options.autoCompleteAfterObservations;
  }

  describe() {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { cancel: true, offline: true },
    };
  }

  async start(_computer: ComputerRef, request: ResearchStartRequest, context: AdapterContext) {
    context.signal.throwIfAborted();
    const existing = this.jobs.get(request.jobId);
    if (existing) return this.observation(existing);
    const now = new Date().toISOString();
    const parsed = researchStartRequestSchema.safeParse(request);
    const job: EmulatorResearchJob = parsed.success
      ? {
          jobId: request.jobId,
          requestSha256: researchDigest(parsed.data),
          status: "running",
          truncated: false,
          startedAt: now,
          observations: 0,
        }
      : {
          jobId: request.jobId,
          status: "failed",
          errorCode: "invalid_request",
          truncated: false,
          startedAt: now,
          finishedAt: now,
          observations: 0,
        };
    this.jobs.set(request.jobId, job);
    return this.observation(job);
  }

  async observe(_computer: ComputerRef, job: ResearchJobRef, context: AdapterContext) {
    context.signal.throwIfAborted();
    const record = this.jobs.get(job.jobId);
    if (!record) return this.untraced(job.jobId);
    if (record.status === "running" && this.autoCompleteAfterObservations !== null) {
      record.observations++;
      if (record.observations >= this.autoCompleteAfterObservations) this.complete(job.jobId);
    }
    return this.observation(record);
  }

  async cancel(_computer: ComputerRef, job: ResearchJobRef, context: AdapterContext) {
    context.signal.throwIfAborted();
    const record = this.jobs.get(job.jobId);
    if (!record) return this.untraced(job.jobId);
    if (record.status !== "running") return this.observation(record);
    return this.finish(record, "cancelled", { truncated: true });
  }

  /** Finish a running job. Findings that fail the shared schema end it as invalid output. */
  complete(jobId: string, findings: unknown = EMULATOR_RESEARCH_FINDINGS) {
    const parsed = ResearchFindingsSchema.safeParse(findings);
    return parsed.success
      ? this.finish(this.running(jobId), "completed", { findings: parsed.data })
      : this.finish(this.running(jobId), "failed", { errorCode: "invalid_output" });
  }

  fail(jobId: string, errorCode: ResearchErrorCode) {
    return this.finish(this.running(jobId), "failed", { errorCode });
  }

  timeOut(jobId: string) {
    return this.finish(this.running(jobId), "timed_out", { truncated: true });
  }

  /** The job's process vanished without a result, as on a replaced computer. */
  vanish(jobId: string) {
    return this.finish(this.running(jobId), "uncertain", { truncated: true });
  }

  private finish(
    record: EmulatorResearchJob,
    status: Exclude<ResearchObservedStatus, "running">,
    outcome: { findings?: ResearchFindings; errorCode?: ResearchErrorCode; truncated?: boolean },
  ) {
    record.status = status;
    record.findings = outcome.findings;
    record.errorCode = outcome.errorCode;
    record.truncated = outcome.truncated ?? false;
    record.finishedAt = new Date().toISOString();
    return this.observation(record);
  }

  private running(jobId: string) {
    const record = this.jobs.get(jobId);
    if (record?.status !== "running") {
      throw new Error(`Emulator research job ${jobId} is not running`);
    }
    return record;
  }

  private untraced(jobId: string): ResearchObservation {
    return {
      status: "uncertain",
      receipt: {
        jobId,
        provider: this.describe().id,
        adapterVersion: this.describe().adapterVersion,
        status: "uncertain",
        truncated: false,
        permissionDenials: 0,
      },
    };
  }

  private observation(record: EmulatorResearchJob): ResearchObservation {
    const { adapterVersion, id } = this.describe();
    return {
      status: record.status,
      ...(record.findings ? { findings: structuredClone(record.findings) } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      receipt: {
        jobId: record.jobId,
        provider: id,
        adapterVersion,
        status: record.status,
        model: "emulator",
        startedAt: record.startedAt,
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        truncated: record.truncated,
        permissionDenials: 0,
        ...(record.requestSha256 ? { requestSha256: record.requestSha256 } : {}),
        ...(record.findings ? { findingsSha256: researchDigest(record.findings) } : {}),
      },
    };
  }
}
