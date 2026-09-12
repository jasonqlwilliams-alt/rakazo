import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { returnBotMessageOutcome } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";
import { isUserProgressClientNonce } from "./user-progress.js";

const MAX_ATTEMPTS = 3;
// A crashed worker consumes its attempt; another worker may recover after this lease.
const ATTEMPT_LEASE_MS = 5 * 60_000;

type OutcomeDeps = Pick<ExecutorDeps, "prisma" | "jobs" | "events">;

/** Runs on the existing run.continue queue; a durable budget survives queue replacement. */
export async function reconcileBotMessageOutcome(deps: OutcomeDeps, runId: string) {
  const now = new Date();
  const run = await deps.prisma.run.findFirst({
    where: {
      id: runId,
      trigger: "bot_message",
      status: { in: ["completed", "failed"] },
      botOutcomeReturnedAt: null,
      botOutcomeFailedAt: null,
      OR: [{ botOutcomeNextAttemptAt: null }, { botOutcomeNextAttemptAt: { lte: now } }],
    },
    include: { bot: { select: { name: true } } },
  });
  if (!run) return;
  const pending = {
    id: run.id,
    botOutcomeReturnedAt: null,
    botOutcomeFailedAt: null,
    botOutcomeAttempts: run.botOutcomeAttempts,
    botOutcomeNextAttemptAt: run.botOutcomeNextAttemptAt,
  };
  if (run.botOutcomeAttempts >= MAX_ATTEMPTS) {
    // The last worker died after claiming its final attempt.
    if (!run.botOutcomeError) await recordFailure(deps, run.id, "attempts_exhausted");
    await deps.prisma.run.updateMany({
      where: pending,
      data: { botOutcomeFailedAt: now, botOutcomeReturnedAt: now, botOutcomeNextAttemptAt: null },
    });
    return;
  }
  const attempt = run.botOutcomeAttempts + 1;
  const claimed = await deps.prisma.run.updateMany({
    where: pending,
    data: {
      botOutcomeAttempts: { increment: 1 },
      botOutcomeNextAttemptAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
    },
  });
  if (!claimed.count) return;
  let failure = "delivery_rejected";
  let deliveryError: unknown;
  try {
    const transcript =
      run.status === "failed"
        ? { text: "", progressOnly: false }
        : await botRunOutcomeText(deps.prisma, run.id);
    const text =
      run.status === "failed"
        ? `Could not complete the delegated request: ${run.error ?? "unknown error"}`
        : transcript.text || "The delegated bot completed its turn without a written summary.";
    const intent =
      run.status === "failed" || !transcript.text.trim() || transcript.progressOnly
        ? "status"
        : "result";
    if (
      await returnBotMessageOutcome(deps, run, { id: run.botId, name: run.bot.name }, text, intent)
    )
      return;
  } catch (error) {
    // Store a diagnostic category, never Prisma's query/input dump or peer content.
    failure = databaseErrorCode(error);
    deliveryError = error;
  }
  if (!run.botOutcomeError) await recordFailure(deps, run.id, failure, deliveryError);
  // A unique conflict without either delivery receipt is not proof of delivery.
  // Repeating it cannot advance a rolled-back sequence counter; skip with a receipt.
  const exhausted = failure === "P2002" || attempt >= MAX_ATTEMPTS;
  const nextAttemptAt = new Date(Date.now() + 30_000 * 2 ** (attempt - 1));
  const updated = await deps.prisma.run.updateMany({
    where: {
      id: run.id,
      botOutcomeReturnedAt: null,
      botOutcomeFailedAt: null,
      botOutcomeAttempts: attempt,
    },
    data: {
      botOutcomeNextAttemptAt: exhausted ? null : nextAttemptAt,
      botOutcomeFailedAt: exhausted ? new Date() : null,
      ...(exhausted ? { botOutcomeReturnedAt: new Date() } : {}),
    },
  });
  if (updated.count && !exhausted) {
    // If enqueue fails, the leader's due scan repairs the wake; the budget stays spent.
    await deps.jobs.enqueue({ ...runContinueJob(run.id), availableAt: nextAttemptAt });
  }
}

async function recordFailure(deps: OutcomeDeps, runId: string, code: string, error?: unknown) {
  const recorded = await deps.prisma.run.updateMany({
    where: { id: runId, botOutcomeError: null, botOutcomeReturnedAt: null },
    data: { botOutcomeError: code },
  });
  if (recorded.count) {
    getLogger().error("bot message outcome reconciliation failed", error ?? {}, {
      receipt: `bot-outcome:${runId}`,
      code,
      // Copy Error's non-enumerable fields too. The logger applies normal secret
      // redaction, without truncating the diagnostic or dropping Prisma code/meta.
      prismaError:
        error && typeof error === "object"
          ? Object.fromEntries(
              Object.getOwnPropertyNames(error).map((key) => [key, Reflect.get(error, key)]),
            )
          : error,
    });
  }
}

function databaseErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^P[0-9]{4}$/.test(error.code)
  )
    return error.code;
  return "delivery_error";
}

/** Prefer the full bot transcript for a run so interim progress is not mistaken for the sole result. */
async function botRunOutcomeText(
  prisma: {
    message: {
      findMany: (args: {
        where: { runId: string; role: "bot" };
        orderBy: { seq: "asc" };
        select: { blocks: true; clientNonce: true };
      }) => Promise<Array<{ blocks: unknown; clientNonce: string | null }>>;
    };
  },
  runId: string,
): Promise<{ text: string; progressOnly: boolean }> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  const progressParts: string[] = [];
  const finalParts: string[] = [];
  for (const message of messages) {
    const text = messageText(message.blocks);
    if (!text) continue;
    if (isUserProgressClientNonce(message.clientNonce)) progressParts.push(text);
    else finalParts.push(text);
  }
  // Prefer the latest non-progress reply when present so earlier untagged mid-run
  // publishes (for example pre-takeover narration) do not contaminate the result.
  // Progress-only turns still join progress beats as status.
  if (finalParts.length > 0) {
    return { text: finalParts[finalParts.length - 1]!, progressOnly: false };
  }
  return { text: progressParts.join("\n\n"), progressOnly: progressParts.length > 0 };
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as MessageBlock[])
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
