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

  it("appends findings files when replaying a completed research event", () => {
    const base = { threadId: "thread", createdAt: "2026-01-01T00:00:00Z", botId: "bot" };
    const block = researchBlockFromPayload({
      researchId: "job",
      title: "Pricing survey",
      status: "running",
    });
    const findings = {
      kind: "file" as const,
      artifactId: "art-findings",
      mimeType: "application/json",
      name: "findings.json",
      size: 128,
    };
    const report = {
      kind: "file" as const,
      artifactId: "art-report",
      mimeType: "text/markdown",
      name: "report.md",
      size: 256,
    };
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
        payload: {
          ...block,
          messageId: "card",
          status: "completed",
          files: [findings, report],
        },
      },
    ]);
    expect(messages[0]?.blocks).toEqual([{ ...block, status: "completed" }, findings, report]);
  });

  it("treats an unknown status as uncertain rather than inventing progress", () => {
    expect(researchBlockFromPayload({ status: "launching", researchId: "job" })).toMatchObject({
      status: "uncertain",
      researchId: "job",
      title: "",
    });
  });

  it("carries a failure reason when the payload has one", () => {
    expect(
      researchBlockFromPayload({
        researchId: "job",
        title: "Pricing survey",
        status: "failed",
        errorCode: "unavailable",
      }),
    ).toMatchObject({ status: "failed", errorCode: "unavailable" });
  });
});
