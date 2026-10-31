import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireComputerExecutionLease,
  ComposioEmulator,
  ComputerBusyError,
  expireComputerControl,
} from "@rakazo/adapters";
import { createThreadEvents, createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

/** Local semantic memory stand-in: accepts the connection probe and records container deletes. */
async function startMemoryStore() {
  const deleted: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://memory.test");
    if (request.method === "DELETE" && url.pathname.startsWith("/v3/container-tags/")) {
      deleted.push(decodeURIComponent(url.pathname.slice("/v3/container-tags/".length)));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    deleted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!enabled)("conversation clear (PostgreSQL)", () => {
  let handles: AppHandles;
  let dataDir: string;
  let memory: Awaited<ReturnType<typeof startMemoryStore>>;
  let cookie: string;
  let userId: string;
  let spaceId: string;

  const call = async (procedure: string, input: unknown = {}) => {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: input }),
    });
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  };
  const rpc = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
    const { status, body } = await call(procedure, input);
    if (status >= 400) throw new Error(`${procedure}: ${JSON.stringify(body.json)}`);
    return body.json as T;
  };

  async function createBot(name: string) {
    const bot = await rpc<{ id: string }>("bots/create", {
      name,
      title: "",
      description: "",
      instructions: "Answer briefly.",
      notifyOnFinish: false,
    });
    await discardBotIntroRun(handles, cookie, bot.id);
    const thread = await handles.prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
    return { botId: bot.id, threadId: thread.id };
  }

  async function createRun(botId: string, threadId: string, status: string) {
    const task = await handles.prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "Synthetic task", status: "queued" },
    });
    return handles.prisma.run.create({
      data: { spaceId, botId, threadId, taskId: task.id, userId, status, trigger: "user" },
    });
  }

  beforeAll(async () => {
    memory = await startMemoryStore();
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-thread-clear-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      contextStrategy: "current",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "thread-clear-fixture-encryption-key",
    });
    const email = `clear-${randomUUID()}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "password12", name: "Clear fixture" }),
    });
    expect(signup.status).toBeLessThan(400);
    cookie = sessionCookieHeader(signup);
    const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;
    // A local memory endpoint is a deployment-owner setting.
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: userId },
    });
    const member = await handles.prisma.spaceMember.findFirstOrThrow({ where: { userId } });
    spaceId = member.spaceId;
    await rpc("memory/connectProvider", {
      provider: "supermemory",
      settings: { mode: "local", baseUrl: memory.baseUrl },
      credentials: { apiKey: "fixture-memory-key" },
      defaultMemoryScope: "isolated",
    });
  }, 60_000);

  afterAll(async () => {
    await handles?.stop();
    await memory?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("purges the cleared generation's summaries and the generation that follows it", async () => {
    const { botId, threadId } = await createBot("Purge fixture");
    const history = (generation: number) => `rakazo:${botId}:history:${generation}`;

    memory.deleted.length = 0;
    await rpc("threads/clear", { botId });
    expect(
      (await handles.prisma.thread.findUniqueOrThrow({ where: { id: threadId } }))
        .historyCompactionGeneration,
    ).toBe(1);
    expect(memory.deleted.sort()).toEqual([history(0), history(1)]);

    memory.deleted.length = 0;
    await rpc("threads/clear", { botId });
    expect(memory.deleted.sort()).toEqual([history(1), history(2)]);
  });

  it("releases a waiting takeover's screen control and stops its computer work", async () => {
    const { botId, threadId } = await createBot("Takeover fixture");
    const run = await createRun(botId, threadId, "waiting_takeover");
    const computer = await handles.prisma.computer.create({
      data: {
        spaceId,
        userId,
        scopeKey: `clear-fixture:${randomUUID()}`,
        homeKey: `clear-fixture:${randomUUID()}`,
        kind: "fake",
        providerRef: `fake-${randomUUID()}`,
        state: "running",
        controlHolder: "user",
        controlLeaseId: "control-lease-1",
        controlLeaseExpiresAt: new Date(Date.now() + 60 * 60_000),
        controlBotId: botId,
        controlRunId: run.id,
      },
    });
    const lease = await handles.prisma.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId,
        runId: run.id,
        fence: 3,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const sandbox = handles.sandbox;
    let enterTeardown!: () => void;
    let allowTeardown!: () => void;
    const teardownEntered = new Promise<void>((resolve) => {
      enterTeardown = resolve;
    });
    const teardownGate = new Promise<void>((resolve) => {
      allowTeardown = resolve;
    });
    const releaseScreen = vi.spyOn(sandbox, "releaseScreen").mockImplementation(async () => {
      enterTeardown();
      await teardownGate;
    });
    const setScreenControl = vi.spyOn(sandbox, "setScreenControl").mockResolvedValue(undefined);
    const execute = vi.spyOn(sandbox, "execute").mockImplementation(async function* () {});
    try {
      const clearing = rpc("threads/clear", { botId });
      await teardownEntered;
      expect(
        (
          await handles.prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })
        ).expiresAt.getTime(),
      ).toBeGreaterThan(Date.now());
      await expect(
        acquireComputerExecutionLease(handles.prisma, {
          computerId: computer.id,
          botId,
          runId: "replacement-run",
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      allowTeardown();
      await clearing;

      expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "cancelled",
      });
      expect(
        await handles.prisma.computer.findUniqueOrThrow({ where: { id: computer.id } }),
      ).toMatchObject({
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      });
      expect(setScreenControl).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: computer.providerRef }),
        false,
        expect.anything(),
        "control-lease-1",
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: computer.providerRef }),
        expect.objectContaining({
          argv: expect.arrayContaining([expect.stringContaining(run.id)]),
        }),
        expect.objectContaining({ runId: run.id, cancelRunWork: true }),
      );
      expect(releaseScreen).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: computer.providerRef }),
        expect.objectContaining({ runId: run.id, screenLeaseId: `${run.id}:${lease.fence}` }),
      );
      expect(
        (await handles.prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } }))
          .expiresAt,
      ).toEqual(new Date(0));
      await expect(
        acquireComputerExecutionLease(handles.prisma, {
          computerId: computer.id,
          botId,
          runId: "replacement-run",
        }),
      ).resolves.toMatchObject({ fence: lease.fence + 1 });
    } finally {
      allowTeardown();
      releaseScreen.mockRestore();
      setScreenControl.mockRestore();
      execute.mockRestore();
    }
  });

  it("stops a dedicated computer without an execution lease", async () => {
    const { botId, threadId } = await createBot("Dedicated takeover fixture");
    const run = await createRun(botId, threadId, "waiting_takeover");
    await handles.prisma.run.update({ where: { id: run.id }, data: { leaseFence: 4 } });
    const computer = await handles.prisma.computer.create({
      data: {
        spaceId,
        userId,
        scope: "dedicated",
        scopeKey: `clear-fixture:${randomUUID()}`,
        homeKey: `clear-fixture:${randomUUID()}`,
        kind: "fake",
        providerRef: `fake-${randomUUID()}`,
        state: "running",
        controlHolder: "user",
        controlLeaseId: "dedicated-control-lease",
        controlLeaseExpiresAt: new Date(Date.now() + 60 * 60_000),
        controlBotId: botId,
        controlRunId: run.id,
      },
    });
    await handles.prisma.bot.update({ where: { id: botId }, data: { computerId: computer.id } });
    const releaseScreen = vi.spyOn(handles.sandbox, "releaseScreen").mockResolvedValue(undefined);
    const setScreenControl = vi
      .spyOn(handles.sandbox, "setScreenControl")
      .mockResolvedValue(undefined);
    const execute = vi.spyOn(handles.sandbox, "execute").mockImplementation(async function* () {});
    try {
      await rpc("threads/clear", { botId });

      expect(await handles.prisma.computerExecutionLease.count({ where: { runId: run.id } })).toBe(
        0,
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: computer.providerRef }),
        expect.objectContaining({
          argv: expect.arrayContaining([expect.stringContaining(run.id)]),
        }),
        expect.objectContaining({ runId: run.id, cancelRunWork: true }),
      );
      expect(releaseScreen).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: computer.providerRef }),
        expect.objectContaining({ runId: run.id, screenLeaseId: `${run.id}:4` }),
      );
    } finally {
      releaseScreen.mockRestore();
      setScreenControl.mockRestore();
      execute.mockRestore();
    }
  });

  it("makes a failed control revoke due for retry after clear", async () => {
    const { botId, threadId } = await createBot("Control retry fixture");
    const run = await createRun(botId, threadId, "waiting_takeover");
    const computer = await handles.prisma.computer.create({
      data: {
        spaceId,
        userId,
        scopeKey: `clear-fixture:${randomUUID()}`,
        homeKey: `clear-fixture:${randomUUID()}`,
        kind: "fake",
        providerRef: `fake-${randomUUID()}`,
        state: "running",
        controlHolder: "user",
        controlLeaseId: "retry-control-lease",
        controlLeaseExpiresAt: new Date(Date.now() + 60 * 60_000),
        controlBotId: botId,
        controlRunId: run.id,
      },
    });
    const setScreenControl = vi
      .spyOn(handles.sandbox, "setScreenControl")
      .mockRejectedValueOnce(new Error("temporary revoke failure"))
      .mockResolvedValue(undefined);
    try {
      await rpc("threads/clear", { botId });
      const retained = await handles.prisma.computer.findUniqueOrThrow({
        where: { id: computer.id },
      });
      expect(retained.controlLeaseId).toBe("retry-control-lease");
      expect(retained.controlLeaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(
        expireComputerControl(
          {
            prisma: handles.prisma,
            sandbox: handles.sandbox,
            jobs: handles.jobs,
            events: createThreadEvents(handles.prisma),
          },
          computer.id,
          "retry-control-lease",
        ),
      ).resolves.toBe(true);
      expect(
        (await handles.prisma.computer.findUniqueOrThrow({ where: { id: computer.id } }))
          .controlLeaseId,
      ).toBeNull();
    } finally {
      setScreenControl.mockRestore();
    }
  });

  it("refuses a clear whose preconditions no longer hold, and keeps the conversation", async () => {
    const { botId, threadId } = await createBot("Precondition fixture");
    await createThreadMessage(handles.prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Keep this." }],
    });
    const { nextMessageSeq } = await handles.prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
    });
    const messages = () => handles.prisma.message.count({ where: { threadId } });

    const stale = await call("threads/clear", {
      botId,
      expectedNextMessageSeq: nextMessageSeq - 1,
    });
    expect(stale.status).toBe(409);
    expect(await messages()).toBe(1);

    const run = await createRun(botId, threadId, "running");
    const busy = await call("threads/clear", { botId, ifIdle: true });
    expect(busy.status).toBe(409);
    expect(await messages()).toBe(1);
    expect((await handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "running",
    );
    await handles.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });

    const agent = await handles.prisma.cloudAgent.create({
      data: {
        operationKey: randomUUID(),
        providerKey: "fixture",
        spaceId,
        userId,
        botId,
        threadId,
        title: "Fixture agent",
        launchRequest: {},
      },
    });
    expect((await call("threads/clear", { botId, ifIdle: true })).status).toBe(409);
    expect(await messages()).toBe(1);
    await handles.prisma.cloudAgent.update({
      where: { id: agent.id },
      data: { status: "finished" },
    });

    const research = await handles.prisma.researchJob.create({
      data: {
        operationKey: randomUUID(),
        spaceId,
        userId,
        botId,
        threadId,
        computerId: "fixture-computer",
        title: "Fixture research",
        request: {},
      },
    });
    expect((await call("threads/clear", { botId, ifIdle: true })).status).toBe(409);
    expect(await messages()).toBe(1);
    await handles.prisma.researchJob.update({
      where: { id: research.id },
      data: { status: "completed" },
    });

    await rpc("threads/clear", { botId, expectedNextMessageSeq: nextMessageSeq, ifIdle: true });
    expect(await messages()).toBe(0);
  });

  it("still clears a busy conversation when the caller sets no precondition", async () => {
    const { botId, threadId } = await createBot("Unconditional fixture");
    await createThreadMessage(handles.prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Clear this." }],
    });
    const run = await createRun(botId, threadId, "running");

    await rpc("threads/clear", { botId });

    expect(await handles.prisma.message.count({ where: { threadId } })).toBe(0);
    expect((await handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
  });
});
