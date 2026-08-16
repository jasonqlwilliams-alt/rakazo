import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageView } from "./Shell";

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

function render(message: ThreadMessage) {
  return renderToStaticMarkup(
    <MessageView canAnswer={false} message={message} onAnswer={vi.fn()} onOpenBot={vi.fn()} />,
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
