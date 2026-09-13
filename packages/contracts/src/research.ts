import * as z from "zod";
import { IsoDate } from "./ids.js";

/** Bounds every research provider's findings must fit before they reach a thread or a prompt. */
export const RESEARCH_LIST_MAX = 200;
export const RESEARCH_TEXT_MAX_CHARS = 2_000;
export const RESEARCH_LOCATOR_MAX_CHARS = 2_048;
export const RESEARCH_FINDINGS_MAX_BYTES = 256 * 1024;

/** One research job's lifecycle. `queued` is the job before any provider has seen it. */
export const ResearchStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "uncertain",
]);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

export const ResearchErrorCodeSchema = z.enum([
  "unavailable",
  "auth_required",
  "quota_exhausted",
  "permission_denied",
  "invalid_request",
  "invalid_output",
  "provider_error",
]);
export type ResearchErrorCode = z.infer<typeof ResearchErrorCodeSchema>;

const researchText = z.string().trim().min(1).max(RESEARCH_TEXT_MAX_CHARS);

export const ResearchSourceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  kind: z.enum(["url", "file"]),
  /** An http(s) URL, or a workspace-relative path on the bot computer. */
  locator: z.string().min(1).max(RESEARCH_LOCATOR_MAX_CHARS),
  title: researchText.optional(),
  retrievedAt: IsoDate.optional(),
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const ResearchClaimSchema = z.object({
  text: researchText,
  /** `confirmed` claims rest on at least one cited source; `inference` is labeled as such. */
  label: z.enum(["confirmed", "inference"]),
  sourceIds: z.array(z.string()).max(RESEARCH_LIST_MAX),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

function researchUrlLocator(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** A normalized workspace-relative path: no absolute root, drive, backslash, or dot segment. */
export function isResearchWorkspacePath(value: string): boolean {
  if (/[\p{Cc}\\]/u.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Provider-neutral research result. Every consumer parses through this schema,
 * so a provider cannot publish a claim that cites nothing or a source nobody can open.
 */
export const ResearchFindingsSchema = z
  .object({
    summary: researchText,
    claims: z.array(ResearchClaimSchema).max(RESEARCH_LIST_MAX),
    sources: z.array(ResearchSourceSchema).max(RESEARCH_LIST_MAX),
    gaps: z.array(researchText).max(RESEARCH_LIST_MAX),
    applyNotes: z.array(researchText).max(RESEARCH_LIST_MAX),
  })
  .superRefine((findings, ctx) => {
    const sourceIds = new Set<string>();
    findings.sources.forEach((source, index) => {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({ code: "custom", path: ["sources", index, "id"], message: "Duplicate id" });
      }
      sourceIds.add(source.id);
      const valid =
        source.kind === "url"
          ? researchUrlLocator(source.locator)
          : isResearchWorkspacePath(source.locator);
      if (!valid) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "locator"],
          message: source.kind === "url" ? "Use an http(s) URL" : "Use a workspace-relative path",
        });
      }
    });
    findings.claims.forEach((claim, index) => {
      if (claim.label === "confirmed" && claim.sourceIds.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["claims", index, "sourceIds"],
          message: "A confirmed claim needs a source",
        });
      }
      for (const sourceId of claim.sourceIds) {
        if (sourceIds.has(sourceId)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["claims", index, "sourceIds"],
          message: "Unknown source id",
        });
      }
    });
    if (
      new TextEncoder().encode(JSON.stringify(findings)).byteLength > RESEARCH_FINDINGS_MAX_BYTES
    ) {
      ctx.addIssue({ code: "custom", message: "Findings exceed the size limit" });
    }
  });
export type ResearchFindings = z.infer<typeof ResearchFindingsSchema>;

/** Compact card for one research job in the requesting bot's thread. */
export const ResearchBlockSchema = z.object({
  kind: z.literal("research"),
  researchId: z.string(),
  title: z.string(),
  status: ResearchStatusSchema,
});
export type ResearchBlock = z.infer<typeof ResearchBlockSchema>;
