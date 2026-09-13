import type { ResearchErrorCode, ResearchStatus } from "@rakazo/contracts";
import { MessageBlock, ResearchErrorCodeSchema, ResearchStatusSchema } from "@rakazo/contracts";

export function researchBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "research" }> {
  const parsed = ResearchStatusSchema.safeParse(payload.status);
  const status: ResearchStatus = parsed.success ? parsed.data : "uncertain";
  const error = ResearchErrorCodeSchema.safeParse(payload.errorCode);
  const errorCode: ResearchErrorCode | undefined = error.success ? error.data : undefined;
  return {
    kind: "research",
    researchId: String(payload.researchId ?? ""),
    title: String(payload.title ?? ""),
    status,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function researchFileBlocksFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "file" }>[] {
  if (!Array.isArray(payload.files)) return [];
  const files: Extract<MessageBlock, { kind: "file" }>[] = [];
  const seen = new Set<string>();
  for (const item of payload.files) {
    const parsed = MessageBlock.safeParse(item);
    if (!parsed.success || parsed.data.kind !== "file") continue;
    if (seen.has(parsed.data.artifactId)) continue;
    seen.add(parsed.data.artifactId);
    files.push(parsed.data);
  }
  return files;
}
