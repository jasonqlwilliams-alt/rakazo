import type { ConnectorTool, ResearchBrief } from "@rakazo/adapter-kit";
import { z } from "zod";
import { RESEARCH_BRIEF_MAX_BYTES } from "./research-request.js";

export const RESEARCH_TOOL_NAMES = new Set([
  "research_start",
  "research_status",
  "research_cancel",
]);

/** Every job gets this budget; the provider's grace past it is the provider's own. */
export const RESEARCH_DEFAULT_BUDGET_MS = 30 * 60_000;

const briefText = z.string().trim().min(1);

/** The bot's request, bounded before it becomes a provider prompt. Title and goal are required. */
export const researchStartSchema = z
  .object({
    title: briefText.max(200),
    goal: briefText,
    context: briefText.optional(),
    preferredSources: z.array(briefText).max(50).optional(),
    successCriteria: briefText.optional(),
    nonGoals: briefText.optional(),
    depth: z.enum(["standard", "deep"]).default("standard"),
  })
  .strict()
  .refine(
    (args) => {
      const { depth: _depth, ...brief } = args;
      return new TextEncoder().encode(JSON.stringify(brief)).byteLength <= RESEARCH_BRIEF_MAX_BYTES;
    },
    { message: `Brief exceeds ${RESEARCH_BRIEF_MAX_BYTES} UTF-8 bytes` },
  ) satisfies z.ZodType<ResearchBrief & { depth: "standard" | "deep" }, unknown>;
export type ResearchStartArgs = z.infer<typeof researchStartSchema>;

export const researchIdSchema = z.object({ researchId: z.string().trim().min(1) }).strict();

/** Validate before effect logging, as validCloudAgentArgs does. */
export function validResearchArgs(name: string, args: unknown): boolean {
  const schema = name === "research_start" ? researchStartSchema : researchIdSchema;
  return schema.safeParse(args).success;
}

/** Research tools appear only when the Space enabled research and the bot has a computer. */
export function selectResearchTools(tools: ConnectorTool[], researchEnabled: boolean) {
  return researchEnabled ? tools : tools.filter((tool) => !RESEARCH_TOOL_NAMES.has(tool.name));
}
