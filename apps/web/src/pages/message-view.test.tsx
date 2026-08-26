/**
 * Shell.tsx now touches `window` at import time, so this guard needs a DOM even
 * though it only renders to static markup.
 *
 * @vitest-environment jsdom
 */
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageView } from "./Shell";

// The lingui macros are compiled by a vite plugin the test config does not load,
// so stand them in with identity helpers. This guard is about markup, not wording.
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

/** The exact chrome of the right-aligned bubble the user's own turns render in. */
const USER_BUBBLE = ["justify-end", "bg-[#F1F1EF]"] as const;

const SPAWN_PROMPT =
  "You are Thor. Digest is loaded (profile.md, history/digest.md, relationships.md).";

function message(role: ThreadMessage["role"], blocks: MessageBlock[]): ThreadMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    seq: 0,
    role,
    blocks,
    createdAt: new Date(0).toISOString(),
  };
}

function render(message: ThreadMessage, onOpenBot = vi.fn()) {
  return renderToStaticMarkup(
    <MessageView canAnswer={false} message={message} onAnswer={vi.fn()} onOpenBot={onOpenBot} />,
  );
}

describe("the spawn opener in a child bot's thread", () => {
  it("renders a meta block as a centered setup line, never as the user's bubble", () => {
    const html = render(message("system", [{ kind: "meta", text: SPAWN_PROMPT }]));

    expect(html).toContain(SPAWN_PROMPT);
    // Centered and muted, like the other setup lines — no bubble chrome of any kind.
    expect(html).toContain("justify-center");
    expect(html).toContain("#85858A");
    expect(html).not.toContain("rounded-[20px]");
    for (const chrome of USER_BUBBLE) expect(html).not.toContain(chrome);
  });

  it("keeps the meta block out of the user's bubble whatever role carries it", () => {
    // The bubble is keyed on `kind === "text" && role === "user"`, so a meta block cannot
    // reach it. Pinned for every role, so no future role change reopens the false attribution.
    for (const role of ["user", "bot", "system"] as const) {
      const html = render(message(role, [{ kind: "meta", text: SPAWN_PROMPT }]));

      expect(html).toContain("justify-center");
      for (const chrome of USER_BUBBLE) expect(html).not.toContain(chrome);
    }
  });

  it("shows why both halves of the fix are needed: role alone leaves a bubble", () => {
    // `role: "user"` + a text block is the defect — the spawn prompt in Jason's own bubble.
    const asUserText = render(message("user", [{ kind: "text", text: SPAWN_PROMPT }]));
    for (const chrome of USER_BUBBLE) expect(asUserText).toContain(chrome);

    // `role: "system"` alone only moves the false attribution to the bot's bubble.
    const asSystemText = render(message("system", [{ kind: "text", text: SPAWN_PROMPT }]));
    expect(asSystemText).toContain("rounded-[20px]");
    expect(asSystemText).not.toContain("justify-center");

    // Only system + meta produces the setup line.
    const asSystemMeta = render(message("system", [{ kind: "meta", text: SPAWN_PROMPT }]));
    expect(asSystemMeta).toContain("justify-center");
    expect(asSystemMeta).not.toContain("rounded-[20px]");
  });
});

const note = {
  kind: "agent_note",
  fromBotId: "bot-eleusis",
  fromName: "Eleusis",
  toBotId: "bot-thor",
  toName: "Thor",
  text: "CROSSCHAT-PROOF hold the venue list",
} as const;

function noteMessage(direction: "sent" | "received", role: ThreadMessage["role"]): ThreadMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    seq: 4,
    role,
    blocks: [{ ...note, direction }],
    createdAt: new Date(0).toISOString(),
  };
}

describe("agent note in the thread", () => {
  it("renders the sender's seat as a from/to log line, not a chat bubble", () => {
    const html = render(noteMessage("sent", "bot"));

    expect(html).toContain("[agent]");
    expect(html).toContain("sent to Thor");
    expect(html).toContain("CROSSCHAT-PROOF hold the venue list");
    // A log line, closer to `meta` than to a bubble: centered, muted, no bubble chrome.
    expect(html).toContain("justify-center");
    expect(html).toContain("#85858A");
    expect(html).not.toContain("rounded-[20px]");
  });

  it("renders the receiver's seat with the same note text, marked inbound", () => {
    const html = render(noteMessage("received", "system"));

    expect(html).toContain("[agent]");
    expect(html).toContain("from Eleusis");
    expect(html).toContain("CROSSCHAT-PROOF hold the venue list");
  });

  it("does not show the other bot's conversation", () => {
    const html = render(noteMessage("received", "system"));

    expect(html).not.toContain("thread-1");
    // Only the note text is present — the block carries nothing else to leak.
    expect(html.match(/CROSSCHAT-PROOF/g)).toHaveLength(1);
  });

  it("jumps to the other bot: the peer on each side, never itself", () => {
    // renderToStaticMarkup does not fire handlers, so assert the wiring by invoking the
    // rendered element's own onClick.
    const fromSender = vi.fn();
    elementFor(noteMessage("sent", "bot"), fromSender)?.props.onClick?.();
    expect(fromSender).toHaveBeenCalledWith("bot-thor");

    const fromReceiver = vi.fn();
    elementFor(noteMessage("received", "system"), fromReceiver)?.props.onClick?.();
    expect(fromReceiver).toHaveBeenCalledWith("bot-eleusis");
  });
});

/** The clickable element MessageView produces for a note, wherever it sits in the tree. */
function elementFor(message: ThreadMessage, onOpenBot: () => void) {
  // MessageView is wrapped in memo(), so the callable component is its inner `type`.
  const render = (MessageView as unknown as { type: (props: unknown) => unknown }).type;
  const rendered = render({
    canAnswer: false,
    message,
    onAnswer: vi.fn(),
    onOpenBot,
  });
  return findClickable(rendered);
}

type Node = { props?: { onClick?: () => void; children?: unknown } } | null | undefined;

/** Upstream reshapes this markup freely, so locate the handler rather than a fixed index. */
function findClickable(node: unknown): Node {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findClickable(child);
      if (hit) return hit;
    }
    return undefined;
  }
  const candidate = node as { props?: { onClick?: () => void; children?: unknown } };
  if (typeof candidate.props?.onClick === "function") return candidate;
  return findClickable(candidate.props?.children);
}
