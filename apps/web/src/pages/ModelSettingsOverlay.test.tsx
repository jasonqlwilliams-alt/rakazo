/**
 * @vitest-environment jsdom
 */
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
  models: {
    list: vi.fn(),
    credentials: vi.fn(),
    setDefault: vi.fn(),
    connect: vi.fn(),
  },
  me: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));

import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const xaiEntry = (id: string, label: string) => ({
  provider: "xai",
  providerName: "xAI",
  id,
  label,
  billing: "Uses your xAI API key.",
  auth: "api-key" as const,
  subscription: false,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rpcMock.models.list.mockResolvedValue([
    xaiEntry("grok-4.6", "Grok 4.6"),
    xaiEntry("grok-4.7", "Grok 4.7"),
  ]);
  rpcMock.models.credentials.mockResolvedValue([
    { id: "c1", provider: "xai", label: "xAI", hasKey: true, isDefault: true, modelId: "grok-4.8" },
  ]);
  rpcMock.me.mockResolvedValue({ defaultProvider: "xai", defaultModel: "grok-4.8" });
  rpcMock.models.setDefault.mockResolvedValue({ ok: true });
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

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function modelIdInput() {
  return container.querySelector<HTMLInputElement>('input[aria-label="Model id"]');
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("model settings with an unlisted model id", () => {
  it("shows the saved id, switches to the list, and saves a typed id", async () => {
    act(() => root.render(<ModelSettingsOverlay onClose={() => undefined} embedded />));
    await settle();

    expect(modelIdInput()?.value).toBe("grok-4.8");
    expect(container.textContent).toContain("Active model");
    expect(container.textContent).toContain("grok-4.8");

    act(() => button("Use a listed model").click());
    expect(modelIdInput()).toBeNull();
    expect(container.querySelector('[role="combobox"][aria-label="Model"]')?.textContent).toContain(
      "Grok 4.6",
    );

    act(() => button("Other model id").click());
    const input = modelIdInput();
    expect(input?.value).toBe("grok-4.8");
    typeInto(input!, "grok-4.9");
    act(() => button("Use this model").click());
    await settle();

    expect(rpcMock.models.setDefault).toHaveBeenCalledWith({
      provider: "xai",
      modelId: "grok-4.9",
    });
  });
});

describe("model settings for the operator's local models", () => {
  it("offers only the listed local models", async () => {
    rpcMock.models.list.mockResolvedValue([
      {
        provider: "local",
        providerName: "Local (Ollama / LM Studio)",
        id: "qwen3:4b",
        label: "qwen3:4b",
        billing: "Runs on your own hardware.",
        auth: "api-key" as const,
        subscription: false,
      },
    ]);
    rpcMock.models.credentials.mockResolvedValue([
      { id: "c1", provider: "local", label: "Local", hasKey: true, isDefault: true },
    ]);
    rpcMock.me.mockResolvedValue({ defaultProvider: "local", defaultModel: "qwen3:4b" });
    act(() => root.render(<ModelSettingsOverlay onClose={() => undefined} embedded />));
    await settle();

    expect(container.querySelector('[role="combobox"][aria-label="Model"]')?.textContent).toContain(
      "qwen3:4b",
    );
    const labels = [...container.querySelectorAll("button")].map((element) => element.textContent);
    expect(labels).not.toContain("Other model id");
    expect(modelIdInput()).toBeNull();
  });
});
