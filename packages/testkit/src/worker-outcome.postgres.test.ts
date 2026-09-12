import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, createJobReconciler } from "@rakazo/adapters";
import { createDb, createThreadMessage } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/api/src/app.js";
import { createLogger, createTestSink, installLogger } from "../../logging/src/index.js";
import { sessionCookieHeader } from "./index.js";

const describeDatabase =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describeDatabase("worker outcome product recovery", () => {
  it("contains a real sequence conflict while an activated routine delegates and fires once", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-outcome-test-"));
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    // This journey needs no parallel SQL sessions; reserve one connection for the fixture.
    pool.options.max = 1;
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-worker", sinks: [sink] });
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({
        prisma,
        dataDir,
        agentRuntime: "scripted",
        sandboxProvider: "fake",
        wakeupDriver: "memory",
        composio: new ComposioEmulator(),
        logger,
      });
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `outcome-${Date.now()}@example.test`,
          password: "fixture-password-123",
          name: "Outcome fixture",
        }),
      });
      expect(signup.status).toBe(200);
      const cookie = sessionCookieHeader(signup);
      const rpc = async (procedure: string, input: unknown = {}) => {
        const response = await handles!.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body.json;
      };
      const createBot = (name: string) =>
        rpc("bots/create", { name, title: "", description: "", instructions: "" });
      const coordinator = await createBot("Coordinator");
      const peer = await createBot("Researcher");
      const broken = await createBot("ConflictFixture");
      await eventually(async () => {
        const active = await prisma.run.count({
          where: {
            botId: { in: [coordinator.id, peer.id, broken.id] },
            status: { in: ["queued", "running"] },
          },
        });
        return active === 0;
      });
      const brokenThread = await prisma.thread.findUniqueOrThrow({ where: { botId: broken.id } });
      const source = await createThreadMessage(prisma, {
        threadId: brokenThread.id,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: coordinator.id,
            fromBotName: "Coordinator",
            text: "Return the fixture result.",
            hop: 1,
            intent: "request",
          },
        ],
      });
      const task = await prisma.task.create({
        data: {
          spaceId: brokenThread.spaceId,
          userId: brokenThread.userId,
          botId: broken.id,
          threadId: brokenThread.id,
          prompt: "Return the fixture result.",
          status: "completed",
        },
      });
      const failedOutcome = await prisma.run.create({
        data: {
          spaceId: task.spaceId,
          userId: task.userId,
          botId: task.botId,
          threadId: task.threadId,
          taskId: task.id,
          trigger: "bot_message",
          status: "completed",
          sourceMessageId: source.id,
        },
      });
      // Reproduce the reported counter/row mismatch in this disposable database.
      await prisma.thread.update({
        where: { id: brokenThread.id },
        data: { nextMessageSeq: source.seq },
      });
      const reconciler = createJobReconciler({ prisma, jobs: handles.jobs });
      await reconciler.reconcileOnce();
      await eventually(async () => {
        const outcome = await prisma.run.findUnique({ where: { id: failedOutcome.id } });
        return Boolean(outcome?.botOutcomeFailedAt);
      });
      for (let tick = 0; tick < 10; tick++) await reconciler.reconcileOnce();
      const failureReceipt = await prisma.run.findUniqueOrThrow({
        where: { id: failedOutcome.id },
      });
      const errors = sink.events.filter(
        (event) => event.receipt === `bot-outcome:${failedOutcome.id}`,
      );
      expect(failureReceipt.botOutcomeAttempts).toBe(1);
      expect(failureReceipt.botOutcomeError).toBe("P2002");
      expect(failureReceipt.botOutcomeReturnedAt).toBeInstanceOf(Date);
      expect(failureReceipt.botOutcomeNextAttemptAt).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.prismaError).toMatchObject({ code: "P2002" });
      expect(
        await prisma.message.count({
          where: { clientNonce: `bot-message:auto-outcome:${failedOutcome.id}` },
        }),
      ).toBe(0);

      const routine = await rpc("routines/create", {
        botId: coordinator.id,
        name: "One fixture delegation",
        crons: ["@once"],
        prompt: "message the bot named Researcher saying summarize the fixture result",
        timezone: "UTC",
        active: false,
        notify: false,
      });
      expect(routine.active).toBe(false);
      const activated = await rpc("routines/update", {
        routineId: routine.id,
        active: true,
        runAt: new Date(Date.now() + 5_000).toISOString(),
      });
      expect(activated.active).toBe(true);
      expect(new Date(activated.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      await eventually(async () => {
        const fired = await prisma.run.findFirst({
          where: { routineId: routine.id, status: "completed" },
        });
        const returned = await prisma.run.findFirst({
          where: {
            botId: peer.id,
            trigger: "bot_message",
            status: "completed",
            botOutcomeReturnedAt: { not: null },
          },
        });
        return Boolean(fired && returned);
      });
      const paused = await rpc("routines/update", { routineId: routine.id, active: false });
      expect(paused.active).toBe(false);
      expect(paused.nextRunAt).toBeNull();
      expect(paused.lastRunAt).toBeTruthy();
      const fires = await prisma.run.findMany({ where: { routineId: routine.id } });
      expect(fires).toHaveLength(1);
      const delegated = await prisma.run.findFirstOrThrow({
        where: { botId: peer.id, trigger: "bot_message" },
      });
      expect(delegated.botOutcomeFailedAt).toBeNull();
      expect(delegated.botOutcomeError).toBeNull();
      const inbound = await prisma.message.findMany({
        where: { clientNonce: `bot-message:auto-outcome:${delegated.id}` },
      });
      const outbound = await prisma.message.findMany({
        where: { clientNonce: `bot-message-outbound:auto-outcome:${delegated.id}` },
      });
      expect(inbound).toHaveLength(1);
      expect(outbound).toHaveLength(1);
      const recipientWakes = await prisma.run.count({
        where: { sourceMessageId: inbound[0]!.id },
      });
      expect(recipientWakes).toBe(1);
      const thread = await rpc("threads/get", { botId: coordinator.id });
      const returnedMessages = thread.messages.filter(
        (message: { id: string }) => message.id === inbound[0]!.id,
      );
      expect(returnedMessages).toHaveLength(1);
      const finalFailure = await prisma.run.findUniqueOrThrow({ where: { id: failedOutcome.id } });
      expect(finalFailure.botOutcomeAttempts).toBe(1);
      expect(
        sink.events.filter((event) => event.receipt === `bot-outcome:${failedOutcome.id}`),
      ).toHaveLength(1);

      if (process.env.RAKAZO_TEST_EVIDENCE_DIR) {
        await mkdir(process.env.RAKAZO_TEST_EVIDENCE_DIR, { recursive: true });
        const receipt = {
          environment:
            "Disposable PostgreSQL fixture; scripted model and fake sandbox; no live systems",
          conflict: {
            runId: finalFailure.id,
            status: finalFailure.status,
            attempts: finalFailure.botOutcomeAttempts,
            error: finalFailure.botOutcomeError,
            failedAt: finalFailure.botOutcomeFailedAt,
            returnedAt: finalFailure.botOutcomeReturnedAt,
            nextAttemptAt: finalFailure.botOutcomeNextAttemptAt,
            diagnosticReceipts: errors.length,
            additionalReconciliationScans: 10,
          },
          routine: {
            id: routine.id,
            initiallyActive: routine.active,
            activated: { active: activated.active, nextRunAt: activated.nextRunAt },
            fires: fires.map((fire) => ({
              id: fire.id,
              status: fire.status,
              trigger: fire.trigger,
            })),
            paused: {
              active: paused.active,
              nextRunAt: paused.nextRunAt,
              lastRunAt: paused.lastRunAt,
            },
          },
          delegatedOutcome: {
            runId: delegated.id,
            status: delegated.status,
            returnedAt: delegated.botOutcomeReturnedAt,
            failedAt: delegated.botOutcomeFailedAt,
            inbound: inbound.map(({ id, clientNonce, blocks }) => ({ id, clientNonce, blocks })),
            outbound: outbound.map(({ id, clientNonce, blocks }) => ({ id, clientNonce, blocks })),
            recipientWakes,
          },
          threadResponse: { messages: returnedMessages },
        };
        await writeFile(
          path.join(process.env.RAKAZO_TEST_EVIDENCE_DIR, "worker-outcome-api-receipt.json"),
          JSON.stringify(receipt, null, 2),
        );
      }
    } finally {
      await handles?.stop();
      await prisma.$disconnect();
      await pool.end();
      await rm(dataDir, { recursive: true, force: true });
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });
});

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBe(true);
}
