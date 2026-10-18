import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  archivalHistoryExclusion,
  createThreadMessage,
  createThreadMessageInTransaction,
  loadRunHistoryMessages,
  RunHistoryWriteError,
} from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("run history archive exclusion", () => {
  it.each([undefined, "channel-1"])(
    "excludes archives before limiting history for channel %s",
    async (channelId) => {
      const findMany = vi.fn().mockResolvedValue([]);
      await loadRunHistoryMessages(
        { message: { findMany } } as unknown as PrismaClient,
        { id: "run-1", threadId: "thread-1" },
        200,
        channelId,
      );
      const query = findMany.mock.calls[0]![0];
      expect(query).toMatchObject({
        where: { threadId: "thread-1", ...archivalHistoryExclusion() },
        orderBy: { seq: "desc" },
        take: 200,
      });
      if (channelId)
        expect(query.where.OR).toEqual([
          { role: "user", blocks: { array_contains: [{ kind: "channel_message", channelId }] } },
          { role: "bot", runId: "run-1" },
        ]);
      else expect(query.where).not.toHaveProperty("OR");
    },
  );
});
