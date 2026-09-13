import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { AppBootstrapSchema } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test("renders a compact research card with findings files", async ({ page }, testInfo) => {
  const now = "2026-09-13T12:00:00.000Z";
  const snapshot: ThreadSnapshot = {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    cursor: 1,
    olderCursor: null,
    run: null,
    messages: [
      {
        id: "msg-research",
        threadId: "fixture-thread",
        seq: 1,
        role: "bot",
        createdAt: now,
        blocks: [
          {
            kind: "research",
            researchId: "rj_fixture",
            title: "Pricing survey",
            status: "completed",
          },
          {
            kind: "file",
            artifactId: "art-findings",
            mimeType: "application/json",
            name: "findings.json",
            size: 128,
          },
          {
            kind: "file",
            artifactId: "art-report",
            mimeType: "text/markdown",
            name: "report.md",
            size: 256,
          },
        ],
      },
    ],
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
  const bootstrap = AppBootstrapSchema.parse({
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
    if (procedure === "bootstrap") result = bootstrap;
    else if (procedure === "me") result = me;
    else if (procedure === "threads/get") result = snapshot;
    else if (procedure === "threads/head") result = { cursor: snapshot.cursor };
    else if (procedure === "threads/subscribe") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
      return;
    } else if (procedure === "spaces/list") {
      result = { spaces: [], current: { bots: [bot], groups: [], botSections: [] } };
    } else if (procedure === "agentSkills/list") result = [];
    else if (procedure === "research/get") result = null;
    else if (procedure === "computer/status" || procedure === "computer/screenUrl") result = null;
    await route.fulfill({ json: { json: result } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/fixture-bot");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");

  const card = page.getByTestId("research-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pricing survey");
  await expect(card).toContainText("completed");
  await expect(page.getByText("findings.json", { exact: true })).toBeVisible();
  await expect(page.getByText("report.md", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "research-card");
});
