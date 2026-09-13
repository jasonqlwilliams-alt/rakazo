import { describe, expect, it } from "vitest";
import { projectMessages } from "./events.js";
import { researchBlockFromPayload } from "./research.js";

describe("shared research projection", () => {
  it("updates an existing card when replaying durable events", () => {
    const base = { threadId: "thread", createdAt: "2026-01-01T00:00:00Z", botId: "bot" };
    const block = researchBlockFromPayload({
      researchId: "job",
      title: "Pricing survey",
      status: "queued",
    });
    const messages = projectMessages([
      {
        ...base,
        id: "first",
        seq: 1,
        type: "thread.message.created",
        payload: { messageId: "card", role: "bot", blocks: [block] },
      },
      {
        ...base,
        id: "second",
        seq: 2,
        type: "thread.research",
        payload: { ...block, messageId: "card", status: "completed" },
      },
    ]);
    expect(messages[0]?.blocks[0]).toMatchObject({
      kind: "research",
      researchId: "job",
      title: "Pricing survey",
      status: "completed",
    });
  });

  it("treats an unknown status as uncertain rather than inventing progress", () => {
    expect(researchBlockFromPayload({ status: "launching", researchId: "job" })).toMatchObject({
      status: "uncertain",
      researchId: "job",
      title: "",
    });
  });
});
