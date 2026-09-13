import { toolRequiresApproval } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { RESEARCH_BRIEF_MAX_BYTES } from "./research-request.js";
import {
  RESEARCH_TOOL_NAMES,
  researchStartSchema,
  selectResearchTools,
  validResearchArgs,
} from "./research-tools.js";

describe("research tool boundary", () => {
  it("hides every research tool unless the space enables research", () => {
    const hidden = selectResearchTools(builtinAgentTools, false);
    expect(hidden.some((tool) => RESEARCH_TOOL_NAMES.has(tool.name))).toBe(false);
    expect(hidden.length).toBe(builtinAgentTools.length - RESEARCH_TOOL_NAMES.size);
    expect(selectResearchTools(builtinAgentTools, true)).toBe(builtinAgentTools);
  });

  it("registers the three tools with status as the only read", () => {
    const byName = new Map(builtinAgentTools.map((tool) => [tool.name, tool]));
    for (const name of RESEARCH_TOOL_NAMES) expect(byName.has(name)).toBe(true);
    expect(byName.get("research_status")?.readOnly).toBe(true);
    expect(byName.get("research_start")?.readOnly).toBeFalsy();
    expect(byName.get("research_cancel")?.readOnly).toBeFalsy();
  });

  it("gates only the launch; status reads and cancel stops without asking", () => {
    expect(toolRequiresApproval("research_start", false)).toBe(true);
    expect(toolRequiresApproval("research_status", false)).toBe(false);
    expect(toolRequiresApproval("research_cancel", false)).toBe(false);
  });

  it("rejects malformed briefs before effect persistence", () => {
    for (const args of [
      {},
      { title: "", goal: "Compare pricing" },
      { title: "Pricing", goal: "   " },
      { title: "Pricing", goal: "Compare pricing", depth: "exhaustive" },
      { title: "Pricing", goal: "Compare pricing", extra: true },
      { title: "Pricing", goal: "Compare pricing", preferredSources: "docs" },
      { title: "x".repeat(201), goal: "Compare pricing" },
    ]) {
      expect(validResearchArgs("research_start", args)).toBe(false);
    }
    expect(validResearchArgs("research_start", { title: "Pricing", goal: "Compare pricing" })).toBe(
      true,
    );
    expect(
      validResearchArgs("research_start", {
        title: "Pricing",
        goal: "Compare pricing",
        context: "Two vendors",
        preferredSources: ["https://example.test/pricing"],
        successCriteria: "A table",
        nonGoals: "No sign-ups",
        depth: "deep",
      }),
    ).toBe(true);
  });

  it("caps the brief at the shared UTF-8 byte budget, not a character count", () => {
    const base = { title: "Pricing", goal: "Compare pricing" };
    const overhead = new TextEncoder().encode(JSON.stringify({ ...base, context: "" })).byteLength;
    const room = RESEARCH_BRIEF_MAX_BYTES - overhead;
    expect(validResearchArgs("research_start", { ...base, context: "a".repeat(room) })).toBe(true);
    expect(validResearchArgs("research_start", { ...base, context: "a".repeat(room + 1) })).toBe(
      false,
    );
    // Multi-byte text hits the cap in fewer characters than ASCII would.
    expect(validResearchArgs("research_start", { ...base, context: "é".repeat(room) })).toBe(false);
  });

  it("defaults depth to standard and trims text so the persisted brief is clean", () => {
    const parsed = researchStartSchema.parse({ title: "  Pricing ", goal: " Compare pricing " });
    expect(parsed).toEqual({ title: "Pricing", goal: "Compare pricing", depth: "standard" });
  });

  it("requires a non-empty research id for status and cancel", () => {
    for (const name of ["research_status", "research_cancel"]) {
      expect(validResearchArgs(name, { researchId: "rj_1" })).toBe(true);
      expect(validResearchArgs(name, { researchId: "" })).toBe(false);
      expect(validResearchArgs(name, { researchId: "rj_1", force: true })).toBe(false);
      expect(validResearchArgs(name, {})).toBe(false);
    }
  });
});
