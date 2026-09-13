import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  ResearchStartRequest,
} from "@rakazo/adapter-kit";
import type { ResearchErrorCode, ResearchStatus } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_BUDGET_GRACE_MS,
  ANTIGRAVITY_FORBIDDEN_FLAGS,
  ANTIGRAVITY_JOB_FILES,
  AntigravityResearchProvider,
  antigravityFinalResult,
  antigravityFindingsJsonSchema,
  antigravityResearchArgv,
  antigravityResearchSettingsSchema,
  classifyAntigravityStderr,
  parseAntigravityEvents,
  parseAntigravityJobSnapshot,
  renderAntigravityBrief,
  renderResearchReport,
  resolveAntigravityOutcome,
} from "./antigravity-research.js";
import {
  BACKGROUND_WORK_PROBE,
  cancelComputerRunWorkArgv,
  interpretBackgroundWorkProbe,
  researchWorkLaunchArgv,
  researchWorkProbeArgv,
  researchWorkRunId,
} from "./computer-idle.js";
import { EMULATOR_RESEARCH_FINDINGS } from "./research-emulator.js";
import { researchDigest } from "./research-request.js";
import type { AgyFixture } from "./testing/agy-computer-emulator.js";
import {
  AGY_GENERATED_FIXTURES,
  AgyComputerEmulator,
  listAgyFixtures,
  loadAnyAgyFixture,
} from "./testing/agy-computer-emulator.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "provider-ref",
  botId: "test-bot",
  kind: "fake",
  providerRef: "provider-ref",
};
const settings = antigravityResearchSettingsSchema.parse({ model: "fixture-model" });

function request(jobId: string, overrides: Partial<ResearchStartRequest> = {}) {
  return {
    jobId,
    workdir: `bots/test-bot/research/${jobId}`,
    computerId: "computer-db-id",
    brief: { title: "Fixture topic", goal: "Find what the fixture says about the topic." },
    depth: "standard",
    budgetMs: 30 * 60_000,
    ...overrides,
  } satisfies ResearchStartRequest;
}

/** Status and error code every recorded run maps to; the table must name every fixture folder. */
const FIXTURE_OUTCOMES: Record<
  string,
  { status: ResearchStatus; errorCode?: ResearchErrorCode; truncated: boolean; denials?: number }
> = {
  completed: { status: "completed", truncated: false },
  "completed-plan-mode": { status: "completed", truncated: false },
  "timed-out-partial": { status: "timed_out", truncated: true },
  "permission-denied": {
    status: "failed",
    errorCode: "permission_denied",
    truncated: false,
    denials: 2,
  },
  "auth-required": { status: "failed", errorCode: "auth_required", truncated: false },
  "quota-exhausted": { status: "failed", errorCode: "quota_exhausted", truncated: false },
  "usage-exit-2": { status: "failed", errorCode: "invalid_request", truncated: false },
  "crash-no-exit-code": { status: "uncertain", truncated: true },
  "schema-violation": { status: "failed", errorCode: "invalid_output", truncated: false },
  "provider-error": { status: "failed", errorCode: "provider_error", truncated: false },
  unavailable: { status: "failed", errorCode: "unavailable", truncated: false },
  "oversize-events": { status: "failed", errorCode: "invalid_output", truncated: true },
};

function fixtureState(fixture: AgyFixture) {
  return {
    exitCode: fixture.exitCode === undefined ? undefined : Number(fixture.exitCode.trim()),
    events: fixture.events,
    stderr: fixture.stderr,
    eventsBytes: Buffer.byteLength(fixture.events),
    stderrBytes: Buffer.byteLength(fixture.stderr),
    marker: "idle" as const,
    cancelRequested: false,
  };
}

describe("antigravity settings", () => {
  it("defaults the executable and mode and keeps values that could read as flags out", () => {
    expect(settings).toEqual({ executable: "agy", model: "fixture-model", mode: "accept-edits" });
    for (const bad of [
      { model: "--dangerously-skip-permissions" },
      { model: "fixture-model", executable: "-p" },
      { model: "fixture-model", project: "a\nb" },
      { model: "fixture-model", token: "x" },
      {},
    ]) {
      expect(antigravityResearchSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe("antigravity argv", () => {
  const brief = {
    title: "Spaces, \"quotes\" and 'ticks'",
    goal: "Check $(whoami) and `date`\nover two lines\twith a tab and ünïcödé.",
    preferredSources: ["https://research.test/a b", "notes/file with spaces.md"],
    nonGoals: "Do not run --dangerously-skip-permissions or anything like it.",
  };

  it("never carries a forbidden flag, however the brief or settings read", () => {
    const withProject = antigravityResearchSettingsSchema.parse({
      model: "fixture-model",
      project: "fixture-project",
      executable: "/opt/Anti Gravity/bin/agy",
    });
    for (const depth of ["standard", "deep"] as const) {
      for (const config of [settings, withProject]) {
        const argv = antigravityResearchArgv(config, { brief, depth, budgetMs: 30 * 60_000 });
        for (const element of argv.slice(1)) {
          for (const flag of ANTIGRAVITY_FORBIDDEN_FLAGS) {
            expect(element === flag || element.startsWith(`${flag}=`), element).toBe(false);
          }
          expect(element.startsWith("--"), element).toBe(true);
        }
        expect(argv.filter((element) => element === "--sandbox")).toHaveLength(1);
      }
    }
    expect(
      antigravityResearchArgv(withProject, { brief, depth: "deep", budgetMs: 60_000 })[0],
    ).toBe("/opt/Anti Gravity/bin/agy");
  });

  it("puts the brief in one --print= element, byte for byte", () => {
    const argv = antigravityResearchArgv(settings, { brief, depth: "standard", budgetMs: 60_000 });
    const rendered = renderAntigravityBrief(brief, "standard");
    expect(argv[1]).toBe(`--print=${rendered}`);
    for (const text of [brief.title, brief.goal, ...brief.preferredSources, brief.nonGoals]) {
      expect(argv[1]).toContain(text);
      expect(Buffer.from(argv[1]!, "utf8").includes(Buffer.from(text, "utf8"))).toBe(true);
    }
    expect(argv.filter((element) => element.startsWith("--print="))).toHaveLength(1);
    expect(argv).not.toContain("--print");
    expect(argv).not.toContain("-p");
  });

  it("uses the equals form for every valued flag with model, effort, timeout and files fixed", () => {
    const argv = antigravityResearchArgv(settings, {
      brief,
      depth: "standard",
      budgetMs: 1_800_000,
    });
    expect(argv.slice(2)).toEqual([
      "--output-format=stream-json",
      "--json-schema=findings.schema.json",
      "--model=fixture-model",
      "--effort=medium",
      "--mode=accept-edits",
      "--sandbox",
      "--print-timeout=1800s",
      "--log-file=agy.log",
    ]);
    const deep = antigravityResearchArgv(
      antigravityResearchSettingsSchema.parse({ model: "m", project: "p", mode: "plan" }),
      { brief, depth: "deep", budgetMs: 90_500 },
    );
    expect(deep).toContain("--effort=high");
    expect(deep).toContain("--mode=plan");
    expect(deep).toContain("--print-timeout=91s");
    expect(deep.at(-1)).toBe("--project=p");
    for (const bare of ["--model", "--project", "--effort", "--print-timeout", "--json-schema"]) {
      expect(argv).not.toContain(bare);
      expect(deep).not.toContain(bare);
    }
  });

  it("renders the brief deterministically under fixed headings", () => {
    expect(
      renderAntigravityBrief(
        { title: "T", goal: "G", context: "C", successCriteria: "S", nonGoals: "N" },
        "deep",
      ),
    ).toBe(
      [
        "# Research brief: T",
        "",
        "## Goal",
        "G",
        "",
        "## Context",
        "C",
        "",
        "## Success criteria",
        "S",
        "",
        "## Non-goals",
        "N",
        "",
        "## Output contract",
        "Depth: deep.",
        "Research with the tools you have, then return only the final JSON document that satisfies the provided JSON schema: summary, claims, sources, gaps and applyNotes.",
        'Label each claim "confirmed" only when it cites at least one listed source by id; label everything else "inference".',
        "List every source you relied on with an http(s) URL or a path relative to the current directory. Do not invent sources.",
        "Record what you could not verify under gaps. Keep apply notes short and actionable.",
        "Do not modify files outside the current directory and do not run commands that change the system.",
      ].join("\n"),
    );
  });

  it("serializes the shared findings schema for --json-schema", () => {
    const schema = antigravityFindingsJsonSchema();
    expect(schema).toMatchObject({
      type: "object",
      required: ["summary", "claims", "sources", "gaps", "applyNotes"],
    });
    expect(JSON.stringify(schema)).toContain('"enum":["confirmed","inference"]');
  });
});

describe("antigravity output classification", () => {
  it("classifies stderr lines", () => {
    expect(
      classifyAntigravityStderr(
        [
          "permission denied: read_url_content https://x (auto-denied in headless mode)",
          "permission denied: run_command curl",
          "warning: print timeout of 1800s reached; returning the partial output",
          "error: headless authentication required. Sign in at https://example.invalid",
          "error: quota exhausted: 429 RESOURCE_EXHAUSTED",
          'Error: unexpected argument "Bioactives" found',
        ].join("\n"),
      ),
    ).toEqual({
      authRequired: true,
      quotaExhausted: true,
      usageError: true,
      timedOut: true,
      permissionDenials: 2,
      fatalError: true,
      firstError: "error: headless authentication required. Sign in at https://example.invalid",
    });
    expect(classifyAntigravityStderr("notice: plan mode\n\n")).toMatchObject({
      fatalError: false,
      permissionDenials: 0,
      timedOut: false,
    });
    expect(classifyAntigravityStderr("error: request timed out; retrying\n")).toMatchObject({
      fatalError: true,
      timedOut: false,
    });
  });

  it("reads the final result from either result shape and tolerates noise", () => {
    const log = parseAntigravityEvents(
      [
        "not json",
        "[1,2]",
        JSON.stringify({ type: "system", conversation_id: "conv-1" }),
        JSON.stringify({ type: "result", result: '```json\n{"a":1}\n```' }),
      ].join("\n"),
    );
    expect(log.malformedLines).toBe(2);
    expect(antigravityFinalResult(log)).toEqual({ a: 1 });
    expect(
      antigravityFinalResult(
        parseAntigravityEvents(JSON.stringify({ type: "result", structured_output: { b: 2 } })),
      ),
    ).toEqual({ b: 2 });
    expect(
      antigravityFinalResult(
        parseAntigravityEvents(JSON.stringify({ status: "SUCCESS", response: '{"c":3}' })),
      ),
    ).toEqual({ c: 3 });
    expect(antigravityFinalResult(parseAntigravityEvents(""))).toBeUndefined();
    expect(
      antigravityFinalResult(
        parseAntigravityEvents(JSON.stringify({ type: "result", result: "{" })),
      ),
    ).toBeUndefined();
  });

  it("maps every fixture to its exact status and error code", () => {
    expect(listAgyFixtures()).toEqual(
      Object.keys(FIXTURE_OUTCOMES)
        .filter((name) => !(name in AGY_GENERATED_FIXTURES))
        .sort(),
    );
    for (const [name, expected] of Object.entries(FIXTURE_OUTCOMES)) {
      const outcome = resolveAntigravityOutcome(fixtureState(loadAnyAgyFixture(name)));
      expect({
        name,
        ...outcome,
        findings: undefined,
        reason: undefined,
        providerRef: undefined,
      }).toEqual({
        name,
        status: expected.status,
        errorCode: expected.errorCode,
        truncated: expected.truncated,
        permissionDenials: expected.denials ?? 0,
        findings: undefined,
        reason: undefined,
        providerRef: undefined,
      });
      expect(outcome.findings === undefined).toBe(expected.status !== "completed");
    }
    expect(resolveAntigravityOutcome(fixtureState(loadAnyAgyFixture("completed")))).toMatchObject({
      findings: EMULATOR_RESEARCH_FINDINGS,
      providerRef: "fixture-conversation-completed",
    });
  });

  it("decides running, cancelled and timed out from the marker, the cancel flag and exit codes", () => {
    const base = fixtureState({ events: "", stderr: "" });
    expect(resolveAntigravityOutcome({ ...base, marker: "active" }).status).toBe("running");
    expect(resolveAntigravityOutcome({ ...base, marker: "unknown" }).status).toBe("running");
    expect(resolveAntigravityOutcome({ ...base, marker: "idle" })).toMatchObject({
      status: "uncertain",
      truncated: true,
    });
    expect(resolveAntigravityOutcome({ ...base, cancelRequested: true })).toMatchObject({
      status: "cancelled",
      truncated: true,
    });
    expect(
      resolveAntigravityOutcome({ ...base, exitCode: 143, cancelRequested: true }).status,
    ).toBe("cancelled");
    expect(resolveAntigravityOutcome({ ...base, exitCode: 124 })).toMatchObject({
      status: "timed_out",
      truncated: true,
    });
    const done = fixtureState(loadAnyAgyFixture("completed"));
    expect(resolveAntigravityOutcome({ ...done, cancelRequested: true }).status).toBe("completed");
    expect(resolveAntigravityOutcome({ ...base, exitCode: 0 })).toMatchObject({
      status: "failed",
      errorCode: "invalid_output",
    });
    expect(
      resolveAntigravityOutcome({ ...base, exitCode: 0, stderr: "error: planner gave up\n" }),
    ).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      reason: "error: planner gave up",
    });
  });

  it("keeps a validated result over recovered stderr signals", () => {
    const done = loadAnyAgyFixture("completed");
    const recovered = [
      "warning: rate limit reached, retrying in 2s",
      "warning: authentication expired; refreshed the token",
      "error: request timed out; retrying",
    ];
    for (const line of recovered) {
      const outcome = resolveAntigravityOutcome({
        ...fixtureState({ ...done, stderr: `${line}\n` }),
        exitCode: 0,
      });
      expect(outcome, line).toMatchObject({
        status: "completed",
        findings: EMULATOR_RESEARCH_FINDINGS,
      });
    }
    const unrecovered = (line: string, exitCode: number) =>
      resolveAntigravityOutcome({
        ...fixtureState({ events: "", stderr: `${line}\n` }),
        exitCode,
      });
    expect(unrecovered(recovered[0]!, 0)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(unrecovered(recovered[0]!, 1)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(unrecovered(recovered[1]!, 0)).toMatchObject({
      status: "failed",
      errorCode: "auth_required",
    });
    expect(unrecovered(recovered[2]!, 0)).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
    });
    expect(
      unrecovered("warning: print timeout of 60s reached; returning the partial output", 0),
    ).toMatchObject({ status: "timed_out", truncated: true });
  });

  it("reports permission denied whenever denials left no gathered source", () => {
    const denial = "permission denied: read_url_content https://research.test/sources/1\n";
    const denied = (events: string, stderr: string, exitCode: number) =>
      resolveAntigravityOutcome({ ...fixtureState({ events, stderr }), exitCode });
    expect(denied("", `${denial}error: planner gave up\n`, 1)).toMatchObject({
      status: "failed",
      errorCode: "permission_denied",
      permissionDenials: 1,
    });
    expect(denied("", denial, 0)).toMatchObject({
      status: "failed",
      errorCode: "permission_denied",
    });
    const unlisted = loadAnyAgyFixture("schema-violation").events;
    expect(denied(unlisted, denial, 0)).toMatchObject({
      status: "failed",
      errorCode: "permission_denied",
    });
    expect(denied(loadAnyAgyFixture("completed").events, denial, 0)).toMatchObject({
      status: "completed",
      permissionDenials: 1,
    });
    expect(denied("", `${denial}error: quota exhausted: 429\n`, 1)).toMatchObject({
      errorCode: "quota_exhausted",
    });
  });

  it("renders report.md deterministically in pack order", () => {
    expect(renderResearchReport(EMULATOR_RESEARCH_FINDINGS)).toBe(
      [
        "# Research report",
        "",
        "## Summary",
        "The emulator found one confirmed fact and one inference.",
        "",
        "## Confirmed",
        "- The fixture page states the confirmed fact. [s1]",
        "",
        "## Inference",
        "- The fixture suggests a follow-up is useful.",
        "",
        "## Gaps",
        "- The fixture does not cover a second source.",
        "",
        "## Apply notes",
        "- Nothing to apply in the emulator.",
        "",
        "## Sources",
        "- [s1] Fixture source: https://research.test/sources/1 (retrieved 2026-01-01T00:00:00.000Z)",
        "",
      ].join("\n"),
    );
    expect(
      renderResearchReport({ ...EMULATOR_RESEARCH_FINDINGS, gaps: [], sources: [] }),
    ).toContain("## Gaps\nNone.\n");
  });

  it("parses the job snapshot and rejects output without its header", () => {
    expect(parseAntigravityJobSnapshot("garbage\nfile x 1\n")).toBeUndefined();
    expect(parseAntigravityJobSnapshot("rakazo-research-snapshot\n")).toEqual({
      files: new Map(),
      exitCode: undefined,
    });
    expect(
      parseAntigravityJobSnapshot(
        "rakazo-research-snapshot\nfile launch.json 12\nfile exit.code 2\nexit 7\n",
      ),
    ).toEqual({
      files: new Map([
        ["launch.json", 12],
        ["exit.code", 2],
      ]),
      exitCode: 7,
    });
    expect(interpretBackgroundWorkProbe(2, "")).toBe("unknown");
    expect(interpretBackgroundWorkProbe(1, "rakazo-background-idle\n")).toBe("idle");
    expect(interpretBackgroundWorkProbe(0, "")).toBe("active");
  });
});

describe("antigravity provider over the computer emulator", () => {
  function harness(options: { now?: () => Date } = {}) {
    const agy = new AgyComputerEmulator();
    const provider = new AntigravityResearchProvider({
      sandbox: agy,
      settings: { model: "fixture-model" },
      nonce: () => "nonce",
      ...options,
    });
    return { agy, provider };
  }

  it("writes the schema and launch fence, then launches the exact argv under the job marker", async () => {
    const { agy, provider } = harness();
    const job = request("launch");
    const started = await provider.start(computer, job, ctx);
    expect(started.status).toBe("running");
    expect(agy.launches).toEqual([antigravityResearchArgv(settings, job)]);
    expect([...agy.processes.keys()]).toEqual([
      "/tmp/rakazo-background-computer-db-id-research.launch-nonce",
    ]);
    expect(JSON.parse(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.schema)!)).toEqual(
      antigravityFindingsJsonSchema(),
    );
    expect(JSON.parse(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.launch)!)).toMatchObject({
      jobId: "launch",
      computerId: "computer-db-id",
      requestSha256: researchDigest(job),
      model: "fixture-model",
      budgetMs: job.budgetMs,
    });
    expect(started.receipt).toMatchObject({
      provider: "antigravity",
      model: "fixture-model",
      requestSha256: researchDigest(job),
    });
  });

  it("maps every fixture through the provider and persists the outcome in the job folder", async () => {
    for (const [name, expected] of Object.entries(FIXTURE_OUTCOMES)) {
      const { agy, provider } = harness();
      const job = request(name);
      await provider.start(computer, job, ctx);
      agy.finish(name, name);
      const observed = await provider.observe(computer, job, ctx);
      expect({ name, status: observed.status, errorCode: observed.errorCode }).toEqual({
        name,
        status: expected.status,
        errorCode: expected.errorCode,
      });
      expect(observed.receipt.truncated).toBe(expected.truncated);
      expect(observed.receipt.permissionDenials).toBe(expected.denials ?? 0);
      expect(JSON.parse(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.outcome)!)).toMatchObject({
        status: expected.status,
      });
      const persistedFindings = agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.findings);
      const report = agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.report);
      if (expected.status === "completed") {
        expect(JSON.parse(persistedFindings!)).toEqual(observed.findings);
        expect(report).toBe(renderResearchReport(observed.findings!));
        expect(observed.receipt.findingsSha256).toBe(researchDigest(observed.findings));
      } else {
        expect(persistedFindings).toBeUndefined();
        expect(report).toBeUndefined();
      }
      expect(await provider.observe(computer, job, ctx)).toEqual(observed);
    }
  });

  it("ends as unavailable when the executable is missing or the launch cannot run at all", async () => {
    const missing = harness();
    missing.agy.executableMissing = true;
    const job = request("missing");
    expect(await missing.provider.start(computer, job, ctx)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
      receipt: { exitCode: 127 },
    });
    expect(missing.agy.launches).toHaveLength(0);
    expect(await missing.provider.start(computer, job, ctx)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
    });

    const unsupported = harness();
    unsupported.agy.launchUnsupported = true;
    const noBash = request("no-bash");
    expect(await unsupported.provider.start(computer, noBash, ctx)).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
    });
    expect(unsupported.agy.jobFile(noBash.workdir, ANTIGRAVITY_JOB_FILES.stderr)).toContain(
      "research launch failed (exit 1): bash: not found",
    );
  });

  it("kills a process that outlives the budget and grace, then reports a timeout", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { agy, provider } = harness({ now: () => new Date(now) });
    const job = request("late", { budgetMs: 60_000 });
    await provider.start(computer, job, ctx);
    now += 60_000 + ANTIGRAVITY_BUDGET_GRACE_MS;
    expect((await provider.observe(computer, job, ctx)).status).toBe("running");
    now += 1;
    const observed = await provider.observe(computer, job, ctx);
    expect(observed).toMatchObject({ status: "timed_out", receipt: { truncated: true } });
    expect([...agy.processes.values()][0]!.alive).toBe(false);
    expect((await provider.observe(computer, job, ctx)).status).toBe("timed_out");
  });

  it("completes on its own when the process ends between observations", async () => {
    const { agy, provider } = harness();
    agy.autoFinish = { fixture: "completed", afterProbes: 2 };
    const job = request("auto");
    expect((await provider.start(computer, job, ctx)).status).toBe("running");
    expect((await provider.observe(computer, job, ctx)).status).toBe("completed");
    expect(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.exitCode)).toBe("0\n");
  });

  it("records the cancel request before killing and keeps the job cancelled", async () => {
    const { agy, provider } = harness();
    const job = request("cancel");
    await provider.start(computer, job, ctx);
    const cancelled = await provider.cancel(computer, job, ctx);
    expect(cancelled).toMatchObject({ status: "cancelled", receipt: { truncated: true } });
    expect(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.cancel)).toMatch(/^2\d{3}-/);
    expect(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.exitCode)).toBeUndefined();
    expect(await provider.start(computer, job, ctx)).toEqual(cancelled);
    expect(agy.launches).toHaveLength(1);
  });

  it("kills a process whose output crossed the read bound before settling invalid output", async () => {
    const { agy, provider } = harness();
    const job = request("oversize-running");
    await provider.start(computer, job, ctx);
    const process = [...agy.processes.values()][0]!;
    await agy.writeFile(
      computer,
      {
        path: `${job.workdir}/${ANTIGRAVITY_JOB_FILES.events}`,
        content: new TextEncoder().encode(AGY_GENERATED_FIXTURES["oversize-events"]!().events),
      },
      ctx,
    );
    expect(process.alive).toBe(true);
    const observed = await provider.observe(computer, job, ctx);
    expect(observed).toMatchObject({
      status: "failed",
      errorCode: "invalid_output",
      receipt: { truncated: true },
    });
    expect(observed.receipt.exitCode).toBeUndefined();
    expect(process.alive).toBe(false);
    expect(JSON.parse(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.outcome)!)).toMatchObject({
      status: "failed",
      errorCode: "invalid_output",
    });
    expect(await provider.observe(computer, job, ctx)).toEqual(observed);
  });

  it("reads the event and stderr files only once the process has ended", async () => {
    const agy = new AgyComputerEmulator();
    const reads: string[] = [];
    const provider = new AntigravityResearchProvider({
      sandbox: {
        execute: (target, command, context) => agy.execute(target, command, context),
        readFile: (target, filePath, context, options) => {
          reads.push(filePath);
          return agy.readFile(target, filePath, context, options);
        },
        writeFile: (target, file, context) => agy.writeFile(target, file, context),
      },
      settings: { model: "fixture-model" },
    });
    const job = request("lazy-read");
    const jobFiles = () => reads.map((filePath) => filePath.slice(job.workdir.length + 1));
    await provider.start(computer, job, ctx);
    await agy.writeFile(
      computer,
      {
        path: `${job.workdir}/${ANTIGRAVITY_JOB_FILES.events}`,
        content: new TextEncoder().encode('{"type":"system","conversation_id":"live"}\n'),
      },
      ctx,
    );
    expect((await provider.observe(computer, job, ctx)).status).toBe("running");
    expect(jobFiles()).not.toContain(ANTIGRAVITY_JOB_FILES.events);
    expect(jobFiles()).not.toContain(ANTIGRAVITY_JOB_FILES.stderr);
    agy.finish(job.jobId, "completed");
    expect((await provider.observe(computer, job, ctx)).status).toBe("completed");
    expect(jobFiles()).toContain(ANTIGRAVITY_JOB_FILES.events);
  });

  it("keeps a run that ended before a late cancel as timed out", async () => {
    const { agy, provider } = harness();
    const job = request("late-cancel");
    await provider.start(computer, job, ctx);
    agy.finish(job.jobId, { events: "", stderr: "", exitCode: "124\n" });
    const observed = await provider.cancel(computer, job, ctx);
    expect(observed).toMatchObject({
      status: "timed_out",
      receipt: { truncated: true, exitCode: 124 },
    });
    expect(agy.jobFile(job.workdir, ANTIGRAVITY_JOB_FILES.cancel)).toBeUndefined();
    expect((await provider.cancel(computer, job, ctx)).status).toBe("timed_out");
  });

  it("refuses a job folder that belongs to another job and surfaces snapshot failures", async () => {
    const { provider } = harness();
    const job = request("owner");
    await provider.start(computer, job, ctx);
    await expect(
      provider.observe(computer, { jobId: "intruder", workdir: job.workdir }, ctx),
    ).rejects.toThrow("belongs to owner");

    const broken = new AntigravityResearchProvider({
      sandbox: {
        async *execute(): AsyncIterable<ProcessEvent> {
          yield { type: "stderr", data: "exec failed: 502" };
          yield { type: "exit", code: 1 };
        },
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
      },
      settings: { model: "fixture-model" },
    });
    await expect(broken.observe(computer, job, ctx)).rejects.toThrow("snapshot unavailable");
  });
});

describe("research work launch script", () => {
  const roots: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const marker of ["a", "b", "c", "d", "e"]) {
      rmSync(`/tmp/rakazo-background-launch-test-research.${marker}-n`, { force: true });
    }
  });

  function root() {
    const dir = mkdtempSync(path.join(tmpdir(), "rakazo-research-launch-"));
    roots.push(dir);
    return dir;
  }

  function run(argv: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data) => {
        stdout += data;
      });
      child.stderr?.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  const probe = (jobId: string) => run(researchWorkProbeArgv("launch-test", jobId));
  const posix = process.platform !== "win32";
  const detachTools =
    posix &&
    spawnSync("bash", ["-c", "command -v setsid >/dev/null && timeout --kill-after=1s 1s true"], {
      stdio: "ignore",
    }).status === 0;

  it.skipIf(!posix)(
    "ends with exit 126 and a recorded reason when setsid is missing, without a marker",
    async () => {
      const cwd = root();
      const bin = path.join(cwd, "bin");
      const tools = execFileSync("bash", ["-c", "command -v bash mkdir"], { encoding: "utf8" })
        .trim()
        .split("\n");
      execFileSync("mkdir", ["-p", bin]);
      for (const tool of tools) symlinkSync(tool, path.join(bin, path.basename(tool)));
      const argv = researchWorkLaunchArgv({
        computerId: "launch-test",
        jobId: "e",
        nonce: "n",
        workdir: "research/e",
        hardTimeoutSeconds: 60,
        command: ["bash", "-c", "true"],
      });
      const launched = await run([tools[0]!, ...argv.slice(1)], cwd, { PATH: bin });
      expect(launched.code).toBe(126);
      expect(readFileSync(path.join(cwd, "research/e/exit.code"), "utf8")).toBe("126\n");
      expect(readFileSync(path.join(cwd, "research/e/stderr.log"), "utf8")).toMatch(
        /^error: .*setsid.*\n$/,
      );
      expect(existsSync("/tmp/rakazo-background-launch-test-research.e-n")).toBe(false);
      expect(existsSync(path.join(cwd, "research/e/events.ndjson"))).toBe(false);
    },
  );

  it.skipIf(!detachTools)(
    "returns at once, keeps the marker held, passes argv byte for byte and writes exit.code",
    async () => {
      const cwd = root();
      const brief = 'Say "hi" $(true) `x`\nsecond line\twith a tab';
      const launched = await run(
        researchWorkLaunchArgv({
          computerId: "launch-test",
          jobId: "a",
          nonce: "n",
          workdir: "research/a",
          hardTimeoutSeconds: 60,
          command: [
            "bash",
            "-c",
            'printf "%s" "$1" >argv.txt; echo out; echo err >&2; until [ -e stop ]; do sleep 0.2; done; exit 7',
            "stub",
            `--print=${brief}`,
          ],
        }),
        cwd,
      );
      expect(launched.code).toBe(0);
      expect(existsSync(path.join(cwd, "research/a/exit.code"))).toBe(false);
      expect((await probe("a")).code).toBe(0);
      writeFileSync(path.join(cwd, "research/a/stop"), "");
      await expect
        .poll(() => existsSync(path.join(cwd, "research/a/exit.code")), {
          timeout: 20_000,
          interval: 200,
        })
        .toBe(true);
      const read = (name: string) => readFileSync(path.join(cwd, "research/a", name), "utf8");
      expect(read("exit.code")).toBe("7\n");
      expect(read("events.ndjson")).toBe("out\n");
      expect(read("stderr.log")).toBe("err\n");
      expect(read("argv.txt")).toBe(`--print=${brief}`);
      expect(await probe("a")).toMatchObject({ code: 1, stdout: "rakazo-background-idle\n" });
    },
    60_000,
  );

  it.skipIf(!posix)(
    "records a missing executable as exit 127 without opening a marker",
    async () => {
      const cwd = root();
      const launched = await run(
        researchWorkLaunchArgv({
          computerId: "launch-test",
          jobId: "b",
          nonce: "n",
          workdir: "research/b",
          hardTimeoutSeconds: 60,
          command: ["/nonexistent/agy", "--print=x"],
        }),
        cwd,
      );
      expect(launched.code).toBe(127);
      expect(readFileSync(path.join(cwd, "research/b/exit.code"), "utf8")).toBe("127\n");
      expect(readFileSync(path.join(cwd, "research/b/stderr.log"), "utf8")).toContain(
        "executable not found: /nonexistent/agy",
      );
      expect(existsSync("/tmp/rakazo-background-launch-test-research.b-n")).toBe(false);
    },
  );

  it.skipIf(!detachTools)(
    "is killed by the cancel script for its own run id only",
    async () => {
      const cwd = root();
      await run(
        researchWorkLaunchArgv({
          computerId: "launch-test",
          jobId: "c",
          nonce: "n",
          workdir: "research/c",
          hardTimeoutSeconds: 120,
          command: ["bash", "-c", "sleep 60"],
        }),
        cwd,
      );
      const marker = "/tmp/rakazo-background-launch-test-research.c-n";
      expect((await probe("c")).code).toBe(0);
      expect((await run(cancelComputerRunWorkArgv("launch-test", "other-run"))).code).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(path.join(cwd, "research/c/exit.code"))).toBe(false);
      expect(
        (await run(cancelComputerRunWorkArgv("launch-test", researchWorkRunId("c")))).code,
      ).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(
        (await run(["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", "launch-test"]))
          .code,
      ).toBe(1);
      expect(existsSync(path.join(cwd, "research/c/exit.code"))).toBe(false);
    },
    60_000,
  );

  it.skipIf(!detachTools)(
    "enforces the hard timeout on the process itself",
    async () => {
      const cwd = root();
      await run(
        researchWorkLaunchArgv({
          computerId: "launch-test",
          jobId: "d",
          nonce: "n",
          workdir: "research/d",
          hardTimeoutSeconds: 1,
          command: ["bash", "-c", "sleep 30"],
        }),
        cwd,
      );
      await expect
        .poll(() => existsSync(path.join(cwd, "research/d/exit.code")), {
          timeout: 20_000,
        })
        .toBe(true);
      expect(readFileSync(path.join(cwd, "research/d/exit.code"), "utf8")).toBe("124\n");
    },
    30_000,
  );
});
