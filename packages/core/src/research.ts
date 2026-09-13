import type { MessageBlock, ResearchStatus } from "@rakazo/contracts";
import { ResearchStatusSchema } from "@rakazo/contracts";

export function researchBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "research" }> {
  const parsed = ResearchStatusSchema.safeParse(payload.status);
  const status: ResearchStatus = parsed.success ? parsed.data : "uncertain";
  return {
    kind: "research",
    researchId: String(payload.researchId ?? ""),
    title: String(payload.title ?? ""),
    status,
  };
}
