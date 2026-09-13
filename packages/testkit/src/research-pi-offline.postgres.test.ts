import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { researchPollJob } from "@rakazo/adapter-kit";
import {
  ComposioEmulator,
  EMULATOR_RESEARCH_FINDINGS,
  EmulatorResearchProvider,
  type ResearchConnection,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

const researchToolNames = ["research_start", "research_status", "research_cancel"];
const toolNames = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const lastToolResult = (request: ModelEmulatorRequest) =>
  request.messages.findLast((message) => message.role === "tool");
const startArgs = { title: "Pricing survey", goal: "Compare vendor pricing pages" };

describe.skipIf(!databaseAvailable)("offline Pi research journey", () => {
  it("starts research behind approval, runs it on the computer, wakes once, and remembers from the wake run", async () => {
    const fixtureKey = "offline-research-fixture-key";
    const startPendingId = `start-pending-${randomUUID()}`;
    const startApprovedId = `start-approved-${randomUUID()}`;
    const statusReadId = `status-read-${randomUUID()}`;
    const rememberId = `remember-summary-${randomUUID()}`;
    let researchId = "";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          // Research is not enabled for the space yet: no research tool is offered.
          expect(request) {
            const names = toolNames(request);
            for (const name of researchToolNames) expect(names).not.toContain(name);
          },
          response: { type: "text", text: "Hello." },
        },
        {
          expect(request) {
            expect(toolNames(request)).toEqual(expect.arrayContaining(researchToolNames));
          },
          response: {
            type: "tool",
            id: startPendingId,
            name: "research_start",
            arguments: startArgs,
          },
        },
        {
          // Resumed after the owner approved; the executor restores the approved brief.
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Pricing survey");
          },
          response: {
            type: "tool",
            id: startApprovedId,
            name: "research_start",
            arguments: { ...startArgs, goal: "An unapproved replacement goal" },
          },
        },
        {
          expect(request) {
            const result = lastToolResult(request);
            expect(result?.tool_call_id).toBe(startApprovedId);
            const body = JSON.parse(String(result?.content));
            expect(body).toMatchObject({ title: "Pricing survey", status: "queued" });
            researchId = body.researchId;
          },
          response: { type: "text", text: "Research started." },
        },
        {
          // The wake run carries only local identity and status, never provider text.
          expect(request) {
            const prompt = JSON.stringify(request.messages);
            expect(prompt).toContain(`Research ${researchId} is completed.`);
            expect(prompt).not.toContain(EMULATOR_RESEARCH_FINDINGS.summary);
            expect(prompt).toContain("[research: Pricing survey - completed]");
          },
          response: () => ({
            type: "tool",
            id: statusReadId,
            name: "research_status",
            arguments: { researchId },
          }),
        },
        {
          expect(request) {
            const result = lastToolResult(request);
            expect(result?.tool_call_id).toBe(statusReadId);
            expect(JSON.parse(String(result?.content))).toMatchObject({
              status: "completed",
              findings: EMULATOR_RESEARCH_FINDINGS,
            });
          },
          response: {
            type: "tool",
            id: rememberId,
            name: "remember",
            arguments: { content: `Pricing survey: ${EMULATOR_RESEARCH_FINDINGS.summary}` },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(lastToolResult(request)?.content))).toMatchObject({
              ok: true,
            });
          },
          response: { type: "text", text: "Remembered the findings." },
        },
      ],
    });
    const emulator = new EmulatorResearchProvider({ autoCompleteAfterObservations: null });
    const research: ResearchConnection = { provider: () => emulator };
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-research-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        research,
        encryptionKey: "offline-research-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-research-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Research fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Research fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const waitForRun = async (runId: string, status: string) => {
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
              if (run.status === "failed") {
                model.assertComplete();
                throw new Error(`run failed: ${run.error}`);
              }
              return run.status;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBe(status);
      };

      const hello = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Hello.",
      });
      await waitForRun(hello.runId, "completed");

      await handles.prisma.spaceResearchSettings.create({
        data: { spaceId: storedBot.spaceId, userId: storedBot.userId, settings: {} },
      });
      // research_start is consequential like cloud_agent_launch: an owner rule makes it ask.
      await handles.prisma.actionApprovalRule.create({
        data: {
          spaceId: storedBot.spaceId,
          createdByUserId: storedBot.userId,
          effect: "require_approval",
          matchKind: "tool",
          matchValue: "research_start",
        },
      });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Research vendor pricing.",
      });
      await waitForRun(sent.runId, "waiting_input");
      expect(emulator.jobs.size).toBe(0);
      expect(await handles.prisma.researchJob.count({ where: { botId: bot.id } })).toBe(0);
      const ask = await handles.prisma.message.findFirstOrThrow({
        where: { runId: sent.runId, role: "bot" },
        orderBy: { seq: "desc" },
      });
      expect(ask.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "ask", approvalEffectId: expect.any(String) }),
        ]),
      );
      await rpc(handles.app, cookie, "threads/answer", {
        botId: bot.id,
        runId: sent.runId,
        messageId: ask.id,
        answer: "allow",
      });
      await waitForRun(sent.runId, "completed");
      const job = await handles.prisma.researchJob.findFirstOrThrow({ where: { botId: bot.id } });
      expect(job.id).toBe(researchId);
      expect(job.request as object).toMatchObject({
        brief: startArgs,
        computerId: storedBot.computerId,
      });
      // The in-process job worker launches the research on the emulator.
      await expect
        .poll(
          async () =>
            (await handles.prisma.researchJob.findUniqueOrThrow({ where: { id: job.id } })).status,
          { timeout: 15_000, interval: 100 },
        )
        .toBe("running");
      expect(emulator.jobs.get(job.id)?.status).toBe("running");
      expect(
        await handles.prisma.run.count({ where: { botId: bot.id, trigger: "research" } }),
      ).toBe(0);

      emulator.complete(job.id);
      await handles.jobs.enqueue(researchPollJob({ jobId: job.id }));
      await expect
        .poll(
          async () =>
            (await handles.prisma.researchJob.findUniqueOrThrow({ where: { id: job.id } }))
              .wakeRunId,
          { timeout: 15_000, interval: 100 },
        )
        .toBeTruthy();
      const finished = await handles.prisma.researchJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(finished).toMatchObject({ status: "completed", nextPollAt: null });
      expect(finished.artifactIds).toHaveLength(2);
      const wake = await handles.prisma.run.findUniqueOrThrow({
        where: { id: finished.wakeRunId! },
      });
      expect(wake).toMatchObject({ trigger: "research", botId: bot.id, threadId: job.threadId });
      await waitForRun(wake.id, "completed");
      model.assertComplete();

      expect(
        await handles.prisma.run.count({ where: { botId: bot.id, trigger: "research" } }),
      ).toBe(1);
      const revisions = await handles.prisma.memoryRevision.findMany({
        where: { sourceRunId: wake.id },
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.content).toContain(EMULATOR_RESEARCH_FINDINGS.summary);
      const card = await handles.prisma.message.findUniqueOrThrow({
        where: { id: job.messageId! },
      });
      const blocks = card.blocks as MessageBlock[];
      expect(blocks[0]).toEqual({
        kind: "research",
        researchId: job.id,
        title: "Pricing survey",
        status: "completed",
      });
      expect(blocks.filter((block) => block.kind === "file").map((block) => block.name)).toEqual(
        expect.arrayContaining(["findings.json", "report.md"]),
      );
      expect(blocksToAgentHistoryText(blocks)).toContain("[research: Pricing survey - completed]");
      const thread = await rpc<{ messages: Array<{ blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const rendered = JSON.stringify(thread.messages);
      expect(rendered).toContain("Remembered the findings.");
      expect(rendered).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      });
      const called = tools.map((event) => (event.payload as { name: string }).name);
      expect(called).toContain("research_start");
      expect(called.filter((name) => name !== "research_start")).toEqual([
        "research_status",
        "remember",
      ]);
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
