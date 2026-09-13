import { describe, expect, it } from "vitest";
import {
  isResearchWorkspacePath,
  MessageBlock,
  ProductEventType,
  RESEARCH_FINDINGS_MAX_BYTES,
  RESEARCH_LIST_MAX,
  RESEARCH_TEXT_MAX_CHARS,
  ResearchFindingsSchema,
  RunActivityRowSchema,
  RunSchema,
} from "./index.js";

const findings = {
  summary: "Two sources agree on the fixture fact.",
  claims: [
    { text: "The fixture fact holds.", label: "confirmed", sourceIds: ["s1", "s2"] },
    { text: "It probably holds next year too.", label: "inference", sourceIds: [] },
  ],
  sources: [
    {
      id: "s1",
      kind: "url",
      locator: "https://research.test/a",
      retrievedAt: "2026-01-01T00:00:00Z",
    },
    { id: "s2", kind: "file", locator: "research/job-1/notes.md" },
  ],
  gaps: ["No third source was found."],
  applyNotes: ["Update the fixture page."],
};

function issues(value: unknown): string[] {
  const result = ResearchFindingsSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("research contracts", () => {
  it("accepts cited findings with labeled inference", () => {
    expect(ResearchFindingsSchema.parse(findings)).toEqual(findings);
  });

  it("requires every confirmed claim to cite a known source", () => {
    expect(
      issues({
        ...findings,
        claims: [{ text: "Uncited.", label: "confirmed", sourceIds: [] }],
      }),
    ).toEqual(["A confirmed claim needs a source"]);
    expect(
      issues({
        ...findings,
        claims: [{ text: "Dangling.", label: "inference", sourceIds: ["missing"] }],
      }),
    ).toEqual(["Unknown source id"]);
    expect(
      issues({ ...findings, sources: [findings.sources[0], { ...findings.sources[1], id: "s1" }] }),
    ).toContain("Duplicate id");
  });

  it("only accepts sources a reader can open safely", () => {
    for (const locator of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@research.test/a",
      "not a url",
    ]) {
      expect(
        issues({
          ...findings,
          sources: [{ ...findings.sources[0], locator }, findings.sources[1]],
        }),
        locator,
      ).toEqual(["Use an http(s) URL"]);
    }
    for (const locator of [
      "/etc/passwd",
      "C:/Users/x",
      "a/../b",
      "./a",
      "a//b",
      "a\\b",
      "a\u0000b",
    ]) {
      expect(isResearchWorkspacePath(locator), locator).toBe(false);
    }
    expect(isResearchWorkspacePath("bots/bot-1/research/job-1/report.md")).toBe(true);
  });

  it("bounds text, lists and total size", () => {
    expect(issues({ ...findings, summary: "x".repeat(RESEARCH_TEXT_MAX_CHARS + 1) })).toHaveLength(
      1,
    );
    expect(
      issues({ ...findings, gaps: Array.from({ length: RESEARCH_LIST_MAX + 1 }, () => "gap") }),
    ).toHaveLength(1);
    const long = "x".repeat(RESEARCH_TEXT_MAX_CHARS);
    const oversized = {
      ...findings,
      gaps: Array.from(
        { length: Math.ceil(RESEARCH_FINDINGS_MAX_BYTES / long.length) },
        () => long,
      ),
    };
    expect(issues(oversized)).toEqual(["Findings exceed the size limit"]);
  });

  it("carries the research card, event and run trigger through shared contracts", () => {
    const block = {
      kind: "research",
      researchId: "job-1",
      title: "Fixture topic",
      status: "queued",
    };
    expect(MessageBlock.parse(block)).toEqual(block);
    expect(MessageBlock.safeParse({ ...block, status: "launching" }).success).toBe(false);
    expect(ProductEventType.options).toContain("thread.research");
    expect(RunActivityRowSchema.shape.trigger.options).toContain("research");
    expect(RunSchema.shape.trigger.options).toContain("research");
  });
});
