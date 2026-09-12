import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  archivalHistoryExclusion,
  createThreadMessageInTransaction,
  loadRunHistoryMessages,
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
