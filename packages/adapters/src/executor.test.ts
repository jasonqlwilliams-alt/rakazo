import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToText } from "./executor.js";

const note = {
  kind: "agent_note",
  fromBotId: "bot-eleusis",
  fromName: "Eleusis",
  toBotId: "bot-thor",
  toName: "Thor",
  text: "hold the venue list until I confirm",
} as const;

describe("model context for a peer note", () => {
  it("tells the receiving bot the note came from a peer, not the user", () => {
    const text = blocksToText([{ ...note, direction: "received" } as MessageBlock]);

    expect(text).toBe("[agent] note from peer bot Eleusis: hold the venue list until I confirm");
    // The bare note text alone would read as if the user had typed it.
    expect(text).not.toBe(note.text);
  });

  it("tells the sending bot the note went out", () => {
    const text = blocksToText([{ ...note, direction: "sent" } as MessageBlock]);

    expect(text).toBe("[agent] note sent to Thor: hold the venue list until I confirm");
  });

  it("leaves every other block kind alone", () => {
    expect(blocksToText([{ kind: "text", text: "plain" }])).toBe("plain");
    expect(blocksToText([{ kind: "meta", text: "Created by Chief" }])).toBe("Created by Chief");
  });
});
