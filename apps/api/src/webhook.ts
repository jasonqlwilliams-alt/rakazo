import { setTimeout as delay } from "node:timers/promises";
import { hasValidBearerToken, runFailureError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import { mountGithubWebhookRoute } from "./github-webhook.js";
import { readBoundedBody } from "./http-body.js";
import {
  deliverWebhookEvent,
  formatWebhookPrompt,
  loadWebhookTarget,
  parseWebhookPayload,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookDeps,
} from "./webhook-inbound.js";

export {
  formatGithubEventPrompt,
  githubEventName,
  githubWebhookPath,
  hasValidGithubSignature,
} from "./github-webhook.js";
export {
  formatUntrustedDeliveryPayload,
  formatWebhookPrompt,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_SECRET_KIND,
  type WebhookDeps,
  type WebhookEvents,
  type WebhookTarget,
} from "./webhook-inbound.js";

/** Longest a delivery may hold its request open for the run's outcome (`?wait=<seconds>`). */
export const WEBHOOK_MAX_WAIT_SECONDS = 60;
const WEBHOOK_WAIT_POLL_MS = 500;
/** A run in these states is still working on its own; any other state answers the caller. */
const WORKING_RUN_STATUSES = new Set(["queued", "leased", "running"]);

export function webhookPath(botId: string): string {
  return `/api/v1/bots/${botId}/webhook`;
}

/** Seconds a delivery asked to wait: undefined when it did not ask, null when the value is invalid. */
export function webhookWaitSeconds(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) return null;
  return Math.min(Number(value), WEBHOOK_MAX_WAIT_SECONDS);
}

type WebhookRunOutcome = { runId: string | null; status: string; error: string | null };

function webhookRunOutcome(run: {
  id: string;
  status: string;
  error: string | null;
}): WebhookRunOutcome {
  return {
    runId: run.id,
    status: run.status,
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : null,
  };
}

/** 200 once the run completed, 502 when it failed or was cancelled, 202 while it has not finished. */
function webhookOutcomeHttpStatus(status: string): 200 | 202 | 502 {
  if (status === "completed") return 200;
  if (status === "failed" || status === "cancelled") return 502;
  return 202;
}

/**
 * Poll the run answering a delivered message until it stops working on its own or the wait ends.
 * A delivery that arrives while the bot is busy steers the active run, and that run can hand the
 * message to a follow-up run, so follow the message rather than the first run id.
 */
async function waitForWebhookDelivery(
  prisma: PrismaClient,
  botId: string,
  delivery: { messageId: string; runId: string | null },
  waitMs: number,
  signal: AbortSignal,
): Promise<WebhookRunOutcome> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const steering = await prisma.steeringMessage.findUnique({
      where: { messageId_botId: { messageId: delivery.messageId, botId } },
      select: { runId: true },
    });
    const runId = steering ? steering.runId : delivery.runId;
    const run = runId
      ? await prisma.run.findFirst({
          where: { id: runId, botId },
          select: { id: true, status: true, error: true },
        })
      : null;
    const outcome = run ? webhookRunOutcome(run) : { runId, status: "queued", error: null };
    const remaining = deadline - Date.now();
    if (!WORKING_RUN_STATUSES.has(outcome.status) || remaining <= 0 || signal.aborted) {
      return outcome;
    }
    await delay(Math.min(WEBHOOK_WAIT_POLL_MS, remaining), undefined, { signal }).catch(
      () => undefined,
    );
  }
}

export function mountWebhookHttpRoutes(app: Hono, deps: WebhookDeps) {
  app.post("/api/v1/bots/:botId/webhook", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);

    // Reject oversized bodies before target lookup so size limits do not reveal active bots.
    const raw = await readBoundedBody(c.req.raw, WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    const target = await loadWebhookTarget(deps, c.req.param("botId"));

    // Same 401 for missing bot, missing secret, and bad bearer so bot ids are not enumerable.
    if (!target || !hasValidBearerToken(c.req.header("authorization"), target.expected)) {
      return unauthorized();
    }

    const wait = webhookWaitSeconds(c.req.query("wait"));
    if (wait === null) {
      return c.json({ error: "Invalid wait" }, 400);
    }

    const payload = parseWebhookPayload(raw, c.req.header("content-type"));
    const eventPrompt = formatWebhookPrompt(payload);

    const webhookRoutines = await deps.prisma.routine.findMany({
      where: {
        botId: target.bot.id,
        spaceId: target.bot.spaceId,
        active: true,
        webhookEnabled: true,
      },
      select: { id: true, name: true, prompt: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });

    const idempotencyKey =
      c.req.header("idempotency-key")?.trim() ||
      c.req.header("x-idempotency-key")?.trim() ||
      (typeof payload.id === "string" ? payload.id.trim() : "") ||
      (typeof payload.event_id === "string" ? payload.event_id.trim() : "") ||
      undefined;

    const delivered = await deliverWebhookEvent(deps, target, {
      prompt: eventPrompt,
      routines: webhookRoutines,
      source: "webhook",
      idempotencyKey,
      routineId: webhookRoutines.length === 1 ? webhookRoutines[0]!.id : undefined,
    });
    // Without a wait the 200 only means the delivery was accepted and its run queued.
    if (wait === undefined) return c.json(delivered);

    const outcome = await waitForWebhookDelivery(
      deps.prisma,
      target.bot.id,
      delivered,
      wait * 1000,
      c.req.raw.signal,
    );
    const status = webhookOutcomeHttpStatus(outcome.status);
    return c.json({ ...delivered, ...outcome, ok: status !== 502 }, status);
  });

  app.get("/api/v1/bots/:botId/webhook/runs/:runId", async (c) => {
    const target = await loadWebhookTarget(deps, c.req.param("botId"));
    if (!target || !hasValidBearerToken(c.req.header("authorization"), target.expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const run = await deps.prisma.run.findFirst({
      where: { id: c.req.param("runId"), botId: target.bot.id, spaceId: target.bot.spaceId },
      select: { id: true, status: true, error: true },
    });
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(webhookRunOutcome(run));
  });

  mountGithubWebhookRoute(app, deps);
}
