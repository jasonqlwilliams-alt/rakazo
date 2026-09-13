import type { MessageBlock } from "@rakazo/contracts";
import { appendTextSegment, appendToolCallSegment, isToolActivityBlock } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  retractStreamedText,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

describe("clampUserProgressMessage", () => {
  it("trims and rejects empty text", () => {
    expect(clampUserProgressMessage("  hello  ")).toBe("hello");
    expect(clampUserProgressMessage("   ")).toBe("");
  });

  it("clamps long progress beats", () => {
    const clamped = clampUserProgressMessage("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 40));
    expect(clamped).toHaveLength(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("isProgressMessageTruncated", () => {
  it("is false for text that fits", () => {
    expect(isProgressMessageTruncated("short update")).toBe(false);
    expect(isProgressMessageTruncated("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH))).toBe(false);
  });

  it("is true for text that would be cut off by clampUserProgressMessage", () => {
    const long = "x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 1);
    expect(isProgressMessageTruncated(long)).toBe(true);
    expect(clampUserProgressMessage(long).endsWith("…")).toBe(true);
  });
});

describe("extractNarrationText", () => {
  it("pulls text blocks and current text while keeping tool activity", () => {
    const { text, remaining } = extractNarrationText(
      [
        { kind: "text", text: "Checking calendars. " },
        { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
        { kind: "text", text: "Found three options." },
      ],
      " Still looking.",
    );
    expect(text).toBe("Checking calendars. Found three options. Still looking.");
    expect(remaining).toEqual([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }]);
  });
});

describe("finalBlocksAfterMidTurnProgress", () => {
  it("drops a hollow final message that is only hidden tool activity", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
    expect(finalBlocksAfterMidTurnProgress([steps], true)).toEqual([]);
    expect(finalBlocksAfterMidTurnProgress([steps], false)).toEqual([steps]);
  });

  it("keeps a final answer alongside tool activity", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "text", text: "You are free Tuesday afternoon." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true)).toEqual(blocks);
    expect(isToolActivityBlock(blocks[0]!)).toBe(true);
  });
});

describe("botMessageOutcomeFromMidTurn", () => {
  it("prefers the final reply as a result", () => {
    expect(botMessageOutcomeFromMidTurn("All set.", ["Checking calendars…"])).toEqual({
      text: "All set.",
      intent: "result",
    });
  });

  it("returns mid-turn progress as status when there is no final reply", () => {
    expect(
      botMessageOutcomeFromMidTurn("", ["Checking calendars…", "Found three free slots."]),
    ).toEqual({
      text: "Checking calendars…\n\nFound three free slots.",
      intent: "status",
    });
  });

  it("returns null when nothing was posted", () => {
    expect(botMessageOutcomeFromMidTurn("  ", [])).toBeNull();
  });
});

describe("userProgressClientNonce", () => {
  it("tags mid-turn progress messages for reconciler detection", () => {
    const nonce = userProgressClientNonce("run-1", 0);
    expect(nonce.startsWith("user-progress:run-1:0:")).toBe(true);
    expect(isUserProgressClientNonce(nonce)).toBe(true);
    expect(userProgressClientNonce("run-1", 0)).not.toBe(nonce);
    expect(isUserProgressClientNonce(null)).toBe(false);
    expect(isUserProgressClientNonce("other")).toBe(false);
  });
});

describe("retractStreamedText", () => {
  const chip = appendToolCallSegment([], "message_user");

  it("trims the current text and leaves earlier segments alone", () => {
    const segments = appendToolCallSegment([], "write_file");
    const turn = { segments, currentText: "Saving now. ", assembled: "Saving now. " };
    expect(retractStreamedText(turn, 5, [])).toMatchObject({
      segments,
      currentText: "Saving ",
      assembled: "Saving ",
      visible: "Saving ",
    });
    expect(retractStreamedText(turn, 0, [])).toMatchObject({
      currentText: "Saving now. ",
      visible: "Saving now. ",
    });
  });

  it("reaches back past step chips a sentence boundary flushed after the discarded text", () => {
    // message_user left "Earlier." unpublished; the discarded attempt streamed "Done."
    // (which flushed the pending chip) and then " More".
    const turn = {
      segments: appendToolCallSegment(appendTextSegment([], "Earlier. Done."), "message_user"),
      currentText: " More",
      assembled: "Earlier. Done. More",
    };
    expect(retractStreamedText(turn, "Done. More".length, [])).toMatchObject({
      segments: [{ kind: "text", text: "Earlier. " }, ...chip],
      currentText: "",
      assembled: "Earlier. ",
      visible: "Earlier. ",
    });
  });

  it("drops a text segment the retraction empties", () => {
    const turn = {
      segments: appendToolCallSegment(appendTextSegment([], "Done."), "message_user"),
      currentText: "",
      assembled: "Done.",
    };
    expect(retractStreamedText(turn, 5, [])).toMatchObject({ segments: chip, assembled: "" });
  });

  it("refuses to guess when less unpublished text is there", () => {
    const segments = appendToolCallSegment(appendTextSegment([], "Done."), "message_user");
    expect(
      retractStreamedText({ segments, currentText: " More", assembled: "Done. More" }, 11, []),
    ).toBeUndefined();
    expect(
      retractStreamedText({ segments: [], currentText: "Done. More", assembled: "More" }, 5, []),
    ).toBeUndefined();
  });

  it("holds back a kept tail that could still start a secret", () => {
    const secret = "SECRETVALUE";
    const text = `Here is the key: ${secret}`;
    const kept = retractStreamedText(
      { segments: [], currentText: text, assembled: text },
      "VALUE".length,
      [secret],
    )!;
    expect(kept.assembled).toBe("Here is the key: SECRET");
    expect(kept.visible).not.toContain("SECRET");
    expect(kept.visible + kept.redactor.push("VALUE") + kept.redactor.finish()).toBe(
      "Here is the key: [redacted]",
    );
  });
});
