import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentHomeStore,
  BackgroundJobPayloads,
  ComputerRef,
  ResearchObservation,
  ResearchProvider,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock, ResearchErrorCode, ResearchFindings } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  type Prisma,
  type ResearchJob,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { renderResearchReport } from "./antigravity-research.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { ComputerBusyError, provisionComputer, toComputerRef } from "./computer-lifecycle.js";
import { researchStartRequestSchema } from "./research-request.js";
import {
  enqueueResearchJob,
  loadResearchSettings,
  RESEARCH_FINDINGS_FILE,
  RESEARCH_REPORT_FILE,
  type ResearchDeps,
  researchBlock,
  researchTerminal,
} from "./research-service.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

export interface ResearchPollDeps extends ResearchDeps {
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  events: ThreadEvents;
  dataDir?: string;
}

const LEASE_MS = 90_000;
/** Observe every 15 s while the job is young, then every 60 s. */
const POLL_FAST_MS = 15_000;
const POLL_SLOW_MS = 60_000;
const POLL_FAST_WINDOW_MS = 2 * 60_000;
/** Time past the budget before the harness cancels a still-running job and ends it timed out. */
export const RESEARCH_BUDGET_GRACE_MS = 2 * 60_000;
/** A start that cannot reach the computer this many times in a row ends unavailable. */
export const RESEARCH_MAX_LAUNCH_ERRORS = 8;
/** A running job whose computer stays unreachable this long past its deadline ends uncertain. */
export const RESEARCH_OBSERVE_GIVE_UP_MS = 10 * 60_000;

type JobUpdate = Prisma.ResearchJobUpdateManyMutationInput;

/** Reconcile one persisted research job. A fenced lease serializes computer I/O. */
export async function pollResearchJob(
  deps: ResearchPollDeps,
  payload: BackgroundJobPayloads["research.poll"],
) {
  const connection = deps.research;
  if (!connection) return;
  const stored = await deps.prisma.researchJob.findUnique({ where: { id: payload.jobId } });
  if (!stored?.nextPollAt) return;
  const token = randomUUID();
  const claimed = await deps.prisma.researchJob.updateMany({
    where: {
      id: stored.id,
      version: stored.version,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (!claimed.count) return;
  const job = { ...stored, leaseToken: token };
  if (researchTerminal(job.status)) {
    // A stale wake for a finished job: no computer I/O, and nothing left to schedule.
    await deps.prisma.researchJob.updateMany({
      where: { id: job.id, leaseToken: token },
      data: { nextPollAt: null, leaseToken: null, leaseExpiresAt: null },
    });
    return;
  }
  const context: AdapterContext = {
    operationId: job.id,
    traceId: job.id,
    spaceId: job.spaceId,
    userId: job.userId,
    botId: job.botId,
    signal: AbortSignal.timeout(60_000),
  };
  try {
    const [card, member, bot, settings] = await Promise.all([
      deps.prisma.message.findFirst({
        where: { id: job.messageId ?? "", threadId: job.threadId },
        select: { id: true },
      }),
      deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: job.spaceId, userId: job.userId } },
        select: { id: true },
      }),
      deps.prisma.bot.findFirst({
        where: { id: job.botId, spaceId: job.spaceId, userId: job.userId, archivedAt: null },
        select: { id: true },
      }),
      loadResearchSettings(deps.prisma, job.spaceId),
    ]);
    const abandoned = !card || !member || !bot;
    if ((abandoned || job.cancelRequested) && !job.launchDispatched) {
      // Cancel before launch never touches the computer.
      await finishPoll(deps, job, { status: "cancelled", cancelRequested: false }, abandoned);
      return;
    }
    let provider: ResearchProvider;
    try {
      if (settings === null) throw new Error("research disabled for this space");
      provider = connection.provider(settings);
    } catch {
      await finishPoll(deps, job, unreachable(job), abandoned);
      return;
    }
    const computer = await resolveComputer(deps, job, context);
    if (!computer) {
      await finishPoll(deps, job, unreachable(job), abandoned);
      return;
    }
    const request = researchStartRequestSchema.parse(job.request);
    if (!job.launchDispatched) {
      // Write dispatch intent before I/O; from here a cancel must go to the computer.
      const startedAt = new Date();
      const marked = await deps.prisma.researchJob.updateMany({
        where: fence(job),
        data: {
          launchDispatched: true,
          startedAt,
          deadlineAt: new Date(startedAt.getTime() + request.budgetMs + RESEARCH_BUDGET_GRACE_MS),
        },
      });
      if (!marked.count) return;
    }
    if (abandoned || job.cancelRequested) {
      const observation = await provider.cancel(computer, request, context);
      // A provider with no trace of a job that was never seen running has nothing to stop.
      await settle(
        deps,
        job,
        observation.status === "uncertain" && job.status === "queued"
          ? {
              ...observation,
              status: "cancelled",
              receipt: { ...observation.receipt, status: "cancelled" },
            }
          : observation,
        abandoned,
      );
      return;
    }
    if (job.status === "queued") {
      // Every provider's start is idempotent per job id, so a lost response replays it.
      const observation = await provider.start(computer, request, context);
      await settle(deps, job, observation, abandoned);
      return;
    }
    const observation = await provider.observe(computer, request, context);
    if (observation.status === "running" && job.deadlineAt && job.deadlineAt < new Date()) {
      // The provider had its own chance to time out; past the harness deadline, stop the spend.
      const cancelled = await provider.cancel(computer, request, context);
      await settle(
        deps,
        job,
        cancelled.status === "running"
          ? cancelled
          : {
              ...cancelled,
              status: "timed_out",
              receipt: { ...cancelled.receipt, status: "timed_out", truncated: true },
            },
        abandoned,
      );
      return;
    }
    await settle(deps, job, observation, abandoned);
  } catch (error) {
    // Computer output and provider text never enter logs, cards, or model context.
    getLogger().warn("research job operation deferred to reconciliation", {
      transient: error instanceof ComputerBusyError,
    });
    await retryPoll(deps, job);
  } finally {
    // A concurrent cancel can change version while computer I/O is in flight.
    // Release only our lease, preserving that action's pending intent and due date.
    await deps.prisma.researchJob.updateMany({
      where: { id: job.id, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

function fence(job: ResearchJob) {
  return { id: job.id, version: job.version, leaseToken: job.leaseToken };
}

/** A job never seen running fails as unavailable; one seen running whose fate is unknown is uncertain. */
function unreachable(job: ResearchJob): JobUpdate {
  return job.status === "queued"
    ? {
        status: "failed",
        errorCode: "unavailable" satisfies ResearchErrorCode,
        cancelRequested: false,
      }
    : { status: "uncertain", cancelRequested: false };
}

/**
 * The bot computer as the provider sees it. A running computer is used as-is; a
 * stopped or suspended one is provisioned without any run or execution lease,
 * exactly as the idle sleeper reads it. Null when the computer row is gone.
 */
async function resolveComputer(
  deps: ResearchPollDeps,
  job: ResearchJob,
  context: AdapterContext,
): Promise<ComputerRef | null> {
  const computer = await deps.prisma.computer.findUnique({ where: { id: job.computerId } });
  if (!computer) return null;
  if (computer.state === "running" && computer.providerRef) return toComputerRef(computer);
  const ref = await provisionComputer(deps, computer.id, context);
  scheduleComputerSleep(deps.jobs, computer.id);
  return ref;
}

async function settle(
  deps: ResearchPollDeps,
  job: ResearchJob,
  observation: ResearchObservation,
  abandoned: boolean,
) {
  const receipt = observation.receipt as unknown as Prisma.InputJsonValue;
  if (observation.status === "running") {
    await finishPoll(deps, job, { status: "running", receipt }, abandoned);
    return;
  }
  if (observation.status !== "completed" || abandoned) {
    await finishPoll(
      deps,
      job,
      {
        status: observation.status,
        errorCode: observation.errorCode ?? null,
        receipt,
        cancelRequested: false,
      },
      abandoned,
    );
    return;
  }
  if (!observation.findings) {
    await finishPoll(
      deps,
      job,
      { status: "failed", errorCode: "invalid_output", receipt, cancelRequested: false },
      abandoned,
    );
    return;
  }
  const attached = await attachFindings(deps, job, observation.findings);
  const committed = await finishPoll(
    deps,
    job,
    {
      status: "completed",
      errorCode: null,
      receipt,
      artifactIds: attached.map((file) => file.artifactId),
      cancelRequested: false,
    },
    abandoned,
    attached.map((file) => file.block),
  );
  // Fenced out, or the owner lost the thread while the computer answered: keep nothing.
  if (!committed || committed.detached)
    await discardArtifacts(
      deps,
      attached.map((file) => file.artifactId),
      job,
    );
}

/** findings.json and report.md go through the one ArtifactStore and Artifact table. */
async function attachFindings(
  deps: ResearchPollDeps,
  job: ResearchJob,
  findings: ResearchFindings,
) {
  const card = await deps.prisma.message.findFirst({
    where: { id: job.messageId ?? "", threadId: job.threadId },
    select: { runId: true, thread: { select: { groupId: true } } },
  });
  const encoder = new TextEncoder();
  const files = [
    { name: RESEARCH_FINDINGS_FILE, bytes: encoder.encode(JSON.stringify(findings, null, 2)) },
    { name: RESEARCH_REPORT_FILE, bytes: encoder.encode(renderResearchReport(findings)) },
  ];
  const attached: Awaited<ReturnType<typeof attachWorkspaceFileToThread>>[] = [];
  try {
    for (const file of files) {
      attached.push(
        await attachWorkspaceFileToThread(deps, {
          spaceId: job.spaceId,
          userId: job.userId,
          botId: job.botId,
          groupId: card?.thread.groupId ?? undefined,
          runId: card?.runId ?? undefined,
          filePath: file.name,
          bytes: file.bytes,
          operationId: `research:${job.id}`,
        }),
      );
    }
  } catch (error) {
    await discardArtifacts(
      deps,
      attached.map((file) => file.artifactId),
      job,
    );
    throw error;
  }
  return attached;
}

async function discardArtifacts(deps: ResearchPollDeps, ids: string[], job: ResearchJob) {
  if (ids.length === 0) return;
  const context: AdapterContext = {
    operationId: `research:${job.id}`,
    traceId: `research:${job.id}`,
    spaceId: job.spaceId,
    userId: job.userId,
    botId: job.botId,
    signal: new AbortController().signal,
  };
  const rows = await deps.prisma.artifact.findMany({
    where: { id: { in: ids }, spaceId: job.spaceId },
    select: { id: true, storageKey: true },
  });
  for (const row of rows) {
    await deps.artifacts.remove(row.storageKey, context).catch(() => undefined);
  }
  await deps.prisma.artifact.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
}

async function retryPoll(deps: ResearchPollDeps, job: ResearchJob) {
  const errorCount = job.errorCount + 1;
  if (job.status === "queued" && errorCount >= RESEARCH_MAX_LAUNCH_ERRORS) {
    await finishPoll(deps, job, unreachable(job));
    return;
  }
  if (
    job.status === "running" &&
    job.deadlineAt &&
    Date.now() > job.deadlineAt.getTime() + RESEARCH_OBSERVE_GIVE_UP_MS
  ) {
    await finishPoll(deps, job, unreachable(job));
    return;
  }
  const nextPollAt = new Date(
    Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(job.errorCount, 4)),
  );
  const saved = await deps.prisma.researchJob.updateMany({
    where: fence(job),
    data: {
      nextPollAt,
      errorCount: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (saved.count) await enqueueResearchJob(deps, job.id, nextPollAt);
}

function nextObserveAt(job: ResearchJob): Date {
  const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
  return new Date(Date.now() + (elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS));
}

/**
 * Persist one observation: the row, the card, and on a terminal status the single
 * wake run, in one transaction fenced on the lease. Returns null when fenced out.
 */
async function finishPoll(
  deps: ResearchPollDeps,
  job: ResearchJob,
  data: JobUpdate,
  abandoned = false,
  fileBlocks: MessageBlock[] = [],
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then message/run changes.
    const thread = await tx.thread.updateMany({
      where: { id: job.threadId, spaceId: job.spaceId, userId: job.userId },
      data: { nextEventSeq: { increment: 0 } },
    });
    const message = thread.count
      ? await tx.message.findFirst({ where: { id: job.messageId ?? "", threadId: job.threadId } })
      : null;
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: job.spaceId, userId: job.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: job.botId, spaceId: job.spaceId, userId: job.userId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    const detached = abandoned || !message || !member || !bot;
    const status = typeof data.status === "string" ? data.status : job.status;
    const terminal = researchTerminal(status);
    const cancelRequested =
      !terminal && (detached || data.cancelRequested === true || job.cancelRequested);
    const nextPollAt = terminal ? null : nextObserveAt(job);
    const updated = await tx.researchJob.updateMany({
      where: fence(job),
      data: {
        ...data,
        ...(detached ? { artifactIds: [] } : {}),
        cancelRequested,
        nextPollAt,
        errorCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return null;
    const saved = await tx.researchJob.findUniqueOrThrow({ where: { id: job.id } });
    let seq: number | undefined;
    let wakeRunId: string | undefined;
    if (message && !detached) {
      const nextBlock = researchBlock(saved);
      const current = message.blocks as MessageBlock[];
      const present = new Set(
        current.flatMap((block) => (block.kind === "file" ? [block.artifactId] : [])),
      );
      const addedFiles = fileBlocks.filter(
        (block) => block.kind === "file" && !present.has(block.artifactId),
      );
      const prior = current.find(
        (block): block is Extract<MessageBlock, { kind: "research" }> =>
          block.kind === "research" && block.researchId === job.id,
      );
      const researchChanged =
        !prior ||
        prior.title !== nextBlock.title ||
        prior.status !== nextBlock.status ||
        prior.errorCode !== nextBlock.errorCode;
      const blocks = [
        ...current.map((block) =>
          block.kind === "research" && block.researchId === job.id ? nextBlock : block,
        ),
        ...addedFiles,
      ];
      if (researchChanged || addedFiles.length > 0) {
        await tx.message.update({
          where: { id: message.id },
          data: { blocks: blocks as unknown as Prisma.InputJsonValue },
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: job.spaceId,
          threadId: job.threadId,
          botId: job.botId,
          type: "thread.research",
          payload: {
            messageId: message.id,
            ...nextBlock,
            ...(addedFiles.length > 0 ? { files: addedFiles } : {}),
          },
        });
        seq = event.seq;
      }
      if (terminal && !saved.wakeRunId) {
        // Provider text is untrusted. Wake with local identity and status only.
        const summary = `Research ${job.id} is ${status}. Use research_status to read it.`;
        const task = await tx.task.create({
          data: {
            spaceId: job.spaceId,
            botId: job.botId,
            threadId: job.threadId,
            userId: job.userId,
            prompt: summary,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: job.spaceId,
            botId: job.botId,
            threadId: job.threadId,
            userId: job.userId,
            taskId: task.id,
            status: "queued",
            trigger: "research",
            clientNonce: `research-wake-run:${job.id}`,
          },
        });
        await tx.researchJob.update({ where: { id: job.id }, data: { wakeRunId: run.id } });
        wakeRunId = run.id;
      }
    }
    return { seq, wakeRunId, nextPollAt, detached };
  });
  if (!committed) return null;
  if (committed.seq !== undefined)
    await deps.events.notify(job.threadId, committed.seq).catch(() => undefined);
  if (committed.wakeRunId) {
    // The existing run reconciler recovers a queued wake after an enqueue failure.
    await deps.jobs.enqueue(runContinueJob(committed.wakeRunId)).catch(() => {
      getLogger().warn("research wake deferred to reconciliation");
    });
  }
  if (committed.nextPollAt) await enqueueResearchJob(deps, job.id, committed.nextPollAt);
  return committed;
}
