import { Trans } from "@lingui/react/macro";
import type { MessageBlock, ResearchErrorCode, ResearchStatus } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { BuiCard } from "./ai/primitives";

function statusWord(status: ResearchStatus) {
  switch (status) {
    case "queued":
      return <Trans>queued</Trans>;
    case "running":
      return <Trans>running</Trans>;
    case "completed":
      return <Trans>completed</Trans>;
    case "failed":
      return <Trans>failed</Trans>;
    case "cancelled":
      return <Trans>cancelled</Trans>;
    case "timed_out":
      return <Trans>timeout</Trans>;
    default:
      return <Trans>uncertain</Trans>;
  }
}

function failureReason(code: ResearchErrorCode) {
  switch (code) {
    case "unavailable":
      return <Trans>unavailable</Trans>;
    case "auth_required":
      return <Trans>auth</Trans>;
    case "quota_exhausted":
      return <Trans>quota</Trans>;
    case "permission_denied":
      return <Trans>permission</Trans>;
    case "invalid_request":
      return <Trans>invalid</Trans>;
    case "invalid_output":
      return <Trans>output</Trans>;
    default:
      return <Trans>error</Trans>;
  }
}

export function ResearchCard({ block }: { block: Extract<MessageBlock, { kind: "research" }> }) {
  const failed = block.status === "failed";
  return (
    <BuiCard className="w-80 max-w-full px-4 py-3" data-testid="research-card">
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium" dir="auto">
          {block.title}
        </span>
        <Badge
          variant="secondary"
          className={
            failed
              ? "text-destructive"
              : block.status === "completed"
                ? "text-success"
                : "text-muted-foreground"
          }
        >
          {statusWord(block.status)}
        </Badge>
      </div>
      {failed && block.errorCode ? (
        <span className="mt-2 text-muted-foreground">{failureReason(block.errorCode)}</span>
      ) : null}
    </BuiCard>
  );
}
