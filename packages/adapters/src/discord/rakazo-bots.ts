import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { DiscordBotTarget } from "./config.js";
import type {
  DiscordCorrelation,
  RakazoBotRunner,
  RakazoBotTurnRequest,
  RakazoBotTurnResult,
} from "./types.js";

export interface DiscordBotRecord {
  id: string;
  name: string;
  userId: string;
  workspaceId: string;
  threadId: string;
}

export interface DiscordRunRecord {
  id: string;
  threadId: string;
  botId: string;
  status: string;
  error?: string | null;
  /** Event cursor observed before the run's status was read, so no history is rescanned. */
  afterSeq?: number;
}

export interface DiscordTurnStore {
  findActiveBot(query: {
    workspaceId: string;
    id?: string;
    name: string;
  }): Promise<DiscordBotRecord | null>;
  findRunByClientNonce(workspaceId: string, clientNonce: string): Promise<DiscordRunRecord | null>;
  createDiscordTurn(input: {
    workspaceId: string;
    bot: DiscordBotRecord;
    speaker: "flux" | "eleusis";
    prompt: string;
    clientNonce: string;
    correlation: DiscordCorrelation;
  }): Promise<{ runId: string; afterSeq: number }>;
  getRun(runId: string): Promise<DiscordRunRecord | null>;
  getBotReplyText(runId: string): Promise<string | null>;
}

export interface RunWaiter {
  wait(input: {
    threadId: string;
    runId: string;
    afterSeq: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<
    "completed" | "failed" | "cancelled" | "waiting_input" | "waiting_takeover" | "timeout"
  >;
}

export class NativeRakazoBotRunner implements RakazoBotRunner {
  constructor(
    private readonly deps: {
      store: DiscordTurnStore;
      jobs: JobPublisher;
      waiter: RunWaiter;
      workspaceId: string;
      flux: DiscordBotTarget;
      eleusis: DiscordBotTarget;
    },
  ) {}

  async runTurn(request: RakazoBotTurnRequest): Promise<RakazoBotTurnResult> {
    const target = request.speaker === "flux" ? this.deps.flux : this.deps.eleusis;
    const bot = await this.deps.store.findActiveBot({
      workspaceId: this.deps.workspaceId,
      id: target.id,
      name: target.name,
    });
    if (!bot) {
      return {
        ok: false,
        code: "not_found",
        message: `${target.name} is not available. No unarchived Rakazo bot with that configured name or ID exists in the configured workspace.`,
      };
    }

    const clientNonce = `discord:${request.correlation.eventId}:${request.speaker}`;
    const existing = await this.deps.store.findRunByClientNonce(this.deps.workspaceId, clientNonce);
    let queued: {
      id: string;
      threadId: string;
      botId: string;
      status: string;
      afterSeq: number;
    };
    if (existing) {
      queued = {
        id: existing.id,
        threadId: existing.threadId,
        botId: existing.botId,
        status: existing.status,
        afterSeq: existing.afterSeq ?? 0,
      };
    } else {
      const created = await this.enqueueTurn(bot, request, clientNonce);
      queued = {
        id: created.runId,
        threadId: bot.threadId,
        botId: bot.id,
        status: "queued",
        afterSeq: created.afterSeq,
      };
    }
    const afterSeq = queued.afterSeq;
    if (!existing || existing.status === "queued") {
      await this.deps.jobs.enqueue(runContinueJob(queued.id));
    }

    const outcome = await this.deps.waiter.wait({
      threadId: queued.threadId,
      runId: queued.id,
      afterSeq,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (outcome === "timeout") {
      return {
        ok: false,
        code: "timeout",
        message: `${bot.name} timed out waiting for a Rakazo run to finish.`,
        runId: queued.id,
        threadId: queued.threadId,
        botId: queued.botId,
      };
    }
    if (outcome === "waiting_input" || outcome === "waiting_takeover") {
      return {
        ok: false,
        code: "paused",
        message: `${bot.name} paused in Rakazo and needs a decision there before it can finish this Discord turn.`,
        runId: queued.id,
        threadId: queued.threadId,
        botId: queued.botId,
      };
    }
    if (outcome === "cancelled") {
      return {
        ok: false,
        code: "cancelled",
        message: `${bot.name} was cancelled before it could answer.`,
        runId: queued.id,
        threadId: queued.threadId,
        botId: queued.botId,
      };
    }
    if (outcome === "failed") {
      const run = await this.deps.store.getRun(queued.id);
      return {
        ok: false,
        code: "failed",
        message: run?.error?.trim() || `${bot.name} failed while answering.`,
        runId: queued.id,
        threadId: queued.threadId,
        botId: queued.botId,
      };
    }
    const text = (await this.deps.store.getBotReplyText(queued.id))?.trim();
    return {
      ok: true,
      text: text || `${bot.name} finished without a text reply.`,
      runId: queued.id,
      threadId: queued.threadId,
      botId: queued.botId,
    };
  }

  private async enqueueTurn(
    bot: DiscordBotRecord,
    request: RakazoBotTurnRequest,
    clientNonce: string,
  ) {
    try {
      return await this.deps.store.createDiscordTurn({
        workspaceId: this.deps.workspaceId,
        bot,
        speaker: request.speaker,
        prompt: request.prompt,
        clientNonce,
        correlation: request.correlation,
      });
    } catch (error) {
      const raced = await this.deps.store.findRunByClientNonce(this.deps.workspaceId, clientNonce);
      if (raced) return { runId: raced.id, afterSeq: raced.afterSeq ?? 0 };
      throw error;
    }
  }
}
