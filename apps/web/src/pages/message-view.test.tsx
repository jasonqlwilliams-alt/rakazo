/**
 * Shell.tsx now touches `window` at import time, so this guard needs a DOM even
 * though it only renders to static markup.
 *
 * @vitest-environment jsdom
 */
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { reduceLiveMessageBlocks } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
const USER_BUBBLE = ["justify-end", "bg-chat-user"] as const;

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

function liveMessage(blocks: MessageBlock[]): ThreadMessage {
  return {
    id: "progress:run-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId: "run-1",
    createdAt: new Date(0).toISOString(),
  };
}

const messageProps = {
  artifactTarget: { botId: "bot-1" },
  onOpenComputer: vi.fn(),
  onOpenPeerMessages: vi.fn(),
  peerBot: vi.fn(),
  onRefresh: vi.fn(),
  onBotChanged: vi.fn(),
  onAddRoutine: vi.fn(),
  voiceReady: false,
  speaking: false,
  onSpeak: vi.fn(),
  showToolActivity: false,
};

function render(message: ThreadMessage, onOpenBot = vi.fn()) {
  return renderToStaticMarkup(
    <MessageView
      {...messageProps}
      canAnswer={false}
      message={message}
      onAnswer={vi.fn()}
      onOpenBot={onOpenBot}
    />,
  );
}

describe("live quota replay after a pending write_file", () => {
  it("shows the notice, then the replayed answer, never the stale notice after replay", () => {
    const activity = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Writing notes.txt", activity: true },
    });
    const pending = reduceLiveMessageBlocks(activity, { type: "tool", name: "write_file" });
    const notice = reduceLiveMessageBlocks(pending, {
      type: "progress",
      payload: { text: "Quota, retrying in 60s (1/3)." },
    });
    const cleared = reduceLiveMessageBlocks(notice, {
      type: "progress",
      payload: { text: "" },
    });
    const replayed = reduceLiveMessageBlocks(cleared, {
      type: "progress",
      payload: { text: "Full answer.", streaming: true },
    });

    const waiting = render(liveMessage(notice));
    expect(waiting).toContain("Quota, retrying in 60s (1/3).");
    expect(waiting).toContain('data-testid="message-bot-bubble"');
    expect(waiting).not.toContain("Writing notes.txt");
    expect(waiting).not.toContain("Write file");

    const afterReplay = render(liveMessage(replayed));
    expect(afterReplay).toContain("Full answer.");
    expect(afterReplay).toContain('data-testid="message-bot-bubble"');
    expect(afterReplay).not.toContain("Quota, retrying");
    expect(afterReplay).not.toContain("Writing notes.txt");
  });
});

describe("research card in the thread", () => {
  it("renders the title, status, and a failure reason", () => {
    const html = render(
      message("bot", [
        {
          kind: "research",
          researchId: "rj_1",
          title: "Pricing survey",
          status: "failed",
          errorCode: "unavailable",
        },
      ]),
    );
    expect(html).toContain("research-card");
    expect(html).toContain("Pricing survey");
    expect(html).toContain("failed");
    expect(html).toContain("unavailable");
  });

  it("renders findings.json and report.md chips with a completed card", () => {
    const html = render(
      message("bot", [
        {
          kind: "research",
          researchId: "rj_1",
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
      ]),
    );
    expect(html).toContain("research-card");
    expect(html).toContain("Pricing survey");
    expect(html).toContain("completed");
    expect(html).toContain("findings.json");
    expect(html).toContain("report.md");
  });

  it("treats only completed as the success color", () => {
    const completed = render(
      message("bot", [
        {
          kind: "research",
          researchId: "rj_1",
          title: "Pricing survey",
          status: "completed",
        },
      ]),
    );
    expect(completed).toContain("text-success");
    expect(completed).not.toContain("text-destructive");

    const failed = render(
      message("bot", [
        {
          kind: "research",
          researchId: "rj_1",
          title: "Pricing survey",
          status: "failed",
          errorCode: "unavailable",
        },
      ]),
    );
    expect(failed).toContain("text-destructive");
    expect(failed).not.toContain("text-success");

    for (const status of ["queued", "running", "cancelled", "timed_out", "uncertain"] as const) {
      const html = render(
        message("bot", [
          {
            kind: "research",
            researchId: "rj_1",
            title: "Pricing survey",
            status,
          },
        ]),
      );
      expect(html, status).toContain("text-muted-foreground");
      expect(html, status).not.toContain("text-success");
      expect(html, status).not.toContain("text-destructive");
    }
  });
});

describe("the spawn opener in a child bot's thread", () => {
  it("renders a meta block as a centered setup line, never as the user's bubble", () => {
    const html = render(message("system", [{ kind: "meta", text: SPAWN_PROMPT }]));

    expect(html).toContain(SPAWN_PROMPT);
    // Centered and muted, like the other setup lines — no bubble chrome of any kind.
    expect(html).toContain("justify-center");
    expect(html).toContain("text-muted-foreground");
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
    // `role: "user"` + a text block is the defect — the spawn prompt in the user's own bubble.
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
    expect(html).toContain("text-muted-foreground");
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

  it("jumps to the other bot: the peer on each side, never itself", async () => {
    const fromSender = vi.fn();
    await clickNote(noteMessage("sent", "bot"), fromSender);
    expect(fromSender).toHaveBeenCalledWith("bot-thor");

    const fromReceiver = vi.fn();
    await clickNote(noteMessage("received", "system"), fromReceiver);
    expect(fromReceiver).toHaveBeenCalledWith("bot-eleusis");
  });
});

async function clickNote(message: ThreadMessage, onOpenBot: (botId: string) => void) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <MessageView
          {...messageProps}
          canAnswer={false}
          message={message}
          onAnswer={vi.fn()}
          onOpenBot={onOpenBot}
        />,
      );
    });
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}
