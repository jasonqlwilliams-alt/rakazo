import { describe, expect, it } from "vitest";
import { type DiscordTurnStore, NativeRakazoBotRunner, type RunWaiter } from "./rakazo-bots.js";
import type { DiscordCorrelation } from "./types.js";

const correlation: DiscordCorrelation = {
  eventId: "interaction-1",
  eventKind: "interaction",
  interactionId: "interaction-1",
  guildId: "g",
  channelId: "c",
};

function memoryStore(): DiscordTurnStore & {
  messages: Array<{ role: string; text: string }>;
  runs: Array<{ id: string; trigger: string; clientNonce: string; userId: string }>;
  jobs: string[];
} {
  const bots = [
    {
      id: "flux-id",
      name: "Flux",
      userId: "owner-1",
      workspaceId: "ws",
      threadId: "thread-flux",
    },
    {
      id: "eleusis-id",
      name: "Eleusis",
      userId: "owner-1",
      workspaceId: "ws",
      threadId: "thread-eleusis",
    },
  ];
  const messages: Array<{ role: string; text: string }> = [];
  const runs: Array<{
    id: string;
    trigger: string;
    clientNonce: string;
    userId: string;
    threadId: string;
    botId: string;
    status: string;
  }> = [];
  return {
    messages,
    runs,
    jobs: [],
    async findActiveBot(query) {
      return (
        bots.find(
          (bot) =>
            bot.workspaceId === query.workspaceId &&
            ((query.id && bot.id === query.id) || bot.name === query.name),
        ) ?? null
      );
    },
    async findRunByClientNonce(_workspaceId, clientNonce) {
      const run = runs.find((row) => row.clientNonce === clientNonce);
      return run
        ? {
            id: run.id,
            threadId: run.threadId,
            botId: run.botId,
            status: run.status,
            afterSeq: 41,
          }
        : null;
    },
    async createDiscordTurn(input) {
      messages.push({
        role: "system",
        text: `${input.speaker}:${input.prompt}:${input.correlation.eventId}`,
      });
      const run = {
        id: `run-${input.speaker}`,
        trigger: "discord",
        clientNonce: input.clientNonce,
        userId: input.bot.userId,
        threadId: input.bot.threadId,
        botId: input.bot.id,
        status: "queued",
      };
      runs.push(run);
      return { runId: run.id, afterSeq: 1 };
    },
    async getRun(runId) {
      const run = runs.find((row) => row.id === runId);
      return run
        ? { id: run.id, threadId: run.threadId, botId: run.botId, status: "completed" }
        : null;
    },
    async getBotReplyText(runId) {
      return runId.includes("flux") ? "Flux native reply" : "Eleusis native reply";
    },
  };
}

describe("native Rakazo bot runner", () => {
  it("starts Flux and Eleusis through the discord trigger without a user-authored message", async () => {
    const store = memoryStore();
    const jobs: string[] = [];
    const waiter: RunWaiter = {
      async wait() {
        return "completed";
      },
    };
    const runner = new NativeRakazoBotRunner({
      store,
      jobs: {
        async enqueue(job) {
          jobs.push(job.name);
        },
        async cancel() {},
        async close() {},
      },
      waiter,
      workspaceId: "ws",
      flux: { name: "Flux" },
      eleusis: { name: "Eleusis" },
    });

    const flux = await runner.runTurn({
      speaker: "flux",
      prompt: "report",
      correlation,
      timeoutMs: 1000,
    });
    const eleusis = await runner.runTurn({
      speaker: "eleusis",
      prompt: "report",
      correlation,
      timeoutMs: 1000,
    });

    expect(flux).toMatchObject({ ok: true, text: "Flux native reply", botId: "flux-id" });
    expect(eleusis).toMatchObject({ ok: true, text: "Eleusis native reply", botId: "eleusis-id" });
    expect(store.messages.every((message) => message.role === "system")).toBe(true);
    expect(store.messages.some((message) => message.role === "user")).toBe(false);
    expect(store.runs.map((run) => run.trigger)).toEqual(["discord", "discord"]);
    expect(jobs).toEqual(["run.continue", "run.continue"]);
  });

  it("reuses the client nonce instead of creating a second turn", async () => {
    const store = memoryStore();
    const waiter: RunWaiter = {
      async wait() {
        return "completed";
      },
    };
    const runner = new NativeRakazoBotRunner({
      store,
      jobs: { async enqueue() {}, async cancel() {}, async close() {} },
      waiter,
      workspaceId: "ws",
      flux: { name: "Flux" },
      eleusis: { name: "Eleusis" },
    });
    await runner.runTurn({ speaker: "flux", prompt: "once", correlation, timeoutMs: 1000 });
    await runner.runTurn({ speaker: "flux", prompt: "once", correlation, timeoutMs: 1000 });
    expect(store.runs).toHaveLength(1);
  });

  it("fails closed when the configured bot is missing", async () => {
    const store = memoryStore();
    const runner = new NativeRakazoBotRunner({
      store,
      jobs: { async enqueue() {}, async cancel() {}, async close() {} },
      waiter: {
        async wait() {
          return "completed";
        },
      },
      workspaceId: "ws",
      flux: { name: "NotFlux" },
      eleusis: { name: "Eleusis" },
    });
    const result = await runner.runTurn({
      speaker: "flux",
      prompt: "report",
      correlation,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
  });

  it("waits from the existing run's cursor when a duplicate interaction arrives", async () => {
    const store = memoryStore();
    const cursors: number[] = [];
    const waiter: RunWaiter = {
      async wait(input) {
        cursors.push(input.afterSeq);
        return "completed";
      },
    };
    const runner = new NativeRakazoBotRunner({
      store,
      jobs: {
        async enqueue() {},
        async cancel() {},
        async close() {},
      },
      waiter,
      workspaceId: "ws",
      flux: { name: "Flux" },
      eleusis: { name: "Eleusis" },
    });

    await runner.runTurn({ speaker: "flux", prompt: "report", correlation, timeoutMs: 1000 });
    await runner.runTurn({ speaker: "flux", prompt: "report", correlation, timeoutMs: 1000 });

    expect(cursors).toEqual([1, 41]);
    expect(cursors).not.toContain(0);
  });
});
