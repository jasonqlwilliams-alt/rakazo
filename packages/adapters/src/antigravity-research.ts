import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  ResearchBrief,
  ResearchJobRef,
  ResearchObservation,
  ResearchObservedStatus,
  ResearchProvider,
  ResearchReceipt,
  ResearchStartRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ResearchErrorCode, ResearchFindings } from "@rakazo/contracts";
import { ResearchErrorCodeSchema, ResearchFindingsSchema } from "@rakazo/contracts";
import * as z from "zod";
import {
  cancelComputerRunWorkArgv,
  interpretBackgroundWorkProbe,
  researchWorkLaunchArgv,
  researchWorkProbeArgv,
  researchWorkRunId,
} from "./computer-idle.js";
import { researchDigest, researchStartRequestSchema } from "./research-request.js";

/**
 * Antigravity as a library: everything Rakazo knows about the `agy` CLI lives
 * here, typed and testable with fixtures. The provider at the bottom runs one
 * research job on the bot computer through the shared background-work scripts
 * and never touches a database, a run, or Antigravity's own state on disk.
 */

export const ANTIGRAVITY_RESEARCH_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_RESEARCH_ADAPTER_VERSION = "0.1.0";
/** Bounded reads of the job folder; anything larger ends the job as invalid output. */
export const ANTIGRAVITY_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
export const ANTIGRAVITY_STDERR_MAX_BYTES = 64 * 1024;
/** Time past the budget before a still-running process is killed and the job times out. */
export const ANTIGRAVITY_BUDGET_GRACE_MS = 2 * 60_000;
/** Flags the harness never passes; the argv test forbids them by name. */
export const ANTIGRAVITY_FORBIDDEN_FLAGS = [
  "--dangerously-skip-permissions",
  "--new-project",
  "--add-dir",
] as const;

/** Files inside one job's workdir. The launch script owns events, stderr and exit. */
export const ANTIGRAVITY_JOB_FILES = {
  schema: "findings.schema.json",
  launch: "launch.json",
  events: "events.ndjson",
  stderr: "stderr.log",
  log: "agy.log",
  exitCode: "exit.code",
  cancel: "cancel.requested",
  outcome: "outcome.json",
  findings: "findings.json",
  report: "report.md",
} as const;

const flagValue = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("-") && !/[\p{Cc}]/u.test(value), "Not a flag value");

/** Space-level Antigravity settings. Model, project and executable never come from a bot request. */
export const antigravityResearchSettingsSchema = z
  .object({
    executable: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !value.startsWith("-") && !/[\p{Cc}]/u.test(value), "Not a command")
      .default("agy"),
    model: flagValue,
    project: flagValue.optional(),
    /** Execution mode passed as-is; the default follows the only live-run precedent so far. */
    mode: z.enum(["accept-edits", "plan"]).default("accept-edits"),
  })
  .strict();
export type AntigravityResearchSettings = z.infer<typeof antigravityResearchSettingsSchema>;
export type AntigravityResearchSettingsInput = z.input<typeof antigravityResearchSettingsSchema>;

/** JSON Schema handed to `--json-schema`; the harness still validates the result itself. */
export function antigravityFindingsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ResearchFindingsSchema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
}

const BRIEF_SECTIONS: Array<[keyof ResearchBrief, string]> = [
  ["goal", "Goal"],
  ["context", "Context"],
  ["preferredSources", "Preferred sources"],
  ["successCriteria", "Success criteria"],
  ["nonGoals", "Non-goals"],
];

/**
 * The prompt is the brief's fields verbatim under fixed headings plus the
 * output contract. Nothing is escaped or reflowed: the text travels as one
 * argv element and never through a shell.
 */
export function renderAntigravityBrief(brief: ResearchBrief, depth: "standard" | "deep"): string {
  const lines = [`# Research brief: ${brief.title}`, ""];
  for (const [field, heading] of BRIEF_SECTIONS) {
    const value = brief[field];
    if (value === undefined) continue;
    lines.push(`## ${heading}`);
    if (Array.isArray(value)) lines.push(...value.map((entry) => `- ${entry}`));
    else lines.push(value);
    lines.push("");
  }
  lines.push(
    "## Output contract",
    `Depth: ${depth}.`,
    "Research with the tools you have, then return only the final JSON document that satisfies the provided JSON schema: summary, claims, sources, gaps and applyNotes.",
    'Label each claim "confirmed" only when it cites at least one listed source by id; label everything else "inference".',
    "List every source you relied on with an http(s) URL or a path relative to the current directory. Do not invent sources.",
    "Record what you could not verify under gaps. Keep apply notes short and actionable.",
    "Do not modify files outside the current directory and do not run commands that change the system.",
  );
  return lines.join("\n");
}

export function antigravityEffort(depth: "standard" | "deep"): "medium" | "high" {
  return depth === "deep" ? "high" : "medium";
}

/**
 * The exact `agy` argv for one job. Every valued flag uses the `--flag=value`
 * form so a value can never be read as another flag, the brief is one element,
 * and the executable path is one element even when it contains spaces.
 */
export function antigravityResearchArgv(
  settings: AntigravityResearchSettings,
  request: Pick<ResearchStartRequest, "brief" | "depth" | "budgetMs">,
): string[] {
  return [
    settings.executable,
    `--print=${renderAntigravityBrief(request.brief, request.depth)}`,
    "--output-format=stream-json",
    `--json-schema=${ANTIGRAVITY_JOB_FILES.schema}`,
    `--model=${settings.model}`,
    `--effort=${antigravityEffort(request.depth)}`,
    `--mode=${settings.mode}`,
    "--sandbox",
    `--print-timeout=${Math.ceil(request.budgetMs / 1000)}s`,
    `--log-file=${ANTIGRAVITY_JOB_FILES.log}`,
    ...(settings.project ? [`--project=${settings.project}`] : []),
  ];
}

export interface AntigravityStderrSignals {
  authRequired: boolean;
  quotaExhausted: boolean;
  usageError: boolean;
  /** The print timeout returned partial output; the CLI still exits 0 in that case. */
  timedOut: boolean;
  permissionDenials: number;
  /** A line with the CLI's stable `error:` marker. */
  fatalError: boolean;
  /** First error line, for the receipt's reason. */
  firstError?: string;
}

const STDERR_RULES = {
  authRequired:
    /headless ?auth|authentication (?:is )?required|not (?:signed|logged) in|sign in (?:to|at)|auth(?:orization|entication)? (?:required|expired)|invalid_grant/i,
  quotaExhausted: /quota|rate.?limit|resource.?exhausted|too many requests|\b429\b/i,
  usageError:
    /^(?:error: )?(?:unknown (?:flag|shorthand flag|command)|unexpected argument|flag needs an argument|invalid (?:argument|value)|usage:)/i,
  timedOut: /print.?timeout|timed out|timeout (?:of|after).*(?:partial|reached)|partial output/i,
  permissionDenial:
    /permission (?:denied|auto-denied|rejected)|auto-den(?:ied|y)|denied permission/i,
  fatalError: /^error:/i,
};

/**
 * Classify stderr line by line. Patterns cover the messages the changelog and
 * the operator's failure notes describe; captured fixtures refine them here
 * and nowhere else.
 */
export function classifyAntigravityStderr(stderr: string): AntigravityStderrSignals {
  const signals: AntigravityStderrSignals = {
    authRequired: false,
    quotaExhausted: false,
    usageError: false,
    timedOut: false,
    permissionDenials: 0,
    fatalError: false,
  };
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (STDERR_RULES.authRequired.test(line)) signals.authRequired = true;
    if (STDERR_RULES.quotaExhausted.test(line)) signals.quotaExhausted = true;
    if (STDERR_RULES.usageError.test(line)) signals.usageError = true;
    if (STDERR_RULES.timedOut.test(line)) signals.timedOut = true;
    if (STDERR_RULES.permissionDenial.test(line)) signals.permissionDenials++;
    if (STDERR_RULES.fatalError.test(line)) {
      signals.fatalError = true;
      signals.firstError ??= line;
    }
  }
  return signals;
}

export interface AntigravityEventLog {
  events: Array<Record<string, unknown>>;
  malformedLines: number;
}

/** NDJSON from `--output-format stream-json`; lines that are not JSON objects are counted, not fatal. */
export function parseAntigravityEvents(text: string): AntigravityEventLog {
  const log: AntigravityEventLog = { events: [], malformedLines: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        log.events.push(parsed as Record<string, unknown>);
      } else {
        log.malformedLines++;
      }
    } catch {
      log.malformedLines++;
    }
  }
  return log;
}

function stringField(event: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * The final structured result, if the stream carried one: the last `result`
 * event's structured output, or the `response` of a status envelope as the
 * dry run returned. A string result is parsed as JSON, with a fenced block
 * tolerated. Returns undefined when nothing final was produced.
 */
export function antigravityFinalResult(log: AntigravityEventLog): unknown {
  for (let index = log.events.length - 1; index >= 0; index--) {
    const event = log.events[index]!;
    let value: unknown;
    if (event.type === "result") {
      value = event.structured_output ?? event.structuredOutput ?? event.result ?? event.response;
    } else if (typeof event.status === "string" && event.response !== undefined) {
      value = event.response;
    } else {
      continue;
    }
    if (typeof value !== "string") return value;
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(value.trim());
    try {
      return JSON.parse(fenced ? fenced[1]! : value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** An opaque conversation handle, if the stream names one; kept for inspection only. */
export function antigravityConversationRef(log: AntigravityEventLog): string | undefined {
  for (const event of log.events) {
    const ref = stringField(event, "conversation_id", "conversationId");
    if (ref) return ref;
  }
  return undefined;
}

export interface AntigravityJobState {
  /** Present once the launch wrapper wrote exit.code. */
  exitCode?: number;
  events: string;
  stderr: string;
  eventsBytes: number;
  stderrBytes: number;
  /** Consulted only while exit.code is absent. */
  marker: "active" | "idle" | "unknown";
  cancelRequested: boolean;
}

export interface AntigravityOutcome {
  status: ResearchObservedStatus;
  errorCode?: ResearchErrorCode;
  findings?: ResearchFindings;
  truncated: boolean;
  permissionDenials: number;
  reason: string;
  providerRef?: string;
}

const TIMEOUT_EXIT_CODES = new Set([124, 137]);
const MISSING_EXIT_CODES = new Set([126, 127]);

function failure(
  errorCode: ResearchErrorCode,
  reason: string,
  extra: Partial<AntigravityOutcome> = {},
): AntigravityOutcome {
  return {
    status: "failed",
    errorCode,
    truncated: false,
    permissionDenials: 0,
    ...extra,
    reason,
  };
}

/**
 * Map one job's files and marker to its exact status and error code. Pure, so
 * every fixture in testing/fixtures/agy pins one row of this table.
 */
export function resolveAntigravityOutcome(state: AntigravityJobState): AntigravityOutcome {
  if (state.eventsBytes > ANTIGRAVITY_EVENTS_MAX_BYTES) {
    return failure("invalid_output", "events.ndjson exceeds the read bound", { truncated: true });
  }
  if (state.stderrBytes > ANTIGRAVITY_STDERR_MAX_BYTES) {
    return failure("invalid_output", "stderr.log exceeds the read bound", { truncated: true });
  }
  const signals = classifyAntigravityStderr(state.stderr);
  const log = parseAntigravityEvents(state.events);
  const providerRef = antigravityConversationRef(log);
  const base = { permissionDenials: signals.permissionDenials, providerRef };

  if (state.exitCode === undefined) {
    if (state.marker === "active") {
      return { status: "running", truncated: false, reason: "process holds the marker", ...base };
    }
    if (state.marker === "unknown") {
      return { status: "running", truncated: false, reason: "marker probe unavailable", ...base };
    }
    if (state.cancelRequested) {
      return { status: "cancelled", truncated: true, reason: "cancelled before exit", ...base };
    }
    return {
      status: "uncertain",
      truncated: true,
      reason: "process ended without an exit code",
      ...base,
    };
  }

  const exit = `exit ${state.exitCode}`;
  if (signals.timedOut || (TIMEOUT_EXIT_CODES.has(state.exitCode) && !state.cancelRequested)) {
    return { status: "timed_out", truncated: true, reason: `print timeout (${exit})`, ...base };
  }
  if (MISSING_EXIT_CODES.has(state.exitCode)) {
    return failure("unavailable", signals.firstError ?? `executable unavailable (${exit})`, base);
  }
  if (signals.authRequired) {
    return failure("auth_required", signals.firstError ?? `sign-in required (${exit})`, base);
  }
  if (signals.quotaExhausted) {
    return failure("quota_exhausted", signals.firstError ?? `quota exhausted (${exit})`, base);
  }
  if (signals.usageError && state.exitCode !== 0) {
    return failure("invalid_request", signals.firstError ?? `usage error (${exit})`, base);
  }
  if (state.cancelRequested && state.exitCode !== 0) {
    return { status: "cancelled", truncated: true, reason: `cancelled (${exit})`, ...base };
  }
  if (state.exitCode !== 0) {
    return failure("provider_error", signals.firstError ?? exit, base);
  }
  const result = antigravityFinalResult(log);
  if (result === undefined) {
    return signals.fatalError
      ? failure("provider_error", signals.firstError ?? "no final result", base)
      : failure("invalid_output", "no final result in the event stream", base);
  }
  const parsed = ResearchFindingsSchema.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      "invalid_output",
      `findings rejected: ${issue ? `${issue.path.join(".") || "document"}: ${issue.message}` : "schema"}`,
      base,
    );
  }
  if (signals.permissionDenials > 0 && parsed.data.sources.length === 0) {
    return failure("permission_denied", "every source read was denied", base);
  }
  return {
    status: "completed",
    findings: parsed.data,
    truncated: false,
    reason: "final result validated",
    ...base,
  };
}

function bullets(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["None."];
}

/** Deterministic report.md in pack order, rendered only from validated findings. */
export function renderResearchReport(findings: ResearchFindings): string {
  const claims = (label: "confirmed" | "inference") =>
    findings.claims
      .filter((claim) => claim.label === label)
      .map((claim) =>
        claim.sourceIds.length ? `${claim.text} [${claim.sourceIds.join(", ")}]` : claim.text,
      );
  const sources = findings.sources.map((source) => {
    const parts = [`[${source.id}]`, source.title ? `${source.title}:` : undefined, source.locator];
    if (source.retrievedAt) parts.push(`(retrieved ${source.retrievedAt})`);
    return parts.filter(Boolean).join(" ");
  });
  return [
    "# Research report",
    "",
    "## Summary",
    findings.summary,
    "",
    "## Confirmed",
    ...bullets(claims("confirmed")),
    "",
    "## Inference",
    ...bullets(claims("inference")),
    "",
    "## Gaps",
    ...bullets(findings.gaps),
    "",
    "## Apply notes",
    ...bullets(findings.applyNotes),
    "",
    "## Sources",
    ...bullets(sources),
    "",
  ].join("\n");
}

/**
 * One command lists the job folder so observation never has to tell a missing
 * file from a failed read: files are read only after this listing names them.
 * Output: a header line, `file <name> <bytes>` per present file, `exit <code>`.
 */
export const ANTIGRAVITY_JOB_SNAPSHOT = [
  'workdir="$1"',
  "printf 'rakazo-research-snapshot\\n'",
  '[ -d "$workdir" ] || exit 0',
  'cd -- "$workdir" || exit 3',
  `for f in ${Object.values(ANTIGRAVITY_JOB_FILES).join(" ")}; do`,
  `  if [ -e "$f" ]; then printf 'file %s %s\\n' "$f" "$(wc -c <"$f" | tr -d '[:space:]')"; fi`,
  "done",
  `if [ -e ${ANTIGRAVITY_JOB_FILES.exitCode} ]; then printf 'exit %s\\n' "$(tr -d '[:space:]' <${ANTIGRAVITY_JOB_FILES.exitCode})"; fi`,
  "exit 0",
].join("\n");

export function antigravityJobSnapshotArgv(workdir: string): string[] {
  return ["bash", "-c", ANTIGRAVITY_JOB_SNAPSHOT, "rakazo-research-snapshot", workdir];
}

export interface AntigravityJobSnapshot {
  files: Map<string, number>;
  exitCode?: number;
}

export function parseAntigravityJobSnapshot(stdout: string): AntigravityJobSnapshot | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "rakazo-research-snapshot") return undefined;
  const snapshot: AntigravityJobSnapshot = { files: new Map() };
  for (const line of lines.slice(1)) {
    const file = /^file (\S+) (\d+)$/.exec(line);
    if (file) {
      snapshot.files.set(file[1]!, Number(file[2]));
      continue;
    }
    const exit = /^exit (-?\d+)$/.exec(line);
    if (exit) snapshot.exitCode = Number(exit[1]);
  }
  return snapshot;
}

const launchRecordSchema = z.object({
  jobId: z.string(),
  computerId: z.string(),
  workdir: z.string(),
  requestSha256: z.string(),
  model: z.string(),
  startedAt: z.string(),
  budgetMs: z.number().int(),
  nonce: z.string(),
});
type LaunchRecord = z.infer<typeof launchRecordSchema>;

const outcomeRecordSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled", "timed_out", "uncertain"]),
  errorCode: ResearchErrorCodeSchema.optional(),
  truncated: z.boolean(),
  permissionDenials: z.number().int().nonnegative(),
  exitCode: z.number().int().optional(),
  finishedAt: z.string(),
  reason: z.string(),
  findingsSha256: z.string().optional(),
  providerRef: z.string().optional(),
});
type OutcomeRecord = z.infer<typeof outcomeRecordSchema>;

export type AntigravityResearchSandbox = Pick<
  SandboxProvider,
  "execute" | "readFile" | "writeFile"
>;

export interface AntigravityResearchProviderOptions {
  sandbox: AntigravityResearchSandbox;
  settings: AntigravityResearchSettingsInput;
  now?: () => Date;
  nonce?: () => string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Runs `agy` detached on the bot computer under the background-work marker,
 * keeps every job fact in the job folder, and classifies the end from files.
 * Idempotent on jobId through launch.json: a replay observes, never launches.
 */
export class AntigravityResearchProvider implements ResearchProvider {
  private readonly sandbox: AntigravityResearchSandbox;
  private readonly settings: AntigravityResearchSettings;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(options: AntigravityResearchProviderOptions) {
    this.sandbox = options.sandbox;
    this.settings = antigravityResearchSettingsSchema.parse(options.settings);
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
  }

  describe() {
    return {
      id: ANTIGRAVITY_RESEARCH_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: ANTIGRAVITY_RESEARCH_ADAPTER_VERSION,
      capabilities: { cancel: true, offline: false },
    };
  }

  async start(
    computer: ComputerRef,
    request: ResearchStartRequest,
    context: AdapterContext,
  ): Promise<ResearchObservation> {
    context.signal.throwIfAborted();
    const parsed = researchStartRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.bare(request.jobId, "failed", { errorCode: "invalid_request" });
    }
    const job = parsed.data;
    const snapshot = await this.snapshot(computer, job.workdir, context);
    if (snapshot.files.has(ANTIGRAVITY_JOB_FILES.launch)) {
      return this.observe(computer, job, context);
    }
    const launch: LaunchRecord = {
      jobId: job.jobId,
      computerId: job.computerId,
      workdir: job.workdir,
      requestSha256: researchDigest(job),
      model: this.settings.model,
      startedAt: this.now().toISOString(),
      budgetMs: job.budgetMs,
      nonce: this.nonce(),
    };
    await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.schema, {
      content: JSON.stringify(antigravityFindingsJsonSchema(), null, 2),
      context,
    });
    // The fence: once this file exists the job is dispatched and never launched again.
    await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.launch, {
      content: JSON.stringify(launch, null, 2),
      context,
    });
    const launched = await this.run(
      computer,
      researchWorkLaunchArgv({
        computerId: job.computerId,
        jobId: job.jobId,
        nonce: launch.nonce,
        workdir: job.workdir,
        hardTimeoutSeconds: Math.ceil((job.budgetMs + ANTIGRAVITY_BUDGET_GRACE_MS) / 1000),
        command: antigravityResearchArgv(this.settings, job),
      }),
      context,
      30_000,
    );
    if (launched.code !== 0) {
      const after = await this.snapshot(computer, job.workdir, context);
      // The launch script creates events.ndjson before it starts the process;
      // without it nothing ran, so record the launch failure as unavailable.
      if (!after.files.has(ANTIGRAVITY_JOB_FILES.events) && after.exitCode === undefined) {
        await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.stderr, {
          content: `error: research launch failed (exit ${launched.code}): ${launched.stderr.trim()}\n`,
          context,
        });
        await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.exitCode, {
          content: "127\n",
          context,
        });
      }
    }
    return this.observe(computer, job, context);
  }

  async observe(
    computer: ComputerRef,
    job: ResearchJobRef,
    context: AdapterContext,
  ): Promise<ResearchObservation> {
    context.signal.throwIfAborted();
    const snapshot = await this.snapshot(computer, job.workdir, context);
    const launch = await this.launchRecord(computer, job, snapshot, context);
    if (!launch) return this.bare(job.jobId, "uncertain");
    const settled = await this.settledObservation(computer, job, launch, snapshot, context);
    if (settled) return settled;
    const state = await this.jobState(computer, job, launch, snapshot, context);
    let outcome = resolveAntigravityOutcome(state);
    const exitCode = state.exitCode;
    if (outcome.status === "running" && this.deadlineExceeded(launch)) {
      await this.kill(computer, launch, context);
      const marker = await this.probe(computer, launch, context);
      if (marker === "idle") {
        outcome = {
          ...outcome,
          status: "timed_out",
          truncated: true,
          reason: "killed after the budget and grace elapsed",
        };
      }
    }
    if (outcome.status === "running") return this.running(launch, outcome);
    return this.settle(computer, job, launch, outcome, exitCode, context);
  }

  async cancel(
    computer: ComputerRef,
    job: ResearchJobRef,
    context: AdapterContext,
  ): Promise<ResearchObservation> {
    context.signal.throwIfAborted();
    const snapshot = await this.snapshot(computer, job.workdir, context);
    const launch = await this.launchRecord(computer, job, snapshot, context);
    if (!launch) return this.bare(job.jobId, "uncertain");
    const settled = await this.settledObservation(computer, job, launch, snapshot, context);
    if (settled) return settled;
    if (!snapshot.files.has(ANTIGRAVITY_JOB_FILES.cancel)) {
      await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.cancel, {
        content: `${this.now().toISOString()}\n`,
        context,
      });
    }
    if (snapshot.exitCode === undefined) await this.kill(computer, launch, context);
    return this.observe(computer, job, context);
  }

  private async snapshot(computer: ComputerRef, workdir: string, context: AdapterContext) {
    const result = await this.run(computer, antigravityJobSnapshotArgv(workdir), context, 15_000);
    const snapshot = parseAntigravityJobSnapshot(result.stdout);
    if (!snapshot) {
      throw new Error(
        `research job snapshot unavailable (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return snapshot;
  }

  private async launchRecord(
    computer: ComputerRef,
    job: ResearchJobRef,
    snapshot: AntigravityJobSnapshot,
    context: AdapterContext,
  ): Promise<LaunchRecord | undefined> {
    if (!snapshot.files.has(ANTIGRAVITY_JOB_FILES.launch)) return undefined;
    const launch = launchRecordSchema.parse(
      JSON.parse(await this.read(computer, job.workdir, ANTIGRAVITY_JOB_FILES.launch, context)),
    );
    if (launch.jobId !== job.jobId) {
      throw new Error(`research job folder ${job.workdir} belongs to ${launch.jobId}`);
    }
    return launch;
  }

  private async settledObservation(
    computer: ComputerRef,
    job: ResearchJobRef,
    launch: LaunchRecord,
    snapshot: AntigravityJobSnapshot,
    context: AdapterContext,
  ): Promise<ResearchObservation | undefined> {
    if (!snapshot.files.has(ANTIGRAVITY_JOB_FILES.outcome)) return undefined;
    const outcome = outcomeRecordSchema.parse(
      JSON.parse(await this.read(computer, job.workdir, ANTIGRAVITY_JOB_FILES.outcome, context)),
    );
    const findings =
      outcome.status === "completed"
        ? ResearchFindingsSchema.parse(
            JSON.parse(
              await this.read(computer, job.workdir, ANTIGRAVITY_JOB_FILES.findings, context),
            ),
          )
        : undefined;
    return this.observation(launch, outcome, findings);
  }

  private async jobState(
    computer: ComputerRef,
    job: ResearchJobRef,
    launch: LaunchRecord,
    initial: AntigravityJobSnapshot,
    context: AdapterContext,
  ): Promise<AntigravityJobState> {
    let snapshot = initial;
    let marker: AntigravityJobState["marker"] = "idle";
    if (snapshot.exitCode === undefined) {
      marker = await this.probe(computer, launch, context);
      // The process can end between the listing and the probe; an idle marker
      // with a fresh exit.code is a finished run, not an uncertain one.
      if (marker === "idle") snapshot = await this.snapshot(computer, job.workdir, context);
    }
    const eventsBytes = snapshot.files.get(ANTIGRAVITY_JOB_FILES.events) ?? 0;
    const stderrBytes = snapshot.files.get(ANTIGRAVITY_JOB_FILES.stderr) ?? 0;
    const bounded = async (name: string, bytes: number, max: number) =>
      bytes > 0 && bytes <= max ? this.read(computer, job.workdir, name, context, max) : "";
    return {
      exitCode: snapshot.exitCode,
      events: await bounded(
        ANTIGRAVITY_JOB_FILES.events,
        eventsBytes,
        ANTIGRAVITY_EVENTS_MAX_BYTES,
      ),
      stderr: await bounded(
        ANTIGRAVITY_JOB_FILES.stderr,
        stderrBytes,
        ANTIGRAVITY_STDERR_MAX_BYTES,
      ),
      eventsBytes,
      stderrBytes,
      marker,
      cancelRequested: snapshot.files.has(ANTIGRAVITY_JOB_FILES.cancel),
    };
  }

  private deadlineExceeded(launch: LaunchRecord): boolean {
    const startedAt = Date.parse(launch.startedAt);
    if (!Number.isFinite(startedAt)) return false;
    return this.now().getTime() > startedAt + launch.budgetMs + ANTIGRAVITY_BUDGET_GRACE_MS;
  }

  private async probe(computer: ComputerRef, launch: LaunchRecord, context: AdapterContext) {
    const result = await this.run(
      computer,
      researchWorkProbeArgv(launch.computerId, launch.jobId),
      context,
      10_000,
    );
    return interpretBackgroundWorkProbe(result.code, result.stdout);
  }

  private async kill(computer: ComputerRef, launch: LaunchRecord, context: AdapterContext) {
    await this.run(
      computer,
      cancelComputerRunWorkArgv(launch.computerId, researchWorkRunId(launch.jobId)),
      context,
      15_000,
    );
  }

  /** Persist a terminal outcome once; later observations read it back unchanged. */
  private async settle(
    computer: ComputerRef,
    job: ResearchJobRef,
    launch: LaunchRecord,
    outcome: AntigravityOutcome,
    exitCode: number | undefined,
    context: AdapterContext,
  ): Promise<ResearchObservation> {
    if (outcome.status === "running") throw new Error("cannot settle a running research job");
    const record: OutcomeRecord = {
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      truncated: outcome.truncated,
      permissionDenials: outcome.permissionDenials,
      ...(exitCode === undefined ? {} : { exitCode }),
      finishedAt: this.now().toISOString(),
      reason: outcome.reason,
      ...(outcome.findings ? { findingsSha256: researchDigest(outcome.findings) } : {}),
      ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
    };
    if (outcome.findings) {
      await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.findings, {
        content: JSON.stringify(outcome.findings, null, 2),
        context,
      });
      await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.report, {
        content: renderResearchReport(outcome.findings),
        context,
      });
    }
    await this.write(computer, job.workdir, ANTIGRAVITY_JOB_FILES.outcome, {
      content: JSON.stringify(record, null, 2),
      context,
    });
    return this.observation(launch, record, outcome.findings);
  }

  private running(launch: LaunchRecord, outcome: AntigravityOutcome): ResearchObservation {
    return {
      status: "running",
      receipt: this.receipt(launch, {
        status: "running",
        truncated: false,
        permissionDenials: outcome.permissionDenials,
        ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
      }),
    };
  }

  private observation(
    launch: LaunchRecord,
    outcome: OutcomeRecord,
    findings: ResearchFindings | undefined,
  ): ResearchObservation {
    return {
      status: outcome.status,
      ...(findings ? { findings: structuredClone(findings) } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      receipt: this.receipt(launch, {
        status: outcome.status,
        finishedAt: outcome.finishedAt,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        truncated: outcome.truncated,
        permissionDenials: outcome.permissionDenials,
        ...(outcome.findingsSha256 ? { findingsSha256: outcome.findingsSha256 } : {}),
        ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
      }),
    };
  }

  private receipt(
    launch: LaunchRecord,
    fields: Pick<ResearchReceipt, "status" | "truncated" | "permissionDenials"> &
      Partial<ResearchReceipt>,
  ): ResearchReceipt {
    const { id, adapterVersion } = this.describe();
    return {
      jobId: launch.jobId,
      provider: id,
      adapterVersion,
      model: launch.model,
      startedAt: launch.startedAt,
      requestSha256: launch.requestSha256,
      ...fields,
    };
  }

  /** An observation for a job the folder does not know, or a request that never became one. */
  private bare(
    jobId: string,
    status: Extract<ResearchObservedStatus, "failed" | "uncertain">,
    fields: { errorCode?: ResearchErrorCode } = {},
  ): ResearchObservation {
    const { id, adapterVersion } = this.describe();
    return {
      status,
      ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
      receipt: {
        jobId,
        provider: id,
        adapterVersion,
        status,
        truncated: false,
        permissionDenials: 0,
      },
    };
  }

  private async run(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
    let stdout = "";
    let stderr = "";
    let code: number | undefined;
    for await (const event of this.sandbox.execute(computer, { argv, timeoutMs }, context)) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    return { stdout, stderr, code };
  }

  private async read(
    computer: ComputerRef,
    workdir: string,
    name: string,
    context: AdapterContext,
    maxBytes?: number,
  ): Promise<string> {
    const bytes = await this.sandbox.readFile(
      computer,
      `${workdir}/${name}`,
      context,
      maxBytes === undefined ? undefined : { maxBytes },
    );
    return decoder.decode(bytes);
  }

  private async write(
    computer: ComputerRef,
    workdir: string,
    name: string,
    file: { content: string; context: AdapterContext },
  ): Promise<void> {
    await this.sandbox.writeFile(
      computer,
      { path: `${workdir}/${name}`, content: encoder.encode(file.content) },
      file.context,
    );
  }
}
