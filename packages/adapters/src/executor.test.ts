import type { ConnectorTool } from "@rakazo/adapter-kit";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  blocksToText,
  createRunExecutor,
  MAX_MODEL_TOOL_BYTES,
  MAX_MODEL_TOOL_COUNT,
  modelToolMaxBytes,
  selectModelTools,
  toolSchemaBytes,
} from "./executor.js";

function tool(name: string, description = name): ConnectorTool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

/** A tool whose schema costs roughly `bytes`, the way a real connector's biggest ones do. */
function fatTool(name: string, bytes: number): ConnectorTool {
  return { name, description: "x".repeat(Math.max(0, bytes - name.length)), inputSchema: {} };
}

const note = {
  kind: "agent_note",
  fromBotId: "bot-eleusis",
  fromName: "Eleusis",
  toBotId: "bot-thor",
  toName: "Thor",
  text: "hold the venue list until I confirm",
} as const;

describe("model context for a peer note", () => {
  it("tells the receiving bot the note came from a peer, not the user", () => {
    const text = blocksToText([{ ...note, direction: "received" } as MessageBlock]);

    expect(text).toBe("[agent] note from peer bot Eleusis: hold the venue list until I confirm");
    // The bare note text alone would read as if the user had typed it.
    expect(text).not.toBe(note.text);
  });

  it("tells the sending bot the note went out", () => {
    const text = blocksToText([{ ...note, direction: "sent" } as MessageBlock]);

    expect(text).toBe("[agent] note sent to Thor: hold the venue list until I confirm");
  });

  it("leaves every other block kind alone", () => {
    expect(blocksToText([{ kind: "text", text: "plain" }])).toBe("plain");
    expect(blocksToText([{ kind: "meta", text: "Created by Chief" }])).toBe("Created by Chief");
  });
});

describe("createRunExecutor", () => {
  it("deactivates one-shot routines after wake without scheduling another wakeup", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", runId: "run-1" }),
    );
  });

  it("expands @skill mentions in the routine prompt at fire time", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    let createdPrompt = "";
    const taskCreate = vi.fn(async (args: { data: { prompt: string } }) => {
      createdPrompt = args.data.prompt;
      return { id: "task-1" };
    });
    const skillContent = `---
name: Daily standup
description: Prepare standup notes
---

1. Summarize wins.
`;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Run @Daily standup, then email me",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily standup",
            description: "Prepare standup notes",
            content: skillContent,
            source: "user",
          },
        ]),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(createdPrompt).toContain("Use skill: Daily standup");
    expect(createdPrompt).toContain("Summarize wins");
    expect(createdPrompt).not.toMatch(/@Daily standup/);
  });

  it("still continues the run when routine.fired append fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => {
      throw new Error("append failed");
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: null,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.wakeRoutine("routine-1", scheduledAt.toISOString()),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
  });

  it("restores the routine claim when run.continue enqueue fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const previousLastRunAt = new Date(Date.now() - 60_000);
    const enqueue = vi.fn(async () => {
      throw new Error("enqueue failed");
    });
    const claimUpdateMany = vi.fn(async () => ({ count: 1 }));
    const restoreUpdateMany = vi.fn(async () => ({ count: 1 }));
    const deleteRunMany = vi.fn(async () => ({ count: 1 }));
    const deleteTaskMany = vi.fn(async () => ({ count: 1 }));
    let transactionCalls = 0;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: previousLastRunAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          return callback({
            routine: { updateMany: claimUpdateMany },
            task: { create: vi.fn(async () => ({ id: "task-1" })) },
            run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
          });
        }
        return callback({
          routine: { updateMany: restoreUpdateMany },
          task: { deleteMany: deleteTaskMany },
          run: { deleteMany: deleteRunMany },
        });
      }),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(executor.wakeRoutine("routine-1", scheduledAt.toISOString())).rejects.toThrow(
      "enqueue failed",
    );
    expect(deleteRunMany).toHaveBeenCalledWith({ where: { id: "run-1", status: "queued" } });
    expect(deleteTaskMany).toHaveBeenCalledWith({ where: { id: "task-1", status: "queued" } });
    expect(restoreUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "routine-1", active: false, nextRunAt: null }),
        data: expect.objectContaining({
          nextRunAt: scheduledAt,
          active: true,
          lastRunAt: previousLastRunAt,
        }),
      }),
    );
  });

  it("consumes a persisted takeover checkpoint when claiming the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkpoint: null }),
      }),
    );
  });

  it("restores a takeover checkpoint when a switching computer requeues the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany,
      },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          computerId: "computer-1",
          computerSwitching: true,
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma, jobs: { enqueue } } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "queued",
          checkpoint: "takeover-skipped",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("resolves a per-bot model override with that provider’s credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") {
        return {
          id: "cred-xai",
          provider: "xai",
          secretId: "secret-xai",
          defaultModel: "grok-4.6",
          isDefault: false,
        };
      }
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "xai" }),
      }),
    );
  });

  it("falls back to the workspace default when the override provider has no credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") return null;
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      // Override thinking must drop with the override provider/credential unit.
      thinkingLevel: null,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "xai" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it("keeps per-bot thinking when using the workspace default model", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      thinkingLevel: "high",
    });
  });
});

describe("model tool selection", () => {
  it("leaves a deduplicated tool set below the limit unchanged", () => {
    const builtins = [tool("shell"), tool("read_file")];
    const selection = selectModelTools(
      builtins,
      [tool("shell"), tool("SLACK_SEND_MESSAGE")],
      "send a message",
      10,
    );

    expect(selection).toEqual({
      tools: [...builtins, tool("SLACK_SEND_MESSAGE")],
      curated: false,
      omittedCount: 0,
    });
  });

  it("caps a large catalog while retaining built-ins, gateways, and every toolkit", () => {
    const builtins = [tool("shell"), tool("read_file")];
    const gateways = [
      tool("destination.write"),
      tool("COMPOSIO_SEARCH_TOOLS"),
      tool("COMPOSIO_EXECUTE_TOOL"),
    ];
    const direct = ["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLETASKS"].flatMap((group) =>
      Array.from({ length: 120 }, (_, index) => tool(`${group}_ACTION_${index}`)),
    );

    const selection = selectModelTools(builtins, [...gateways, ...direct], "status", 40);
    const names = selection.tools.map((entry) => entry.name);

    expect(selection.curated).toBe(true);
    expect(selection.tools).toHaveLength(40);
    expect(selection.omittedCount).toBe(builtins.length + gateways.length + direct.length - 40);
    expect(names).toEqual(expect.arrayContaining(builtins.map((entry) => entry.name)));
    expect(names).toEqual(expect.arrayContaining(gateways.map((entry) => entry.name)));
    for (const group of ["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLETASKS"]) {
      expect(names.some((name) => name.startsWith(`${group}_`))).toBe(true);
    }
  });

  it("ranks prompt-relevant tools first within a toolkit", () => {
    const selection = selectModelTools(
      [tool("shell")],
      [
        tool("COMPOSIO_SEARCH_TOOLS"),
        tool("SLACK_ARCHIVE_CHANNEL"),
        tool("SLACK_SEND_MESSAGE", "Send a message to Slack"),
        tool("GMAIL_LIST_THREADS"),
        tool("GMAIL_SEND_EMAIL"),
      ],
      "Send a Slack message",
      4,
    );
    const names = selection.tools.map((entry) => entry.name);

    expect(names).toContain("SLACK_SEND_MESSAGE");
    expect(names).toContain("GMAIL_SEND_EMAIL");
    expect(names).not.toContain("SLACK_ARCHIVE_CHANNEL");
  });

  it("caps the tool schemas by bytes, not only by count", () => {
    // Twelve 40 KB tools are only twelve tools, so the count cap never fires -- but they
    // are 480 KB of prompt. The live workspace's largest single schema is 18 KB.
    const discovered = ["SLACK", "GMAIL", "SUPABASE"].flatMap((group) =>
      Array.from({ length: 4 }, (_, index) => fatTool(`${group}_FAT_${index}`, 40_000)),
    );

    const selection = selectModelTools([tool("shell")], discovered, "status", 300, 100_000);
    const bytes = selection.tools.reduce((total, entry) => total + toolSchemaBytes(entry), 0);

    expect(selection.curated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(100_000);
    expect(selection.tools.length).toBeLessThan(discovered.length + 1);
    expect(selection.omittedCount).toBeGreaterThan(0);
    // The built-in still has to be there.
    expect(selection.tools.map((entry) => entry.name)).toContain("shell");
  });

  it("steps over one oversized schema to admit the smaller tools behind it", () => {
    const selection = selectModelTools(
      [tool("shell")],
      [fatTool("SLACK_HUGE", 90_000), tool("SLACK_SEND_MESSAGE"), tool("GMAIL_SEND_EMAIL")],
      "status",
      300,
      20_000,
    );
    const names = selection.tools.map((entry) => entry.name);

    expect(names).not.toContain("SLACK_HUGE");
    expect(names).toContain("SLACK_SEND_MESSAGE");
    expect(names).toContain("GMAIL_SEND_EMAIL");
  });

  it("takes the tool-schema budget from the environment when one is set", () => {
    expect(modelToolMaxBytes({})).toBe(MAX_MODEL_TOOL_BYTES);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "65536" })).toBe(65_536);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "" })).toBe(MAX_MODEL_TOOL_BYTES);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "nonsense" })).toBe(
      MAX_MODEL_TOOL_BYTES,
    );
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "-1" })).toBe(MAX_MODEL_TOOL_BYTES);
  });

  it("uses a provider-safe default ceiling", () => {
    const discovered = Array.from({ length: 400 }, (_, index) =>
      tool(`${["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLECALENDAR"][index % 4]}_ACTION_${index}`),
    );
    const selection = selectModelTools([tool("shell")], discovered, "status");

    expect(selection.tools).toHaveLength(MAX_MODEL_TOOL_COUNT);
    expect(selection.tools.length).toBeLessThan(350);
  });
});
