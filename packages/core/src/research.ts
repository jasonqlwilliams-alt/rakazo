import type { MessageBlock, ResearchErrorCode, ResearchStatus } from "@rakazo/contracts";
import { ResearchErrorCodeSchema, ResearchStatusSchema } from "@rakazo/contracts";

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
