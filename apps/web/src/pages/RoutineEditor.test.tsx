/**
 * @vitest-environment jsdom
 */
import type { Routine } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyRoutineDraft, RoutineEditor, routineTriggerSummary } from "./RoutineEditor";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      String.raw({ raw: strings }, ...values),
  }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Triage updates",
    prompt: "Review the verified message event",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    unattendedTools: [],
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("RoutineEditor message trigger", () => {
  it("names an enabled provider as Message plus the provider", () => {
    expect(routineTriggerSummary(routine({ messageProvider: "slack" }))).toBe("Message Slack");
    expect(routineTriggerSummary(routine({ messageProvider: "discord" }))).toBe("Message Discord");
  });

  it("renders the selected provider on the trigger card", () => {
    const markup = renderToStaticMarkup(
      <RoutineEditor
        draft={{
          ...emptyRoutineDraft(),
          name: "Triage",
          prompt: "Review",
          messageProvider: "slack",
        }}
        onChange={vi.fn()}
        editing={null}
        timezone="UTC"
        webhook={{ path: "/webhook", secret: null, configured: false }}
        githubPath="/github"
        messageProviders={["slack", "discord"]}
        saving={false}
        running={false}
        error={null}
        onBack={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onTestRun={vi.fn()}
        onDelete={vi.fn()}
        onEnsureWebhook={vi.fn(async () => undefined)}
      />,
    );
    expect(markup).toContain("Message Slack");
    expect(markup).not.toContain("Slack message");
  });
});
