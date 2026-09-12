import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, test } from "@playwright/test";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { AppBootstrapSchema } from "@rakazo/contracts";
import { PiAgentRuntime } from "../../../packages/adapters/src/pi-runtime";
import { listAgentSkillRecords } from "../../../packages/adapters/src/skill-tools";
import type { ModelEmulatorStep } from "../../../packages/testkit/src/model-emulator";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator";
import { reduceThreadSnapshot } from "../src/lib/thread-events";
import { captureScreenshot } from "./helpers";

// Real Pi + HTTP/SSE + production web shell. Authentication/storage RPCs use
// synthetic data; this fixture does not claim to exercise the worker or database.
const cases = ["retry", "exhausted", "partial", "unavailable"] as const;
for (const scenario of cases) {
  test(`quota ${scenario} is visible in the product shell`, async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const previousDelay = process.env.RAKAZO_QUOTA_RETRY_MS;
    const previousMax = process.env.RAKAZO_QUOTA_RETRY_MAX;
    if (scenario === "retry") delete process.env.RAKAZO_QUOTA_RETRY_MS;
    else process.env.RAKAZO_QUOTA_RETRY_MS = "1";
    delete process.env.RAKAZO_QUOTA_RETRY_MAX;
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const now = "2026-09-12T12:00:00.000Z";
    let snapshot: ThreadSnapshot = {
      botId: "fixture-bot",
      threadId: "fixture-thread",
      cursor: -1,
      messages: [],
      olderCursor: null,
      run: null,
    };
    let seq = 0;
    const publish = (type: ProductEvent["type"], payload: ProductEvent["payload"]) => {
      snapshot = reduceThreadSnapshot(snapshot, {
        id: `event-${++seq}`,
        seq,
        type,
        payload,
        spaceId: "fixture-space",
        threadId: snapshot.threadId,
        botId: "fixture-bot",
        runId: "fixture-run",
        createdAt: now,
      })!;
    };
    const bot = {
      id: "fixture-bot",
      spaceId: "fixture-space",
      name: "Research",
      title: "",
      description: "",
      instructions: "Complete the requested task.",
      color: "gray",
      notifyOnFinish: false,
      pinned: false,
      sectionId: null,
      archivedAt: null,
      unread: false,
      parentBotId: null,
      memoryScope: null,
      threadId: snapshot.threadId,
      preview: "",
      status: "idle",
      computerMode: "team",
      updatedAt: now,
      createdAt: now,
      voiceId: null,
      autoSpeak: false,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      webhookConfigured: false,
      spawnKey: null,
    };
    const me = {
      userId: "fixture-user",
      email: "reader@example.test",
      name: "Reader",
      spaceId: "fixture-space",
      isDeploymentOwner: false,
      needsModel: false,
      defaultProvider: "openai-compatible",
      defaultModel: "offline-fixture",
      computerHost: null,
      canChooseHostComputer: false,
      sandboxProvider: "fake",
      avatarStyle: "robot",
    };
    const bootstrap = () =>
      AppBootstrapSchema.parse({
        me,
        bots: [bot],
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread: snapshot,
        routines: [],
        spaces: [],
      });
    const skills = await listAgentSkillRecords(
      { agentSkill: { findMany: async () => [] } } as never,
      { spaceId: "fixture-space", userId: "fixture-user" },
    );
    const events: Array<{ elapsedMs: number; event: AgentRuntimeEvent }> = [];
    const requestTimes: number[] = [];
    let writes = 0;
    let startedAt = 0;
    let work: Promise<void> | undefined;
    let error: string | undefined;
    let failedRequest: unknown;
    const steps: ModelEmulatorStep[] =
      scenario === "retry"
        ? [
            {
              expect() {},
              response: {
                type: "tool",
                id: "write-once",
                name: "write_file",
                arguments: { path: "notes.txt", content: "hello" },
              },
            },
            {
              expect(request) {
                failedRequest = request;
              },
              response: { type: "error", status: 429, message: "Tokens per minute exceeded" },
            },
            {
              expect(request) {
                expect(request).toEqual(failedRequest);
              },
              response: { type: "text", text: "Saved." },
            },
          ]
        : scenario === "exhausted"
          ? Array.from({ length: 4 }, () => ({
              expect() {},
              response: { type: "error" as const, status: 429, message: "quota exceeded" },
            }))
          : scenario === "partial"
            ? [
                {
                  expect(request) {
                    failedRequest = request;
                  },
                  response: {
                    type: "stream-error",
                    text: "Partial answer",
                    message: "429 rate limit",
                  },
                },
                {
                  expect(request) {
                    expect(request).toEqual(failedRequest);
                  },
                  response: { type: "text", text: "Full answer." },
                },
              ]
            : [
                {
                  expect() {},
                  response: {
                    type: "error",
                    status: 503,
                    message: "No available provider",
                    headers: { "Retry-After": "10" },
                  },
                },
              ];
    const server = await startModelEmulator({
      steps: steps.map((step) => ({
        ...step,
        expect(request) {
          requestTimes.push(performance.now() - startedAt);
          return step.expect(request);
        },
      })),
    });
    const run = async (prompt: string) => {
      let streamedText = "";
      startedAt = performance.now();
      publish("thread.message.created", { role: "user", blocks: [{ kind: "text", text: prompt }] });
      publish("run.started", { trigger: "user" });
      try {
        for await (const event of runtime.run(
          {
            botId: "fixture-bot",
            threadId: snapshot.threadId,
            runId: "fixture-run",
            prompt,
            instructions: bot.instructions,
            history: [],
            model: server.model,
            tools: [
              {
                name: "write_file",
                description: "Save a file",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" }, content: { type: "string" } },
                  required: ["path", "content"],
                  additionalProperties: false,
                },
              },
            ],
            executeTool: async (_name, args) => {
              expect(args.path).toBe("notes.txt");
              writes++;
              await writeFile(testInfo.outputPath("notes.txt"), String(args.content));
              return { saved: true };
            },
          },
          { signal: controller.signal },
        )) {
          events.push({ elapsedMs: performance.now() - startedAt, event });
          if (event.type === "progress") {
            publish("thread.progress", { text: event.text, activity: event.activity });
          } else if (event.type === "text") {
            streamedText += event.text;
            publish("thread.progress", { delta: event.text, streaming: true });
          } else if (event.type === "retract") {
            streamedText = streamedText.slice(0, streamedText.length - event.chars);
            publish("thread.progress", { text: streamedText, streaming: true });
          } else if (event.type === "done") {
            publish("thread.message.created", {
              role: "bot",
              blocks: [{ kind: "text", text: event.text }],
            });
            publish("run.completed", {});
          }
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        publish("run.failed", { error });
      }
    };
    try {
      await page.route("**/api/auth/get-session**", (route) =>
        route.fulfill({
          json: {
            user: {
              id: me.userId,
              name: me.name,
              email: me.email,
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: "fixture-session",
              userId: me.userId,
              expiresAt: "2099-01-01T00:00:00Z",
            },
          },
        }),
      );
      await page.route("**/rpc/**", async (route) => {
        const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
        let result: unknown = [];
        if (procedure === "bootstrap") result = bootstrap();
        else if (procedure === "me") result = me;
        else if (procedure === "threads/get") result = snapshot;
        else if (procedure === "threads/head") result = { cursor: snapshot.cursor };
        else if (procedure === "threads/subscribe") {
          await route.fulfill({ contentType: "text/event-stream", body: "" });
          return;
        } else if (procedure === "threads/send") {
          const input = route.request().postDataJSON().json;
          work = run(input.text);
          if (scenario !== "retry") await work;
          result = { taskId: "fixture-run", runId: "fixture-run", seq };
        } else if (procedure === "spaces/list") {
          result = { spaces: [], current: { bots: [bot], groups: [], botSections: [] } };
        } else if (procedure === "agentSkills/list") result = skills;
        else if (procedure === "computer/status" || procedure === "computer/screenUrl")
          result = null;
        await route.fulfill({ json: { json: result } });
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/app/fixture-bot");
      await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
      const composer = page.getByRole("combobox", { name: /^Message/ });
      if (scenario === "retry") {
        await composer.fill("/antigravity");
        const skill = page.getByRole("button", { name: "Skill antigravity-research", exact: true });
        await expect(skill).toBeVisible();
        await captureScreenshot(page, testInfo, "antigravity-skill-picker");
        await skill.click();
        await expect(page.getByTestId("skill-chip")).toContainText("antigravity-research");
        await page.getByRole("button", { name: "Remove skill antigravity-research" }).click();
      }
      await composer.fill("Save hello to notes.txt.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => Boolean(work)).toBe(true);
      if (scenario === "retry") {
        await expect
          .poll(() =>
            events.some(
              ({ event }) =>
                event.type === "progress" && event.text === "Quota, retrying in 60s (1/3).",
            ),
          )
          .toBe(true);
        await page.reload();
        await expect(page.getByText("Quota, retrying in 60s (1/3).", { exact: true })).toBeVisible({
          timeout: 2_000,
        });
        await captureScreenshot(page, testInfo, "quota-wait-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByText("Quota, retrying in 60s (1/3).", { exact: true }),
        ).toBeVisible();
        await captureScreenshot(page, testInfo, "quota-wait-mobile-web");
      }
      await work;
      server.assertComplete();
      await page.setViewportSize({ width: 1440, height: 900 });
      if (scenario === "retry") {
        await page.reload();
        expect(error).toBeUndefined();
        expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(60_000);
        expect(writes).toBe(1);
        expect(await readFile(testInfo.outputPath("notes.txt"), "utf8")).toBe("hello");
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await expect(page.getByText(/^Quota, retrying/)).toHaveCount(0);
      } else if (scenario === "partial") {
        expect(error).toBeUndefined();
        expect(requestTimes).toHaveLength(2);
        await expect(page.getByText("Full answer.", { exact: true })).toBeVisible();
        await expect(page.getByText(/Partial answer/)).toHaveCount(0);
      } else {
        const expected =
          scenario === "exhausted"
            ? "Quota retry failed after 3 retries. Try again later."
            : "No available provider";
        expect(error).toContain(expected);
        await expect(page.getByTestId("composer-error")).toContainText(expected);
        if (scenario !== "exhausted") expect(requestTimes).toHaveLength(1);
      }
      await captureScreenshot(page, testInfo, `quota-${scenario}-result`);
      const receiptPath = testInfo.outputPath("runtime-receipt.json");
      await writeFile(
        receiptPath,
        JSON.stringify(
          {
            scenario,
            transport: "real Pi against loopback HTTP/SSE",
            storage: "RPC fixture",
            requestTimesMs: requestTimes,
            toolWrites: writes,
            persistedText: writes ? await readFile(testInfo.outputPath("notes.txt"), "utf8") : null,
            error: error ?? null,
            events,
          },
          null,
          2,
        ),
      );
      await testInfo.attach("runtime-receipt", {
        path: receiptPath,
        contentType: "application/json",
      });
    } finally {
      controller.abort();
      await work;
      await server.close();
      if (previousDelay === undefined) delete process.env.RAKAZO_QUOTA_RETRY_MS;
      else process.env.RAKAZO_QUOTA_RETRY_MS = previousDelay;
      if (previousMax === undefined) delete process.env.RAKAZO_QUOTA_RETRY_MAX;
      else process.env.RAKAZO_QUOTA_RETRY_MAX = previousMax;
    }
  });
}
