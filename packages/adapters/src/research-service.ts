import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  ResearchProvider,
  ResearchReceipt,
  ResearchStartRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { researchPollJob } from "@rakazo/adapter-kit";
import type { ResearchBlock, ResearchStatus } from "@rakazo/contracts";
import { ResearchFindingsSchema, ResearchStatusSchema } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
  type PrismaClient,
  parseComputerMode,
  type ResearchJob,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  AntigravityResearchProvider,
  antigravityResearchSettingsSchema,
} from "./antigravity-research.js";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { researchStartRequestSchema } from "./research-request.js";
import {
  RESEARCH_DEFAULT_BUDGET_MS,
  researchIdSchema,
  researchStartSchema,
} from "./research-tools.js";

/** Findings larger than this reach the model as a summary with counts and the file path. */
export const RESEARCH_STATUS_MAX_BYTES = 48 * 1024;
export const RESEARCH_FINDINGS_FILE = "findings.json";
export const RESEARCH_REPORT_FILE = "report.md";

/** The composition root binds the one research adapter to the computer host. */
export interface ResearchConnection {
  /** Provider for one Space's stored settings; throws when the settings do not parse. */
  provider(settings: unknown): ResearchProvider;
}

/** Antigravity over the bot computer; null without a computer host, so tools stay uninjected. */
export function createResearchConnection(sandbox: SandboxProvider): ResearchConnection | null {
  if (sandbox.describe().id === "none") return null;
  return {
    provider: (settings) =>
      new AntigravityResearchProvider({
        sandbox,
        settings: antigravityResearchSettingsSchema.parse(settings),
      }),
  };
}

export interface ResearchDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  artifacts: ArtifactStore;
  research: ResearchConnection | null | undefined;
}

/** The Space's stored adapter settings, or null when research is not enabled there. */
export async function loadResearchSettings(
  prisma: Pick<PrismaClient, "spaceResearchSettings">,
  spaceId: string,
): Promise<unknown | null> {
  const row = await prisma.spaceResearchSettings.findUnique({
    where: { spaceId },
    select: { settings: true },
  });
  return row?.settings ?? null;
}

export function researchStatus(job: Pick<ResearchJob, "status">): ResearchStatus {
  const parsed = ResearchStatusSchema.safeParse(job.status);
  return parsed.success ? parsed.data : "uncertain";
}

export function researchBlock(job: Pick<ResearchJob, "id" | "title" | "status">): ResearchBlock {
  return { kind: "research", researchId: job.id, title: job.title, status: researchStatus(job) };
}

export function researchTerminal(status: string): boolean {
  return status !== "queued" && status !== "running";
}

export class ResearchComputerBusy extends Error {
  constructor() {
    super("A research job is already running on this computer.");
    this.name = "ResearchComputerBusy";
  }
}

type StartOutcome = { job: ResearchJob; seq?: number } | { error: string };

/** Queue an intent only after scope and owner checks. The worker owns the computer I/O. */
export async function executeResearchTool(
  deps: ResearchDeps,
  context: AdapterContext & { botId: string },
  run: { id: string; threadId: string },
  name: string,
  args: Record<string, unknown>,
) {
  if (!deps.research) return { error: "Research is not configured." };
  const settings = await loadResearchSettings(deps.prisma, context.spaceId);
  if (settings === null) return { error: "Research is not enabled for this space." };
  if (name === "research_start") {
    const outcome = await startResearch(deps, context, run, args);
    if ("error" in outcome) return outcome;
    if (outcome.seq !== undefined)
      await deps.events.notify(run.threadId, outcome.seq).catch(() => undefined);
    if (outcome.job.nextPollAt) await enqueueResearchJob(deps, outcome.job.id);
    return researchSnapshot(outcome.job);
  }
  const { researchId } = researchIdSchema.parse(args);
  const owned = await deps.prisma.researchJob.findFirst({
    where: { id: researchId, spaceId: context.spaceId, userId: context.userId },
  });
  if (!owned) return { error: "Unknown research job." };
  let job = owned;
  if (name === "research_cancel") {
    if (!researchTerminal(job.status) && !job.cancelRequested) {
      await deps.prisma.researchJob.update({
        where: { id: job.id },
        data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
      });
      job = await deps.prisma.researchJob.findUniqueOrThrow({ where: { id: job.id } });
      if (job.nextPollAt) await enqueueResearchJob(deps, job.id);
    }
    return researchSnapshot(job);
  }
  if (name !== "research_status") return { error: `Unknown research tool ${name}.` };
  return {
    ...researchSnapshot(job),
    ...(job.status === "completed" ? await researchFindingsResult(deps, context, job) : {}),
  };
}

async function startResearch(
  deps: ResearchDeps,
  context: AdapterContext & { botId: string },
  run: { id: string; threadId: string },
  args: Record<string, unknown>,
): Promise<StartOutcome> {
  const { depth, ...brief } = researchStartSchema.parse(args);
  try {
    return await deps.prisma.$transaction(async (tx): Promise<StartOutcome> => {
      // Serialize with clearThread before creating either the intent or its card.
      await tx.thread.update({
        where: { id: run.threadId, userId: context.userId, spaceId: context.spaceId },
        data: { unread: false },
      });
      const existing = await tx.researchJob.findUnique({
        where: { operationKey: context.operationId },
      });
      if (existing) return ownedResearchJob(existing, context);
      const bot = await tx.bot.findFirst({
        where: {
          id: context.botId,
          spaceId: context.spaceId,
          userId: context.userId,
          archivedAt: null,
        },
        select: { computer: { select: { id: true, scope: true } } },
      });
      if (!bot?.computer) return { error: "This bot has no computer." };
      const jobId = randomUUID();
      const request: ResearchStartRequest = researchStartRequestSchema.parse({
        jobId,
        workdir: resolveBotWorkspacePath(
          parseComputerMode(bot.computer.scope),
          context.botId,
          `research/${jobId}`,
        ),
        computerId: bot.computer.id,
        brief,
        depth,
        budgetMs: RESEARCH_DEFAULT_BUDGET_MS,
      });
      const created = await tx.researchJob.create({
        data: {
          id: jobId,
          operationKey: context.operationId,
          spaceId: context.spaceId,
          userId: context.userId,
          botId: context.botId,
          threadId: run.threadId,
          computerId: bot.computer.id,
          title: brief.title,
          request: request as unknown as Prisma.InputJsonValue,
        },
      });
      const blocks = [researchBlock(created)];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        role: "bot",
        blocks,
      });
      const saved = await tx.researchJob.update({
        where: { id: created.id },
        data: { messageId: message.id },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: run.id,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return { job: saved, seq: event.seq };
    });
  } catch (error) {
    if (!researchJobUniqueConflict(error)) throw error;
    const existing = await deps.prisma.researchJob.findUnique({
      where: { operationKey: context.operationId },
    });
    if (existing) return ownedResearchJob(existing, context);
    return {
      error: `${new ResearchComputerBusy().message} Wait for it to finish or cancel it first.`,
    };
  }
}

function ownedResearchJob(
  job: ResearchJob,
  context: Pick<AdapterContext, "spaceId" | "userId">,
): { job: ResearchJob } {
  if (job.spaceId !== context.spaceId || job.userId !== context.userId) {
    throw new Error("Research operation scope changed");
  }
  return { job };
}

const OPERATION_KEY_TARGETS = new Set(["operationKey", "research_jobs_operationKey_key"]);
const ACTIVE_COMPUTER_TARGETS = new Set(["computerId", "research_jobs_active_computer_key"]);

function uniqueConstraintFailed(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function uniqueConstraintNames(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("meta" in error)) return [];
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return [];
  const names: string[] = [];
  const target = "target" in meta ? meta.target : undefined;
  if (Array.isArray(target)) names.push(...target.map(String));
  else if (typeof target === "string") names.push(target);
  const constraint = "constraint" in meta ? meta.constraint : undefined;
  if (typeof constraint === "string") names.push(constraint);
  const driver = "driverAdapterError" in meta ? meta.driverAdapterError : undefined;
  if (!driver || typeof driver !== "object" || !("cause" in driver)) return names;
  const cause = driver.cause;
  if (!cause || typeof cause !== "object" || !("constraint" in cause)) return names;
  if (typeof cause.constraint === "string") names.push(cause.constraint);
  return names;
}

/** operationKey replay or the one-active-job index — not a message/event sequence conflict. */
function researchJobUniqueConflict(error: unknown): boolean {
  if (!uniqueConstraintFailed(error)) return false;
  const names = uniqueConstraintNames(error);
  if (names.length === 0) return true;
  return names.some((name) => OPERATION_KEY_TARGETS.has(name) || ACTIVE_COMPUTER_TARGETS.has(name));
}

export function researchSnapshot(job: ResearchJob) {
  const receipt = job.receipt as ResearchReceipt | null;
  return {
    researchId: job.id,
    title: job.title,
    status: researchStatus(job),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(receipt ? { receipt } : {}),
    ...(job.cancelRequested && !researchTerminal(job.status) ? { cancellationPending: true } : {}),
  };
}

/** Findings come back from the artifact the poller stored, never from the job row. */
async function researchFindingsResult(
  deps: Pick<ResearchDeps, "prisma" | "artifacts">,
  context: AdapterContext,
  job: ResearchJob,
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: { in: job.artifactIds },
      spaceId: job.spaceId,
      userId: job.userId,
      name: RESEARCH_FINDINGS_FILE,
    },
    select: { storageKey: true },
  });
  if (!row) return { error: "Findings are no longer available." };
  const bytes = await deps.artifacts.get(row.storageKey, context);
  const findings = ResearchFindingsSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (bytes.byteLength <= RESEARCH_STATUS_MAX_BYTES) return { findings };
  const request = job.request as unknown as ResearchStartRequest;
  return {
    summary: findings.summary,
    counts: {
      claims: findings.claims.length,
      sources: findings.sources.length,
      gaps: findings.gaps.length,
      applyNotes: findings.applyNotes.length,
    },
    findingsPath: `${request.workdir}/${RESEARCH_FINDINGS_FILE}`,
  };
}

/** The row is the outbox; queue failure leaves recoverable intent for the reconciler. */
export async function enqueueResearchJob(
  deps: Pick<ResearchDeps, "jobs">,
  jobId: string,
  availableAt?: Date,
) {
  await deps.jobs.enqueue(researchPollJob({ jobId }, availableAt)).catch(() => {
    getLogger().warn("research scheduling deferred to reconciliation");
  });
}

export async function reconcileResearchJobs(
  deps: Pick<ResearchDeps, "prisma" | "jobs" | "research">,
) {
  if (!deps.research) return;
  const due = await deps.prisma.researchJob.findMany({
    where: { nextPollAt: { lte: new Date() } },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const job of due) await enqueueResearchJob(deps, job.id);
}
