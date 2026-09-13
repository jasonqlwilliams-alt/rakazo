import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import {
  ANTIGRAVITY_EVENTS_MAX_BYTES,
  ANTIGRAVITY_JOB_FILES,
  ANTIGRAVITY_JOB_SNAPSHOT,
} from "../antigravity-research.js";
import {
  BACKGROUND_WORK_IDLE_SENTINEL,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
  RESEARCH_WORK_DIR,
  RESEARCH_WORK_LAUNCH,
} from "../computer-idle.js";
import type { FakeBox } from "../fake-sandbox.js";
import { FakeSandboxProvider } from "../fake-sandbox.js";

const MARKER_PREFIX = "/tmp/rakazo-background-";
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/agy/", import.meta.url));

/** What one `agy` run left in its job folder: stdout, stderr and, unless it crashed, an exit code. */
export interface AgyFixture {
  events: string;
  stderr: string;
  /** Raw exit.code content; absent when the wrapper died before writing it. */
  exitCode?: string;
}

export function listAgyFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadAgyFixture(name: string): AgyFixture {
  const dir = path.join(FIXTURES_DIR, name);
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const exitPath = path.join(dir, ANTIGRAVITY_JOB_FILES.exitCode);
  return {
    events: read(ANTIGRAVITY_JOB_FILES.events),
    stderr: read(ANTIGRAVITY_JOB_FILES.stderr),
    ...(existsSync(exitPath) ? { exitCode: readFileSync(exitPath, "utf8") } : {}),
  };
}

/** The synthetic stream-json shape the fixtures use for a run that returned a final result. */
export function agyResultEvents(result: unknown, conversation = "fixture-conversation"): string {
  return `${[
    JSON.stringify({
      type: "system",
      subtype: "init",
      model: "fixture-model",
      conversation_id: conversation,
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Reading the sources." }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(result),
      conversation_id: conversation,
    }),
  ].join("\n")}\n`;
}

/** Fixtures too large or too plain to keep on disk. */
export const AGY_GENERATED_FIXTURES: Record<string, () => AgyFixture> = {
  "oversize-events": () => {
    const line = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(4_000) }] },
    })}\n`;
    const events: string[] = [];
    let bytes = 0;
    while (bytes <= ANTIGRAVITY_EVENTS_MAX_BYTES) {
      events.push(line);
      bytes += Buffer.byteLength(line);
    }
    return { events: events.join(""), stderr: "", exitCode: "0\n" };
  },
};

export function loadAnyAgyFixture(name: string): AgyFixture {
  const generated = AGY_GENERATED_FIXTURES[name];
  return generated ? generated() : loadAgyFixture(name);
}

interface AgyProcess {
  jobId: string;
  marker: string;
  box: FakeBox;
  /** The harness-owned job folder the wrapper writes to. */
  workdir: string;
  /** Where the process itself runs and writes, as the launch script places it. */
  cwd: string;
  alive: boolean;
  probes: number;
}

/**
 * A fake bot computer that understands the four scripts the Antigravity
 * provider runs: the detached launch, the marker probe, the cancel script and
 * the job-folder snapshot. A launched "process" holds its marker until a
 * fixture finishes it, a cancel kills it, or it vanishes. Files live in a
 * FakeSandboxProvider box so a restarted provider reads the same folder.
 */
export class AgyComputerEmulator {
  readonly files = new FakeSandboxProvider();
  /** The `agy` argv of every launch that opened a marker, in order. */
  readonly launches: string[][] = [];
  readonly processes = new Map<string, AgyProcess>();
  /** Pretend the configured executable is not installed on the computer. */
  executableMissing = false;
  /** Refuse every launch as a computer without bash would. */
  launchUnsupported = false;
  /** Finish a running process with this fixture once it has been probed this many times. */
  autoFinish: { fixture: string; afterProbes: number } | null = null;

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.box(computer);
    const [shell, flag, script, , ...args] = request.argv;
    if (shell !== "bash" || flag !== "-c") {
      yield { type: "stderr", data: "emulator runs only bash -c scripts\n" };
      yield { type: "exit", code: 127 };
      return;
    }
    switch (script) {
      case RESEARCH_WORK_LAUNCH:
        yield* this.launch(box, args);
        return;
      case BACKGROUND_WORK_PROBE:
        yield* this.probe(args[0] ?? "");
        return;
      case CANCEL_COMPUTER_RUN_WORK:
        this.kill(`${MARKER_PREFIX}${args[0]}-${args[1]}-`);
        yield { type: "exit", code: 0 };
        return;
      case ANTIGRAVITY_JOB_SNAPSHOT:
        yield { type: "stdout", data: this.snapshot(box, args[0] ?? "") };
        yield { type: "exit", code: 0 };
        return;
      default:
        yield { type: "stderr", data: "emulator does not know this script\n" };
        yield { type: "exit", code: 127 };
    }
  }

  readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    this.box(computer);
    return this.files.readFile(computer, filePath, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    this.box(computer);
    return this.files.writeFile(computer, file, context);
  }

  /** End the running process for a job with a fixture's files. */
  finish(jobId: string, fixture: string | AgyFixture) {
    const process = this.running(jobId);
    const files = typeof fixture === "string" ? loadAnyAgyFixture(fixture) : fixture;
    put(process.box, process.workdir, ANTIGRAVITY_JOB_FILES.events, files.events);
    put(process.box, process.workdir, ANTIGRAVITY_JOB_FILES.stderr, files.stderr);
    if (files.exitCode !== undefined) {
      put(process.box, process.workdir, ANTIGRAVITY_JOB_FILES.exitCode, files.exitCode);
    }
    process.alive = false;
  }

  /** End the process with a final result the CLI would have returned for these findings. */
  complete(jobId: string, findings: unknown) {
    this.finish(jobId, { events: agyResultEvents(findings), stderr: "", exitCode: "0\n" });
  }

  /** The process is gone with nothing written, as after a replaced computer. */
  vanish(jobId: string) {
    this.running(jobId).alive = false;
  }

  /** Write a file as the running process would, inside its own working directory. */
  agentWrites(jobId: string, name: string, content: string) {
    const process = this.running(jobId);
    put(process.box, process.cwd, name, content);
  }

  /** Read one job file back for assertions, from whichever computer holds it. */
  jobFile(workdir: string, name: string): string | undefined {
    for (const box of this.files.boxes.values()) {
      const stored = box.files.get(`${workdir}/${name}`);
      if (stored) return new TextDecoder().decode(stored.content);
    }
    return undefined;
  }

  private *launch(box: FakeBox, args: string[]): Iterable<ProcessEvent> {
    const [computerId, runId, nonce, workdir, limit, separator, ...command] = args;
    if (this.launchUnsupported) {
      yield { type: "stderr", data: "bash: not found\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    if (separator !== "--" || command.length === 0 || !/^\d+$/.test(limit ?? "")) {
      yield { type: "exit", code: 2 };
      return;
    }
    if (this.executableMissing) {
      put(
        box,
        workdir!,
        ANTIGRAVITY_JOB_FILES.stderr,
        `error: research executable not found: ${command[0]}\n`,
      );
      put(box, workdir!, ANTIGRAVITY_JOB_FILES.exitCode, "127\n");
      yield { type: "exit", code: 127 };
      return;
    }
    const marker = `${MARKER_PREFIX}${computerId}-${runId}-${nonce}`;
    if (this.processes.has(marker)) {
      yield { type: "stderr", data: "marker exists\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    box.files.delete(`${workdir}/${ANTIGRAVITY_JOB_FILES.exitCode}`);
    put(box, workdir!, ANTIGRAVITY_JOB_FILES.events, "");
    put(box, workdir!, ANTIGRAVITY_JOB_FILES.stderr, "");
    this.processes.set(marker, {
      jobId: (runId ?? "").replace(/^research\./, ""),
      marker,
      box,
      workdir: workdir!,
      cwd: `${workdir}/${RESEARCH_WORK_DIR}`,
      alive: true,
      probes: 0,
    });
    this.launches.push(command);
    yield { type: "exit", code: 0 };
  }

  private *probe(markerId: string): Iterable<ProcessEvent> {
    const prefix = `${MARKER_PREFIX}${markerId}-`;
    for (const process of this.processes.values()) {
      if (!process.alive || !process.marker.startsWith(prefix)) continue;
      process.probes++;
      if (this.autoFinish && process.probes >= this.autoFinish.afterProbes) {
        this.finish(process.jobId, this.autoFinish.fixture);
        break;
      }
      yield { type: "exit", code: 0 };
      return;
    }
    yield { type: "stdout", data: `${BACKGROUND_WORK_IDLE_SENTINEL}\n` };
    yield { type: "exit", code: 1 };
  }

  private kill(prefix: string) {
    for (const process of this.processes.values()) {
      if (process.marker.startsWith(prefix)) process.alive = false;
    }
  }

  private snapshot(box: FakeBox, workdir: string): string {
    const lines = ["rakazo-research-snapshot"];
    const dir = `${workdir}/`;
    if (![...box.files.keys()].some((file) => file.startsWith(dir))) return `${lines[0]}\n`;
    for (const name of Object.values(ANTIGRAVITY_JOB_FILES)) {
      const stored = box.files.get(dir + name);
      if (stored) lines.push(`file ${name} ${stored.content.byteLength}`);
    }
    const exit = box.files.get(dir + ANTIGRAVITY_JOB_FILES.exitCode);
    if (exit) lines.push(`exit ${new TextDecoder().decode(exit.content).trim()}`);
    return `${lines.join("\n")}\n`;
  }

  private box(computer: ComputerRef): FakeBox {
    let box = this.files.boxes.get(computer.id);
    if (!box) {
      box = {
        ref: computer,
        files: new Map(),
        running: true,
        screens: new Map(),
        screenLeases: new Map(),
      };
      this.files.boxes.set(computer.id, box);
    }
    return box;
  }

  private process(jobId: string): AgyProcess | undefined {
    return [...this.processes.values()].find((process) => process.jobId === jobId);
  }

  private running(jobId: string): AgyProcess {
    const process = this.process(jobId);
    if (!process?.alive) throw new Error(`no running agy process for ${jobId}`);
    return process;
  }
}

function put(box: FakeBox, workdir: string, name: string, content: string) {
  box.files.set(`${workdir}/${name}`, {
    content: new TextEncoder().encode(content),
    executable: false,
  });
}
