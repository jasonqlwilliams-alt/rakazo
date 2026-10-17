/**
 * @vitest-environment jsdom
 */
import type { Bot } from "@rakazo/contracts";
import { MODEL_ROUTER_KEY } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  Plural: ({ value }: { value: number }) => `${value}`,
}));

const rpcMock = vi.hoisted(() => ({
  voice: { voices: vi.fn() },
  models: { list: vi.fn(), credentials: vi.fn() },
  me: vi.fn(),
  scratchpad: { list: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: rpcMock }));

import { BotSettings } from "./bot-panel";

const bot: Bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "",
  description: "",
  instructions: "",
  color: "#111111",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: "2026-10-17T00:00:00.000Z",
  createdAt: "2026-10-17T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: "anthropic",
  modelId: "claude-sonnet-5",
  thinkingLevel: "high",
  modelRouting: true,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rpcMock.voice.voices.mockResolvedValue([]);
  rpcMock.scratchpad.list.mockResolvedValue([]);
  rpcMock.models.list.mockResolvedValue([
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      billing: "",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high"],
    },
  ]);
  rpcMock.models.credentials.mockResolvedValue([
    {
      id: "c1",
      provider: "anthropic",
      label: "Anthropic",
      hasKey: true,
      isDefault: true,
      modelId: "claude-sonnet-5",
    },
  ]);
  rpcMock.me.mockResolvedValue({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function modelSelect() {
  const found = [...container.querySelectorAll("select")].find((select) =>
    [...select.options].some((option) => option.value === MODEL_ROUTER_KEY),
  );
  if (!found) throw new Error("model select missing");
  return found;
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("bot model router setting", () => {
  it("keeps Auto selected, hides effort, and does not pin a model on save", async () => {
    const onSave = vi.fn(async () => undefined);
    act(() =>
      root.render(
        <BotSettings
          bot={bot}
          memoryProviderConfigured={false}
          onSkillsChange={() => undefined}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    await settle();

    const select = modelSelect();
    expect(select.value).toBe(MODEL_ROUTER_KEY);
    expect([...select.options].map((option) => option.textContent)).toContain("Auto");
    expect(container.querySelector('[id$="-thinking"]')).toBeNull();

    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")
        ?.click();
    });
    await settle();

    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelRouting");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelProvider");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("thinkingLevel");
  });

  it("turns Auto on without pinning a model", async () => {
    const onSave = vi.fn(async () => undefined);
    act(() =>
      root.render(
        <BotSettings
          bot={{ ...bot, modelRouting: false }}
          memoryProviderConfigured={false}
          onSkillsChange={() => undefined}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    await settle();

    setSelect(modelSelect(), MODEL_ROUTER_KEY);
    expect(container.querySelector('[id$="-thinking"]')).toBeNull();
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")
        ?.click();
    });
    await settle();

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ modelRouting: true }));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelProvider");
  });

  it("pins a chosen model and its effort when Auto is turned off", async () => {
    const onSave = vi.fn(async () => undefined);
    act(() =>
      root.render(
        <BotSettings
          bot={bot}
          memoryProviderConfigured={false}
          onSkillsChange={() => undefined}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    await settle();

    setSelect(modelSelect(), "anthropic::claude-sonnet-5");
    expect(container.querySelector('[id$="-thinking"]')).not.toBeNull();
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")
        ?.click();
    });
    await settle();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRouting: false,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5",
      }),
    );
  });
});
