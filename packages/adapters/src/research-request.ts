import { createHash } from "node:crypto";
import type { ResearchStartRequest } from "@rakazo/adapter-kit";
import { isResearchWorkspacePath } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import * as z from "zod";

/** Bound the serialized brief in UTF-8 bytes before it becomes a provider prompt. */
export const RESEARCH_BRIEF_MAX_BYTES = 8_192;
export const RESEARCH_BUDGET_MIN_MS = 60_000;
export const RESEARCH_BUDGET_MAX_MS = 60 * 60_000;

const briefText = z.string().trim().min(1);

/** Canonical sha256 of a JSON value; undefined members are dropped, as JSON drops them. */
export function researchDigest(value: unknown): string {
  return createHash("sha256")
    .update(stableJsonValue(JSON.parse(JSON.stringify(value))))
    .digest("hex");
}

/** Every provider validates starts through this schema, so none can accept what another refuses. */
export const researchStartRequestSchema = z
  .object({
    jobId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    workdir: z.string().max(1_024).refine(isResearchWorkspacePath, "Use a workspace-relative path"),
    brief: z
      .object({
        title: briefText.max(200),
        goal: briefText,
        context: briefText.optional(),
        preferredSources: z.array(briefText).max(50).optional(),
        successCriteria: briefText.optional(),
        nonGoals: briefText.optional(),
      })
      .strict()
      .refine(
        (brief) =>
          new TextEncoder().encode(JSON.stringify(brief)).byteLength <= RESEARCH_BRIEF_MAX_BYTES,
        `Brief exceeds ${RESEARCH_BRIEF_MAX_BYTES} UTF-8 bytes`,
      ),
    depth: z.enum(["standard", "deep"]),
    budgetMs: z.number().int().min(RESEARCH_BUDGET_MIN_MS).max(RESEARCH_BUDGET_MAX_MS),
  })
  .strict() satisfies z.ZodType<ResearchStartRequest>;
