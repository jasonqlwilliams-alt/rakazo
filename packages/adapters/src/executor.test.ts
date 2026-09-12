import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  archivalHistoryExclusion,
  blocksToText,
  createRunExecutor,
  MAX_MODEL_TOOL_BYTES,
  MAX_MODEL_TOOL_COUNT,
  modelToolMaxBytes,
  selectModelTools,
  toolSchemaBytes,
  appendToolCompletionAudit,
  createRunWorkspaceCheckpoint,
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  runNotificationsEnabled,
  selectBuiltinToolsForRun,
  settleSteeringAttachmentLoads,
  threadContextForRun,
  toolCompletionAuditPayload,
  toolCompletionFromResult,
} from "./executor.js";
import { serializeModelSecret } from "./pi-oauth.js";


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

describe("tool completion audit", () => {
  it("records result metadata without persisting tool contents", () => {
    const payload = toolCompletionAuditPayload({
      name: "computer_observe",
      executionId: "call-1",
      durationMs: 12.6,
      result: {
        kind: "agent_tool_result",
        content: [
          { type: "text", text: "Visible window" },
          { type: "image", data: "image-bytes", mimeType: "image/png" },
        ],
        details: {
          frameId: "frame-1",
          capturedAt: "2026-09-07T00:00:00.000Z",
          width: 1280,
          height: 720,
          activeWindow: { title: "Private window" },
        },
      },
    });

    expect(payload).toEqual({
      name: "computer_observe",
      executionId: "call-1",
      durationMs: 13,
      outcome: "succeeded",
      contentTypes: ["text", "image"],
      frameId: "frame-1",
      capturedAt: "2026-09-07T00:00:00.000Z",
      width: 1280,
      height: 720,
    });
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("activeWindow");
  });

  it("does not fail the run when the audit append fails", async () => {
    const append = vi.fn().mockRejectedValue(new Error("database unavailable"));

    await expect(
      appendToolCompletionAudit(
        { events: { append } },
        { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", runId: "run-1" },
        {
          name: "destination.write",
          executionId: "call-1",
          durationMs: 4,
          error: new Error("Bearer secret-token"),
        },
        ["secret-token"],
      ),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.tool.completed",
        payload: expect.objectContaining({
          outcome: "error",
          error: "Bearer [redacted]",
        }),
      }),
    );
  });

  it("records rejected scripted tool results as errors", () => {
    const completion = toolCompletionFromResult(
      { name: "destination.write", executionId: "call-1", durationMs: 4 },
      { error: "destination rejected the record" },
    );

    expect(completion).toEqual({
      name: "destination.write",
      executionId: "call-1",
      durationMs: 4,
      error: "destination rejected the record",
      paused: false,
    });
    expect(toolCompletionAuditPayload(completion)).toMatchObject({
      outcome: "error",
      error: "destination rejected the record",
    });
    expect(completion).not.toHaveProperty("result");
  });
});

describe("run workspace checkpoint", () => {
  it("skips clean turns and flushes once after a mutation", async () => {
    const persist = vi.fn(async () => undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);

    await expect(checkpoint.flush()).resolves.toBe(false);
    checkpoint.markDirty();
    await expect(checkpoint.flush()).resolves.toBe(true);
    await expect(checkpoint.flush()).resolves.toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("marks materialized steering files for checkpointing", async () => {
    const persist = vi.fn(async () => undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);

    checkpoint.markFiles([]);
    await expect(checkpoint.flush()).resolves.toBe(false);
    checkpoint.markFiles([{ path: "attachments/result.txt" }]);
    await expect(checkpoint.flush()).resolves.toBe(true);
  });

  it("keeps a failed checkpoint dirty for retry", async () => {
    const persist = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("checkpoint failed"))
      .mockResolvedValueOnce(undefined);
    const checkpoint = createRunWorkspaceCheckpoint(persist);
    checkpoint.markDirty();

    await expect(checkpoint.flush()).rejects.toThrow("checkpoint failed");
    await expect(checkpoint.flush()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe("run tool selection", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("gates page browsers (%s) independently of cloud agents (%s)", (page, cloud) => {
    const names = selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      pageBrowserAllowed: page,
      cloudAgentEnabled: cloud,
      groupId: null,
      trigger: "message",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    }).map((tool) => tool.name);
    expect(names.includes("browser_snapshot")).toBe(page);
    expect(names.includes("cloud_agent_status")).toBe(cloud);
    expect(names).not.toContain("computer_act");
  });

  const toolNames = (
    trigger: string,
    groupId: string | null = null,
    options?: { graphicalToolsAllowed?: boolean; pageBrowserAllowed?: boolean },
  ) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: options?.graphicalToolsAllowed ?? true,
      pageBrowserAllowed: options?.pageBrowserAllowed ?? true,
      groupId,
      trigger,
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    }).map((tool) => tool.name);

  it("keeps page browser tools without vision, and hides them without a graphical computer", () => {
    const withPage = toolNames("message", null, {
      graphicalToolsAllowed: false,
      pageBrowserAllowed: true,
    });
    expect(withPage).toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]),
    );
    expect(withPage).not.toEqual(expect.arrayContaining(["computer_observe", "computer_act"]));

    const withoutPage = toolNames("message", null, {
      graphicalToolsAllowed: true,
      pageBrowserAllowed: false,
    });
    expect(withoutPage).not.toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]),
    );
    expect(withoutPage).toEqual(expect.arrayContaining(["computer_observe", "computer_act"]));
  });

  it("withholds schedule creation only from routine-triggered runs", () => {
    expect(toolNames("routine")).not.toContain("schedule_create");
    expect(toolNames("routine")).toEqual(
      expect.arrayContaining(["schedule_list", "schedule_cancel"]),
    );
    expect(toolNames("user")).toContain("schedule_create");
  });

  it("keeps schedule tools in group chats and still blocks create on routines", () => {
    expect(toolNames("user", "group-1")).toEqual(
      expect.arrayContaining(["schedule_create", "schedule_list", "schedule_cancel"]),
    );
    expect(toolNames("routine", "group-1")).not.toContain("schedule_create");
    expect(toolNames("routine", "group-1")).toEqual(
      expect.arrayContaining(["schedule_list", "schedule_cancel"]),
    );
  });
});

describe("steering attachment hydration", () => {
  it("keeps successful attachment parts when another part is unavailable", async () => {
    const imageBlocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    const withoutImage = await settleSteeringAttachmentLoads(
      Promise.reject(new Error("image missing")),
      Promise.resolve(["attachment.pdf"]),
    );
    expect(withoutImage).toMatchObject({ images: undefined, files: ["attachment.pdf"] });
    expect(withoutImage.unavailableInstruction).toContain("do not guess its contents");

    const withoutFile = await settleSteeringAttachmentLoads(
      Promise.resolve(["image.png"]),
      Promise.reject(new Error("file missing")),
    );
    expect(withoutFile).toMatchObject({ images: ["image.png"], files: [] });
    expect(withoutFile.unavailableInstruction).toContain("do not guess its contents");

    const partiallyHydratedImages = await loadCurrentTurnImages(
      {
        artifacts: { get: vi.fn(async () => new Uint8Array([1])) },
        prisma: {
          artifact: {
            findMany: vi.fn(async () => [{ id: "image-1", storageKey: "one.png" }]),
          },
        },
      } as never,
      imageBlocks,
      {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      },
    );
    expect(partiallyHydratedImages).toHaveLength(1);
    const withPartiallyMissingImages = await settleSteeringAttachmentLoads(
      Promise.resolve(partiallyHydratedImages),
      Promise.resolve([]),
      imageBlocks,
    );
    expect(withPartiallyMissingImages).toMatchObject({
      images: partiallyHydratedImages,
      files: [],
    });
    expect(withPartiallyMissingImages.unavailableInstruction).toContain(
      "do not guess its contents",
    );

    const withAllImagesMissing = await settleSteeringAttachmentLoads(
      Promise.resolve(undefined),
      Promise.resolve([]),
      imageBlocks.slice(0, 1),
    );
    expect(withAllImagesMissing.unavailableInstruction).toContain("do not guess its contents");

    const withoutMissingImages = await settleSteeringAttachmentLoads(
      Promise.resolve(["image.png"]),
      Promise.resolve([]),
      imageBlocks.slice(0, 1),
    );
    expect(withoutMissingImages.unavailableInstruction).toBe("");

    const withoutExpectedImages = await settleSteeringAttachmentLoads(
      Promise.resolve(undefined),
      Promise.resolve([]),
    );
    expect(withoutExpectedImages.unavailableInstruction).toBe("");
  });

  it("propagates cancellation while steering attachments settle", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort();

    await expect(
      settleSteeringAttachmentLoads(
        Promise.reject(cancellation),
        Promise.resolve([]),
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
  });

  it("treats unreadable image bytes as missing instead of failing hydration", async () => {
    const blocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    const images = await loadCurrentTurnImages(
      {
        artifacts: {
          get: vi.fn(async (storageKey: string) => {
            if (storageKey === "bad.png") throw new Error("read failed");
            return new Uint8Array([1]);
          }),
        },
        prisma: {
          artifact: {
            findMany: vi.fn(async () => [
              { id: "image-1", storageKey: "one.png" },
              { id: "image-2", storageKey: "bad.png" },
            ]),
          },
        },
      } as never,
      blocks,
      {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      },
    );
    expect(images).toHaveLength(1);
    expect(missingTurnImagesInstruction(blocks, images)).toContain("do not guess its contents");
    const settled = await settleSteeringAttachmentLoads(
      Promise.resolve(images),
      Promise.resolve([]),
      blocks,
    );
    expect(settled.unavailableInstruction).toContain("do not guess its contents");
  });

  it("does not swallow image hydration cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort(cancellation);

    await expect(
      loadCurrentTurnImages(
        {
          artifacts: { get: vi.fn(async () => Promise.reject(cancellation)) },
          prisma: {
            artifact: {
              findMany: vi.fn(async () => [{ id: "image-1", storageKey: "one.png" }]),
            },
          },
        } as never,
        [{ kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" }],
        {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(cancellation);
  });

  it("warns when an ordinary turn expects more images than were loaded", () => {
    const blocks: MessageBlock[] = [
      { kind: "image", artifactId: "image-1", name: "one.png", mimeType: "image/png" },
      { kind: "image", artifactId: "image-2", name: "two.png", mimeType: "image/png" },
    ];
    expect(missingTurnImagesInstruction(blocks, [{ name: "one.png" } as never])).toContain(
      "do not guess its contents",
    );
    expect(
      missingTurnImagesInstruction(blocks, [
        { name: "one.png" } as never,
        { name: "two.png" } as never,
      ]),
    ).toBe("");
    expect(missingTurnImagesInstruction(blocks, undefined)).toContain("do not guess its contents");
    expect(missingTurnImagesInstruction(undefined, undefined)).toBe("");
  });
});

function modelPreference({
  provider,
  secretId,
  modelId,
  isDefault,
}: {
  provider: string;
  secretId: string;
  modelId: string;
  isDefault: boolean;
}) {
  const now = new Date("2026-08-30T00:00:00.000Z");
  return {
    id: `preference-${provider}`,
    isDefault,
    modelId,
    credential: {
      id: `credential-${provider}`,
      userId: "user-1",
      provider,
      label: provider,
      secretId,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("run notification preference", () => {
  it("silences direct messages but leaves group notifications enabled", async () => {
    let source: { bot: { notifyOnFinish: boolean }; thread: { groupId: string | null } } | null = {
      bot: { notifyOnFinish: false },
      thread: { groupId: null },
    };
    const findFirst = vi.fn(async () => source);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;

    await expect(
      runNotificationsEnabled(prisma, {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      }),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      },
      select: {
        bot: { select: { notifyOnFinish: true } },
        thread: { select: { groupId: true } },
      },
    });

    source = { bot: { notifyOnFinish: false }, thread: { groupId: "group-1" } };
    await expect(
      runNotificationsEnabled(prisma, {
        botId: "bot-1",
        threadId: "thread-1",
        spaceId: "workspace-1",
        userId: "user-1",
      }),
    ).resolves.toBe(true);
  });
});

describe("createRunExecutor", () => {
  it("excludes private summaries and memory tools from group messaging runs", () => {
    const messages = [{ role: "user", content: "Group request" }];
    expect(
      threadContextForRun(
        "messaging",
        {
          messages,
          summary: "Private test detail",
          historyCompactedUpToSeq: 12,
        },
        true,
      ),
    ).toEqual({
      messages,
      summary: null,
      historyCompactedUpToSeq: null,
      includeSemanticRecall: false,
    });
    const tools = selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "messaging",
      semanticMemoryEnabled: true,
      messagingChannelRun: true,
    }).map((tool) => tool.name);
    expect(tools).not.toContain("recall_memory");
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("save_memory");
    expect(tools.some((tool) => tool.startsWith("scratchpad_"))).toBe(false);
    expect(tools).toContain("web_fetch");
  });

  it("isolates routine runs from every thread-history source", () => {
    const threadContext = {
      messages: [{ role: "user", content: "Create this routine" }],
      summary: "The user just configured this routine.",
      historyCompactedUpToSeq: 4,
    };

    expect(threadContextForRun("routine", threadContext, false)).toEqual({
      messages: [],
      summary: null,
      historyCompactedUpToSeq: null,
      includeSemanticRecall: false,
    });
    expect(threadContextForRun("user", threadContext, false)).toEqual({
      ...threadContext,
      includeSemanticRecall: true,
    });
  });

  it("deactivates one-shot routines after wake without scheduling another wakeup", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "group-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      thread: {
        findFirst: vi.fn(async () => ({ id: "group-thread-1" })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: taskCreate },
          run: { create: runCreate },
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
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.fired",
        runId: "run-1",
        threadId: "group-thread-1",
      }),
    );
  });

  it("wakes a tool-created group routine into the group thread, not the bot DM", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const append = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => ({ id: "group-thread-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "remind the group",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "group-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "dm-thread-1" },
        })),
      },
      thread: { findFirst },
      agentSkill: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: runCreate },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "group-thread-1", spaceId: "ws-1" }),
      }),
    );
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "group-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", threadId: "group-thread-1" }),
    );
  });

  it("wakes a tool-created 1:1 routine into the bot DM thread", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1" }));
    const append = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => ({ id: "dm-thread-1" }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          spaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "remind me",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          threadId: "dm-thread-1",
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "dm-thread-1" },
        })),
      },
      thread: { findFirst },
      agentSkill: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: runCreate },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "dm-thread-1", spaceId: "ws-1" }),
      }),
    );
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "dm-thread-1" }) }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadId: "dm-thread-1" }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", threadId: "dm-thread-1" }),
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
          spaceId: "ws-1",
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
          spaceId: "ws-1",
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
          spaceId: "ws-1",
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

  it("fails a run clearly without calling the real runtime when no model is configured", async () => {
    let status = "queued";
    const runtimeRun = vi.fn();
    const finalizeRun = vi.fn(async () => {
      status = "failed";
      return { continuationRunId: null };
    });
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      userId: "user-1",
      spaceId: "ws-1",
      status: "queued",
      trigger: "user",
      routineId: null,
      sourceMessageId: null,
      checkpoint: null,
      leaseFence: 0,
    };
    const botLookup = vi.fn(async (args: { select?: { computerId?: boolean } }) =>
      args.select?.computerId
        ? { computerId: "computer-1", computerSwitching: false }
        : {
            id: "bot-1",
            name: "Assistant",
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
            memoryScope: "isolated",
            computer: { id: "computer-1", scope: "private" },
          },
    );
    const prisma = {
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findUniqueOrThrow: botLookup },
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ scope: "private", state: "running" })),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          historyCompactionGeneration: 0,
        })),
      },
      message: { findMany: vi.fn(async () => []) },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      connection: { findMany: vi.fn(async () => []) },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSecret: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: runtimeRun,
      },
      memoryProviders: { resolve: vi.fn(async () => null) },
      memory: { read: vi.fn(async () => ({ documents: [] })) },
      events: { append: vi.fn(async () => undefined), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(status).toBe("failed");
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Connect a model in Settings before running bots.",
      }),
    );
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it("resolves a per-bot model override with that provider’s credential", async () => {
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; isDefault?: boolean } }) => {
        if (args.where.credential?.provider === "xai") {
          return modelPreference({
            provider: "xai",
            secretId: "secret-xai",
            modelId: "grok-4.6",
            isDefault: false,
          });
        }
        if (args.where.isDefault) {
          return modelPreference({
            provider: "openrouter",
            secretId: "secret-or",
            modelId: "deepseek/deepseek-v4-flash-0731",
            isDefault: true,
          });
        }
        return null;
      },
    );
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ credential: { provider: "xai" } }),
      }),
    );
  });

  it("resolves an explicit subagent model within the active user and space", async () => {
    const preference = modelPreference({
      provider: "xai",
      secretId: "secret-xai",
      modelId: "grok-4.6",
      isDefault: false,
    });
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; modelId?: string } }) => {
        if (args.where.credential?.provider !== "xai") return null;
        if (args.where.modelId && args.where.modelId !== "grok-4.6") return null;
        return preference;
      },
    );
    const prisma = {
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveConnectedModel(
      { userId: "user-1", spaceId: "ws-1" },
      "xai",
      "grok-4.6",
    );

    expect(model).toMatchObject({ provider: "xai", id: "grok-4.6", thinkingLevel: null });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "ws-1",
          userId: "user-1",
          modelId: "grok-4.6",
          credential: { provider: "xai" },
        }),
      }),
    );
  });

  it("rejects a free-form selection when the owning preference disappears", async () => {
    const preference = modelPreference({
      provider: "openai-compatible",
      secretId: "secret-compat",
      modelId: "newest-model",
      isDefault: true,
    });
    const findFirst = vi.fn(
      async (args: {
        where: { credential?: { provider?: string; userId?: string }; modelId?: string };
        select?: unknown;
      }) => {
        if (args.select) {
          return args.where.modelId === "private-model" ? { id: "saved" } : null;
        }
        if (args.where.modelId === "private-model") return null;
        if (args.where.credential?.provider === "openai-compatible") return preference;
        return null;
      },
    );
    const prisma = {
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveConnectedModel(
        { userId: "user-1", spaceId: "ws-1" },
        "openai-compatible",
        "private-model",
      ),
    ).rejects.toThrow("Unknown model for that provider");
  });

  it("keeps image support for a separately enabled bot model override", async () => {
    const provider = "openai-compatible";
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; isDefault?: boolean } }) => {
        if (args.where.credential?.provider === provider || args.where.isDefault) {
          return modelPreference({
            provider,
            secretId: "secret-openai-compatible",
            modelId: "space-model",
            isDefault: Boolean(args.where.isDefault),
          });
        }
        return null;
      },
    );
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      visionModelIds: ["bot-vision-model"],
      maxImagesPerPrompt: 1,
      maxTokens: 8192,
      contextWindow: 65536,
    });
    const bot = {
      modelProvider: provider,
      modelId: "bot-vision-model",
      thinkingLevel: null,
    };
    const prisma = {
      bot: { findFirst: vi.fn(async () => bot) },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-openai-compatible",
          ciphertext: plaintext,
        })),
        findUnique: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(() => plaintext), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "ws-1", botId: "bot-1" }),
    ).resolves.toMatchObject({
      provider,
      id: "bot-vision-model",
      acceptsImages: true,
      maxImagesPerPrompt: 1,
      maxTokens: 8192,
      contextWindow: 65536,
    });

    bot.modelId = "text-only-model";
    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "ws-1", botId: "bot-1" }),
    ).resolves.toMatchObject({
      provider,
      id: "text-only-model",
      acceptsImages: false,
    });
  });

  it("falls back to the Space default when the override provider has no credential", async () => {
    const findFirst = vi.fn(
      async (args: { where: { credential?: { provider?: string }; isDefault?: boolean } }) => {
        if (args.where.credential?.provider === "xai") return null;
        if (args.where.isDefault) {
          return modelPreference({
            provider: "openrouter",
            secretId: "secret-or",
            modelId: "deepseek/deepseek-v4-flash-0731",
            isDefault: true,
          });
        }
        return null;
      },
    );
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
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
        where: expect.objectContaining({ credential: { provider: "xai" } }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it("withholds the deployment key when settings name a different provider", async () => {
    const prisma = {
      bot: { findFirst: vi.fn(async () => null) },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "anthropic",
          defaultModelId: "claude-sonnet-5",
        })),
      },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      // PI_DEFAULT_PROVIDER is unset here, so this key belongs to OpenRouter.
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({ userId: "user-1", spaceId: "ws-1" });

    expect(model.provider).toBe("anthropic");
    expect(model.apiKey).toBeUndefined();
  });

  it("keeps per-bot thinking when using the Space default model", async () => {
    const findFirst = vi.fn(async (args: { where: { isDefault?: boolean } }) => {
      if (!args.where.isDefault) return null;
      return modelPreference({
        provider: "openrouter",
        secretId: "secret-or",
        modelId: "deepseek/deepseek-v4-flash-0731",
        isDefault: true,
      });
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: "high",
        })),
      },
      spaceModelPreference: { findFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      spaceId: "ws-1",
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

describe("recent history excludes imported Grokbot transcript", () => {
  // The importer writes archival records into the live thread at the newest seq, so without
  // this every seat's window filled with old Grokbot conversation and its real Rakazo work
  // fell out entirely -- 200 of 200 on seven seats, 198 of 200 on the eighth.
  const matches = (blocks: Array<{ kind: string; text: string }>) => {
    const [first] = blocks;
    const clause = archivalHistoryExclusion().NOT.AND;
    const kind = clause[0]?.blocks as { path: string[]; equals: string };
    const text = clause[1]?.blocks as { path: string[]; string_starts_with: string };
    return first?.kind === kind.equals && first.text.startsWith(text.string_starts_with);
  };

  it("targets the first block's kind and source label", () => {
    const clause = archivalHistoryExclusion().NOT.AND;

    expect(clause).toHaveLength(2);
    const [kindClause, textClause] = clause;
    expect((kindClause?.blocks as { path: string[] } | undefined)?.path).toEqual(["0", "kind"]);
    expect((textClause?.blocks as { path: string[] } | undefined)?.path).toEqual(["0", "text"]);
  });

  it("excludes an imported transcript record", () => {
    expect(
      matches([
        { kind: "meta", text: "Source: Grok · transcript 22425e78 · record 37440/37440" },
        { kind: "text", text: "Grok keeps two piles on my computer" },
      ]),
    ).toBe(true);
  });

  it("excludes it whether the importer says Grok or Grokbot", () => {
    expect(matches([{ kind: "meta", text: "Source: Grokbot · transcript abc · record 1/2" }])).toBe(
      true,
    );
  });

  it("keeps the seat's own Rakazo turns", () => {
    expect(matches([{ kind: "text", text: "MemoraX 58.02, MemOS 45.89" }])).toBe(false);
    expect(matches([{ kind: "meta", text: "Created by Chief" }])).toBe(false);
  });
});
