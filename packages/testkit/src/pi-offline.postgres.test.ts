import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
    });
    await withOfflineProduct(model, fixtureKey, async ({ handles, cookie, bot }) => {
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { status: true },
            });
            if (run?.status === "failed") model.assertComplete();
            return run?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/result.txt",
      });
      expect(file.content).toBe("hello");
      const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const messages = JSON.stringify(thread.messages);
      expect(messages).toContain("Saved notes/result.txt.");
      expect(messages).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        select: { payload: true },
      });
      expect(tools).toHaveLength(1);
      expect(JSON.stringify(tools[0])).toContain("write_file");
    });
  }, 30_000);

  it("replays a quota-stopped response through the real executor without repeating its text", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect() {},
          response: { type: "stream-error", text: "Saving now. ", message: "429 rate limit" },
        },
        { expect() {}, response: { type: "text", text: "Saving it now. Saved." } },
      ],
    });
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    try {
      await withOfflineProduct(model, fixtureKey, async ({ handles, cookie, bot }) => {
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Save hello to notes/result.txt.",
        });
        await expect
          .poll(
            async () =>
              (
                await handles.prisma.run.findUnique({
                  where: { id: sent.runId },
                  select: { status: true },
                })
              )?.status,
            { timeout: 15_000, interval: 100 },
          )
          .toBe("completed");
        model.assertComplete();
        const finals = await handles.prisma.message.findMany({
          where: { runId: sent.runId, role: "bot" },
          select: { blocks: true },
        });
        expect(finals.map((message) => message.blocks)).toEqual([
          [{ kind: "text", text: "Saving it now. Saved." }],
        ]);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("preserves a completed effect and retracts discarded text before a replayed publish", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const writeId = `write-once-${randomUUID()}`;
    const publishId = `replayed-publish-${randomUUID()}`;
    let failedRequest: ModelEmulatorRequest | undefined;
    let readEffects!: () => Promise<unknown[]>;
    let completedEffects: unknown[] = [];
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: writeId,
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          async expect(request) {
            failedRequest = request;
            completedEffects = await readEffects();
            expect(completedEffects).toEqual([
              expect.objectContaining({ idempotencyKey: writeId, status: "completed" }),
            ]);
          },
          response: {
            type: "stream-error",
            text: "Discard this narration. ",
            message: "429 rate limit",
            partialToolCall: {
              id: "discarded-publish",
              name: "message_user",
              arguments: '{"message":"Discard',
            },
          },
        },
        {
          async expect(request) {
            expect(request).toEqual(failedRequest);
            expect(await readEffects()).toEqual(completedEffects);
          },
          response: {
            type: "tool",
            id: publishId,
            name: "message_user",
            arguments: { message: "Saved file." },
          },
        },
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
    });
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    try {
      await withOfflineProduct(model, fixtureKey, async ({ handles, cookie, bot }) => {
        readEffects = () =>
          handles.prisma.externalEffect.findMany({
            where: { run: { botId: bot.id }, kind: "write_file" },
          });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Save hello to notes/result.txt and report completion.",
        });
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: sent.runId } });
              if (run?.status === "failed") model.assertComplete();
              return run?.status;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBe("completed");
        model.assertComplete();
        expect(await readEffects()).toEqual(completedEffects);
        const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
          botId: bot.id,
          path: "notes/result.txt",
        });
        expect(file.content).toBe("hello");
        const messages = await handles.prisma.message.findMany({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "asc" },
          select: { blocks: true },
        });
        const text = messages.flatMap((message) =>
          (message.blocks as MessageBlock[]).flatMap((block) =>
            block.kind === "text" ? [block.text] : [],
          ),
        );
        expect(text).toEqual(["Saved file.", "Done."]);
        const tools = await handles.prisma.event.findMany({
          where: { runId: sent.runId, type: "agent.tool.called" },
          orderBy: { seq: "asc" },
          select: { payload: true },
        });
        expect(tools).toEqual([
          { payload: { name: "write_file", executionId: writeId } },
          { payload: { name: "message_user", executionId: publishId } },
        ]);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it.each(["exhausted", "unauthorized"] as const)(
    "persists a failure receipt after a mid-stream replay is %s without publishing discarded text",
    async (failure) => {
      const fixtureKey = "offline-product-fixture-key";
      const expectedError =
        failure === "exhausted"
          ? "Quota retry failed after 1 retries. Try again later."
          : "Unauthorized";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect() {},
            response: { type: "stream-error", text: "Discard first. ", message: "429 rate limit" },
          },
          {
            expect() {},
            response:
              failure === "exhausted"
                ? { type: "stream-error", text: "Discard second. ", message: "429 rate limit" }
                : { type: "error", status: 401, message: "Unauthorized" },
          },
        ],
      });
      vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
      vi.stubEnv("RAKAZO_QUOTA_RETRY_MAX", "1");
      try {
        await withOfflineProduct(model, fixtureKey, async ({ handles, cookie, bot }) => {
          const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
            botId: bot.id,
            text: "Report completion.",
          });
          await expect
            .poll(
              async () =>
                (await handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
              { timeout: 15_000, interval: 100 },
            )
            .toBe("failed");
          model.assertComplete();
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
          expect(run.error).toContain(expectedError);
          const receipts = await handles.prisma.event.findMany({
            where: { runId: sent.runId, type: "run.failed" },
            select: { payload: true },
          });
          expect(receipts).toEqual([{ payload: { error: run.error } }]);
          expect(
            await handles.prisma.message.count({ where: { runId: sent.runId, role: "bot" } }),
          ).toBe(0);
          expect(await handles.prisma.externalEffect.count({ where: { runId: sent.runId } })).toBe(
            0,
          );
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
    30_000,
  );
});

type OfflineProduct = {
  handles: Awaited<ReturnType<typeof createApp>>;
  cookie: string;
  bot: { id: string };
};

async function withOfflineProduct(
  model: Awaited<ReturnType<typeof startModelEmulator>>,
  fixtureKey: string,
  journey: (product: OfflineProduct) => Promise<void>,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
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
      encryptionKey: "offline-model-fixture-encryption-key",
    });
    stop = handles.stop;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({
        email: `offline-pi-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: "Offline fixture",
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
      name: "File fixture",
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
    await journey({ handles, cookie, bot });
  } finally {
    try {
      await stop?.();
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

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
