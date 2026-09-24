import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  mountWebhookHttpRoutes,
  WEBHOOK_MAX_WAIT_SECONDS,
  WEBHOOK_SECRET_KIND,
  type WebhookDeps,
  webhookWaitSeconds,
} from "./webhook.js";

const SECRET = "webhook-outcome-secret-32chars!!";
const FAILURE = "402 This account is out of credit.";

type Run = { id: string; botId: string; spaceId: string; status: string; error: string | null };

/**
 * Real webhook routes over an in-memory bot, run, and steering store. A delivery starts a queued
 * run unless the bot is busy, in which case it steers the busy run like `sendUserMessage` does.
 * `onEnqueue` stands in for the worker that later settles the run.
 */
function createProduct(options: { busyRunId?: string; onEnqueue?: (run: Run) => void } = {}) {
  const runs = new Map<string, Run>();
  const steering = new Map<string, { runId: string | null }>();
  const addRun = (id: string, status = "queued", botId = "bot-1") => {
    const run = { id, botId, spaceId: "ws-1", status, error: null };
    runs.set(id, run);
    return run;
  };
  if (options.busyRunId) addRun(options.busyRunId, "running");

  let sent = 0;
  const sendUserMessage = vi.fn(async () => {
    sent += 1;
    const messageId = `msg-${sent}`;
    if (options.busyRunId) {
      steering.set(messageId, { runId: options.busyRunId });
      return { messageId, runId: options.busyRunId, seq: sent };
    }
    return { messageId, runId: addRun(`run-${sent}`).id, seq: sent };
  });
  const enqueue = vi.fn(async (job: { payload: { runId: string } }) => {
    options.onEnqueue?.(runs.get(job.payload.runId)!);
  });

  const deps: WebhookDeps = {
    prisma: {
      bot: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "bot-1" || where.id === "bot-2"
            ? {
                id: where.id,
                spaceId: "ws-1",
                userId: "user-1",
                webhookSecretId: `secret-${where.id}`,
                thread: { id: `thread-${where.id}` },
              }
            : null,
        ),
      },
      secret: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id,
          kind: WEBHOOK_SECRET_KIND,
          userId: "user-1",
          spaceId: "ws-1",
        })),
      },
      routine: { findMany: vi.fn(async () => []) },
      run: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string; botId: string; spaceId?: string } }) => {
            const run = runs.get(where.id);
            if (!run || run.botId !== where.botId) return null;
            if (where.spaceId && run.spaceId !== where.spaceId) return null;
            return { id: run.id, status: run.status, error: run.error };
          },
        ),
      },
      steeringMessage: {
        findUnique: vi.fn(
          async ({ where }: { where: { messageId_botId: { messageId: string } } }) =>
            steering.get(where.messageId_botId.messageId) ?? null,
        ),
      },
    } as unknown as WebhookDeps["prisma"],
    secrets: {
      load: (ciphertext: string) =>
        ciphertext === "secret-bot-1" ? SECRET : "another-bot-secret-32-characters",
    } as unknown as WebhookDeps["secrets"],
    events: { sendUserMessage },
    jobs: { enqueue } as unknown as WebhookDeps["jobs"],
  };
  const app = new Hono();
  mountWebhookHttpRoutes(app, deps);

  const deliver = (query = "", authorization = `Bearer ${SECRET}`) =>
    app.request(`/api/v1/bots/bot-1/webhook${query}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ event: "alert", text: "Needs attention." }),
    });
  const readRun = (runId: string, botId = "bot-1", authorization = `Bearer ${SECRET}`) =>
    app.request(`/api/v1/bots/${botId}/webhook/runs/${runId}`, { headers: { authorization } });

  return { runs, steering, addRun, sendUserMessage, enqueue, deliver, readRun };
}

function settleSoon(run: Run, status: string, error: string | null = null) {
  setTimeout(() => {
    run.status = status;
    run.error = error;
  }, 20);
}

describe("webhook delivery outcome", () => {
  it("keeps the default delivery an acceptance receipt, even when the run fails afterwards", async () => {
    const product = createProduct();

    const res = await product.deliver();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: "msg-1", runId: "run-1", seq: 1 });
    expect(product.runs.get("run-1")?.status).toBe("queued");
    expect(product.enqueue).toHaveBeenCalledTimes(1);

    // The worker fails the run after the caller already holds its 200.
    Object.assign(product.runs.get("run-1")!, { status: "failed", error: FAILURE });
    const read = await product.readRun("run-1");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ runId: "run-1", status: "failed", error: FAILURE });
  });

  it("answers a waiting delivery with 502 and the reason when its run fails", async () => {
    const product = createProduct({ onEnqueue: (run) => settleSoon(run, "failed", FAILURE) });

    const res = await product.deliver("?wait=5");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      messageId: "msg-1",
      runId: "run-1",
      seq: 1,
      status: "failed",
      error: FAILURE,
    });
  });

  it("answers a waiting delivery with 200 once its run completes", async () => {
    const product = createProduct({ onEnqueue: (run) => settleSoon(run, "completed") });

    const res = await product.deliver("?wait=5");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "completed", error: null });
  });

  it("answers 502 when the run is cancelled before it finishes", async () => {
    const product = createProduct({ onEnqueue: (run) => settleSoon(run, "cancelled") });

    const res = await product.deliver("?wait=5");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, status: "cancelled" });
  });

  it("stops waiting once the run needs the owner", async () => {
    const product = createProduct({ onEnqueue: (run) => settleSoon(run, "waiting_input") });

    const res = await product.deliver("?wait=5");

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run-1", status: "waiting_input" });
  });

  it("answers 202 with the run's current status when the wait ends first", async () => {
    const product = createProduct({
      onEnqueue: (run) => {
        run.status = "running";
      },
    });

    const started = Date.now();
    const res = await product.deliver("?wait=1");

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run-1", status: "running" });
  });

  it("follows a delivery the busy run hands to a follow-up run", async () => {
    const product = createProduct({ busyRunId: "run-busy" });
    // The busy run completes without claiming the delivery, so a follow-up run takes it and fails.
    setTimeout(() => {
      product.runs.get("run-busy")!.status = "completed";
      product.addRun("run-follow-up", "running");
      product.steering.set("msg-1", { runId: "run-follow-up" });
    }, 20);
    setTimeout(() => {
      Object.assign(product.runs.get("run-follow-up")!, { status: "failed", error: FAILURE });
    }, 40);

    const res = await product.deliver("?wait=5");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      messageId: "msg-1",
      runId: "run-follow-up",
      status: "failed",
      error: FAILURE,
    });
  });

  it.each(["0", "-1", "soon", "1.5", ""])("rejects wait=%j before delivering", async (wait) => {
    const product = createProduct();

    const res = await product.deliver(`?wait=${wait}`);

    expect(res.status).toBe(400);
    expect(product.sendUserMessage).not.toHaveBeenCalled();
    expect(product.enqueue).not.toHaveBeenCalled();
  });

  it("caps how long a delivery may wait", () => {
    expect(webhookWaitSeconds(undefined)).toBeUndefined();
    expect(webhookWaitSeconds("30")).toBe(30);
    expect(webhookWaitSeconds("600")).toBe(WEBHOOK_MAX_WAIT_SECONDS);
  });

  it("checks the bearer before reading a wait value", async () => {
    const product = createProduct();

    const res = await product.deliver("?wait=soon", "Bearer wrong-secret");

    expect(res.status).toBe(401);
  });
});

describe("webhook run status read", () => {
  it("requires the bot's webhook bearer", async () => {
    const product = createProduct();
    product.addRun("run-1", "failed");

    expect((await product.readRun("run-1", "bot-1", "Bearer wrong-secret")).status).toBe(401);
    expect((await product.readRun("run-1", "bot-1", "")).status).toBe(401);
    expect((await product.readRun("run-1", "missing-bot")).status).toBe(401);
  });

  it("only reads the bot's own runs", async () => {
    const product = createProduct();
    product.addRun("run-other", "failed", "bot-2");

    const res = await product.readRun("run-other");

    expect(res.status).toBe(404);
  });

  it("clamps a long failure reason like the thread view does", async () => {
    const product = createProduct();
    Object.assign(product.addRun("run-1"), { status: "failed", error: "x".repeat(400) });

    const body = (await (await product.readRun("run-1")).json()) as { error: string };

    expect(body.error).toHaveLength(301);
  });

  it("reports no reason for a run that has not failed", async () => {
    const product = createProduct();
    product.addRun("run-1", "running");

    expect(await (await product.readRun("run-1")).json()).toEqual({
      runId: "run-1",
      status: "running",
      error: null,
    });
  });
});
