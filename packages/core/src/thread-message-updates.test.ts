import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  takeLiveMessage,
  updateCloudAgentMessages,
  updateResearchMessages,
} from "./thread-message-updates.js";

const cloud = (agentId: string): MessageBlock => ({
  kind: "cloud_agent",
  agentId,
  title: "Agent",
  status: "running",
  url: "",
});

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("updates every matching cloud block while preserving metadata and unrelated messages", () => {
    const messages = [
      { id: "first", replyToMessageId: "reply", blocks: [cloud("agent"), cloud("other")] },
      { id: "second", replyToMessageId: "reply", blocks: [cloud("agent")] },
      {
        id: "third",
        replyToMessageId: "reply",
        blocks: [{ kind: "text", text: "unchanged" } as MessageBlock],
      },
    ];
    const result = updateCloudAgentMessages(messages, {
      messageId: "first",
      agentId: "agent",
      status: "finished",
    });
    expect(result.map((message) => message.id)).toEqual(["first", "second", "third"]);
    expect(result[0]?.replyToMessageId).toBe("reply");
    expect(result[0]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[1]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]?.blocks[0]).toMatchObject({ status: "running" });
  });

  it("updates every matching research block while preserving unrelated messages", () => {
    const research = (researchId: string, status: "running" | "completed" = "running") => ({
      kind: "research" as const,
      researchId,
      title: "Pricing survey",
      status,
    });
    const messages = [
      { id: "first", blocks: [research("job"), research("other")] },
      { id: "second", blocks: [research("job")] },
      { id: "third", blocks: [{ kind: "text" as const, text: "unchanged" }] },
    ];
    const result = updateResearchMessages(messages, {
      messageId: "first",
      researchId: "job",
      title: "Pricing survey",
      status: "completed",
    });
    expect(result[0]?.blocks[0]).toMatchObject({ researchId: "job", status: "completed" });
    expect(result[1]?.blocks[0]).toMatchObject({ researchId: "job", status: "completed" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
  });

  it("appends research file blocks once and ignores junk or duplicates", () => {
    const research = {
      kind: "research" as const,
      researchId: "job",
      title: "Pricing survey",
      status: "running" as const,
    };
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
    const messages = [{ id: "card", blocks: [research] }];
    const completed = {
      messageId: "card",
      researchId: "job",
      title: "Pricing survey",
      status: "completed",
      files: [findings, report, { kind: "text", text: "nope" }, findings],
    };
    const first = updateResearchMessages(messages, completed);
    expect(first[0]?.blocks).toEqual([
      { ...research, status: "completed" },
      findings,
      report,
    ]);
    const second = updateResearchMessages(first, completed);
    expect(second[0]?.blocks).toEqual(first[0]?.blocks);
    expect(messages[0]?.blocks).toEqual([research]);
  });
});
