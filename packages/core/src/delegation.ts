import { type RunDelegation, RunDelegationSchema } from "@rakazo/contracts";
import { connectorToolRequiresApproval } from "./action-approval.js";

/**
 * What a delegated request may do in a run. `reply` is always allowed: a delegated run can
 * answer in its own thread. `read` and `message` come from the delegation's scopes, and `work`
 * from its permission to start work.
 */
export type DelegatedCapability = "reply" | "read" | "message" | "work";

/**
 * Administration a delegated request can never run, whatever it was granted: settings, bots,
 * spaces, credentials, integrations, skills, schedules, outside agents, and the shell.
 */
export const DELEGATION_ADMIN_TOOLS: ReadonlySet<string> = new Set([
  "update_bot",
  "spawn_bot",
  "archive_bot",
  "delete_bot",
  "create_space",
  "add_mcp_server",
  "connect_agent",
  "respond_agent_connection",
  "request_secret",
  "secret_request",
  "list_secrets",
  "forget_secret",
  "skill_create",
  "skill_update",
  "skill_delete",
  "schedule_create",
  "schedule_cancel",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
  "shell",
]);

/**
 * The only built-in tools a delegated request may use, by the capability each needs. Every other
 * built-in is refused, so a new tool stays closed to delegated requests until it is added here.
 * `message_bot` is the one relay: it carries the delegation to the next run.
 */
export const DELEGATED_TOOL_CAPABILITY: Readonly<Record<string, DelegatedCapability>> = {
  message_user: "reply",
  ask_user: "reply",
  read_history: "read",
  search_history: "read",
  recall_memory: "read",
  scratchpad_list: "read",
  board_tickets: "read",
  ticket_get: "read",
  skill_read: "read",
  schedule_list: "read",
  task_catalog: "read",
  cloud_agent_status: "read",
  research_status: "read",
  run_subagent: "read",
  message_bot: "message",
  scratchpad_add: "work",
  scratchpad_update: "work",
  scratchpad_complete: "work",
  scratchpad_remove: "work",
  ticket_create: "work",
  ticket_update: "work",
  ticket_comment: "work",
  remember: "work",
  save_memory: "work",
  replace_memory_document: "work",
  save_shared_memory: "work",
  forget_memory: "work",
  research_start: "work",
  research_cancel: "work",
};

/** A granted scope is `<namespace>.<capability>`; only these capabilities grant anything. */
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*\.(read|message)$/;

export type DelegatedTool = {
  name: string;
  /** Absent for a built-in tool. */
  connector?: {
    /** The tool's declared effect. */
    readOnly?: boolean;
    /** Lazy catalog wrappers: search and load read the catalog; execute is decided again on the tool it resolves to. */
    catalog?: "search" | "load" | "execute";
  };
};

export type DelegatedToolDecision =
  | { allowed: true; capability: DelegatedCapability }
  | { allowed: false; code: "administration" | "outside_scope"; reason: string };

/** Capabilities the delegation grants, beyond replying in its own thread. */
export function delegatedCapabilities(delegation: RunDelegation): Set<DelegatedCapability> {
  const granted = new Set<DelegatedCapability>(["reply"]);
  for (const scope of delegation.scopes) {
    const capability = SCOPE_PATTERN.exec(scope)?.[1];
    if (capability === "read" || capability === "message") granted.add(capability);
  }
  if (delegation.mayStartWork) granted.add("work");
  return granted;
}

function toolCapability(tool: DelegatedTool): DelegatedCapability | null {
  if (!tool.connector) return DELEGATED_TOOL_CAPABILITY[tool.name] ?? null;
  if (tool.connector.catalog) return "read";
  // The same conservative test that decides unattended webhook approval: a declared write,
  // a mutating verb or an unrecognised name is work, never a read.
  return connectorToolRequiresApproval(tool.name, tool.connector.readOnly) ? "work" : "read";
}

const MISSING_CAPABILITY: Record<Exclude<DelegatedCapability, "reply">, string> = {
  read: "needs read access, which this delegated request was not granted",
  message:
    "relays to another bot, which needs message access this delegated request was not granted",
  work: "would start work, and this delegated request may not start work",
};

/** Whether a delegated run may call a tool. Server code decides this; the model never does. */
export function delegatedToolDecision(
  delegation: RunDelegation,
  tool: DelegatedTool,
): DelegatedToolDecision {
  if (DELEGATION_ADMIN_TOOLS.has(tool.name)) {
    return {
      allowed: false,
      code: "administration",
      reason: `Refused: ${tool.name} is administration, which a delegated request can never run. Only the owner can do this, directly.`,
    };
  }
  const capability = toolCapability(tool);
  if (!capability) {
    return {
      allowed: false,
      code: "outside_scope",
      reason: `Refused: ${tool.name} is not available to delegated requests.`,
    };
  }
  if (capability === "reply" || delegatedCapabilities(delegation).has(capability)) {
    return { allowed: true, capability };
  }
  return {
    allowed: false,
    code: "outside_scope",
    reason: `Refused: ${tool.name} ${MISSING_CAPABILITY[capability]}.`,
  };
}

/** The delegation a relay hands to the run it starts: the same request, one hop further. */
export function relayedDelegation(delegation: RunDelegation): RunDelegation {
  return { ...delegation, hop: delegation.hop + 1 };
}

/**
 * The delegation stored on a run, or null when it has none. A stored value that is not a valid
 * delegation throws, so a damaged one can never read as an owner's run.
 */
export function parseRunDelegation(value: unknown): RunDelegation | null {
  if (value === null || value === undefined) return null;
  return RunDelegationSchema.parse(value);
}

/** Model-facing note on a delegated run. It explains the limits; the tool gate enforces them. */
export function delegationInstruction(delegation: RunDelegation): string {
  const granted = delegatedCapabilities(delegation);
  const limits = [
    granted.has("read") ? "read this bot's own state" : "not read beyond this conversation",
    granted.has("message")
      ? "relay with message_bot, which passes these limits on"
      : "not relay to other bots",
    granted.has("work") ? "start work only with the owner's approval" : "not start work",
  ];
  return `This turn answers a delegated request from ${delegation.label} (request ${delegation.requestId}). The server enforces its limits: it may ${limits.join(", ")}, and it can never run administration. Answer the request within these limits. A refused tool stays refused: tell the requester what was refused instead of working around it.`;
}
