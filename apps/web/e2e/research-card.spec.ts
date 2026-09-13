import { expect, type Page, type TestInfo, test } from "@playwright/test";
import type {
  AgentSkillCatalogEntry,
  MessageBlock,
  SpaceResearchSettingsView,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { AppBootstrapSchema } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

const now = "2026-09-13T12:00:00.000Z";

const researchSettings: SpaceResearchSettingsView = {
  executable: "agy",
  model: "fixture-model",
  project: "lib",
  mode: "accept-edits",
  updatedAt: now,
};

function researchMessage(blocks: MessageBlock[]): ThreadSnapshot {
  return {
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
        blocks,
      },
    ],
  };
}

const deepResearchSkill: AgentSkillCatalogEntry = {
  id: "builtin:deep-research",
  name: "deep-research",
  description: "Long research that needs many sources or a catalog sweep.",
  source: "builtin",
  readOnly: true,
};

async function openFixture(
  page: Page,
  options: {
    snapshot: ThreadSnapshot;
    research?: SpaceResearchSettingsView | null;
    skills?: AgentSkillCatalogEntry[];
  },
) {
  const snapshot = options.snapshot;
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
  const research = options.research === undefined ? null : options.research;

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
    } else if (procedure === "agentSkills/list") result = options.skills ?? [];
    else if (procedure === "research/get") result = research;
    else if (procedure === "memory/providerConfig") result = null;
    else if (procedure === "computer/status" || procedure === "computer/screenUrl") result = null;
    await route.fulfill({ json: { json: result } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/fixture-bot");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
}

async function attachCardCloseup(page: Page, testInfo: TestInfo, name: string) {
  const card = page.getByTestId("research-card");
  const path = testInfo.outputPath(`${name}-closeup.png`);
  await card.screenshot({ animations: "disabled", path });
  await testInfo.attach(`${name}-closeup`, { contentType: "image/png", path });
}

const completedBlocks: MessageBlock[] = [
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
];

test("renders a compact research card with findings files", async ({ page }, testInfo) => {
  await openFixture(page, { snapshot: researchMessage(completedBlocks) });

  const card = page.getByTestId("research-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pricing survey");
  await expect(card).toContainText("completed");
  await expect(page.getByText("findings.json", { exact: true })).toBeVisible();
  await expect(page.getByText("report.md", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "research-card");
  await attachCardCloseup(page, testInfo, "research-card");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(page.getByText("findings.json", { exact: true })).toBeVisible();
  await expect(page.getByText("report.md", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "research-card-narrow");
});

test("shows a failure reason and keeps cancelled off the success color", async ({
  page,
}, testInfo) => {
  await openFixture(page, {
    snapshot: researchMessage([
      {
        kind: "research",
        researchId: "rj_fixture",
        title: "Pricing survey",
        status: "failed",
        errorCode: "unavailable",
      },
    ]),
  });

  const failedCard = page.getByTestId("research-card");
  await expect(failedCard).toContainText("Pricing survey");
  await expect(failedCard).toContainText("failed");
  await expect(failedCard).toContainText("unavailable");
  const failedColor = await failedCard.getByText("failed", { exact: true }).evaluate((el) => {
    return getComputedStyle(el).color;
  });
  await captureScreenshot(page, testInfo, "research-card-failed");
  await attachCardCloseup(page, testInfo, "research-card-failed");

  await openFixture(page, {
    snapshot: researchMessage([
      {
        kind: "research",
        researchId: "rj_fixture",
        title: "Pricing survey",
        status: "cancelled",
      },
    ]),
  });
  const cancelledCard = page.getByTestId("research-card");
  await expect(cancelledCard).toContainText("cancelled");
  await expect(cancelledCard).not.toContainText("unavailable");
  const cancelledColor = await cancelledCard
    .getByText("cancelled", { exact: true })
    .evaluate((el) => getComputedStyle(el).color);
  await captureScreenshot(page, testInfo, "research-card-cancelled");
  await attachCardCloseup(page, testInfo, "research-card-cancelled");

  await openFixture(page, { snapshot: researchMessage(completedBlocks) });
  const completedColor = await page
    .getByTestId("research-card")
    .getByText("completed", { exact: true })
    .evaluate((el) => getComputedStyle(el).color);
  expect(completedColor).not.toBe(failedColor);
  expect(completedColor).not.toBe(cancelledColor);
  expect(cancelledColor).not.toBe(failedColor);
});

test("opens space research settings from the settings shell", async ({ page }, testInfo) => {
  await openFixture(page, {
    snapshot: researchMessage(completedBlocks),
    research: researchSettings,
  });

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-nav-research").click();
  await expect(settings).toHaveAttribute("data-settings-section", "research");
  await expect(settings.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
  const panel = settings.getByTestId("research-settings");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Model", { exact: true })).toHaveValue("fixture-model");
  await expect(panel.getByLabel("Project", { exact: true })).toHaveValue("lib");
  await expect(panel.getByLabel("Executable", { exact: true })).toHaveValue("agy");
  await expect(panel.getByLabel("Mode", { exact: true })).toHaveValue("accept-edits");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "research-settings");
});

test("lists the deep-research skill from the slash picker", async ({ page }, testInfo) => {
  await openFixture(page, {
    snapshot: researchMessage(completedBlocks),
    skills: [deepResearchSkill],
  });
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/deep-research");
  const skill = page.getByRole("button", { name: "Skill deep-research", exact: true });
  await expect(skill).toBeVisible();
  await expect(page.getByRole("button", { name: "Skill antigravity-research" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "deep-research-skill-picker");
  await skill.click();
  await expect(page.getByTestId("skill-chip")).toContainText("deep-research");
  await captureScreenshot(page, testInfo, "deep-research-skill-chip");
});
