import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("routine overlap prevention", () => {
  it.each(["running", "queued", "waiting_input"])(
    "skips a firing while the same routine is %s, restores lastRunAt, and schedules the next firing",
    async (status) => {
      const scheduledAt = new Date(Date.now() - 1000);
      const previousLastRunAt = new Date(Date.now() - 120_000);
      for (const crons of [["* * * * *"], [ONCE_ROUTINE_CRON]]) {
        const taskCreate = vi.fn();
        const runCreate = vi.fn();
        const routineUpdate = vi.fn(async () => ({}));
        const findActive = vi.fn(async () => ({ id: "existing", status }));
        const enqueue = vi.fn();
        const tx = {
          routine: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            update: routineUpdate,
          },
          run: { findFirst: findActive, create: runCreate },
          task: { create: taskCreate },
        };
        const prisma = {
          routine: {
            findUnique: vi.fn(async () => ({
              id: "routine",
              botId: "bot",
              spaceId: "space",
              userId: "owner",
              active: true,
              nextRunAt: scheduledAt,
              lastRunAt: previousLastRunAt,
              crons,
              timezone: "UTC",
              prompt: "Check once",
            })),
          },
          bot: {
            findUnique: vi.fn(async () => ({
              id: "bot",
              thread: { id: "thread" },
            })),
          },
          agentSkill: { findMany: vi.fn(async () => []) },
          $transaction: vi.fn(async (work) => work(tx)),
        } as unknown as PrismaClient;
        const executor = createRunExecutor({
          prisma,
          jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
          events: { append: vi.fn() },
        } as unknown as Parameters<typeof createRunExecutor>[0]);

        await executor.wakeRoutine("routine", scheduledAt.toISOString());

        expect(findActive).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              routineId: "routine",
              status: { notIn: ["completed", "failed", "cancelled"] },
            },
          }),
        );
        expect(routineUpdate).toHaveBeenCalledWith({
          where: { id: "routine" },
          data: {
            active: true,
            nextRunAt: expect.any(Date),
            lastRunAt: previousLastRunAt,
          },
        });
        expect(taskCreate).not.toHaveBeenCalled();
        expect(runCreate).not.toHaveBeenCalled();
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]![0]).toMatchObject({
          name: "routine.wakeup",
        });
      }
    },
  );
});
