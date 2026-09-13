import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  ResearchStartRequest,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { AntigravityResearchSandbox } from "./antigravity-research.js";
import {
  ANTIGRAVITY_JOB_FILES,
  AntigravityResearchProvider,
  antigravityResearchArgv,
  antigravityResearchSettingsSchema,
} from "./antigravity-research.js";
import { BACKGROUND_WORK_PROBE } from "./computer-idle.js";
import { EMULATOR_RESEARCH_FINDINGS } from "./research-emulator.js";
import { loadAgyFixture } from "./testing/agy-computer-emulator.js";

// Opt-in, like VERIFY_DOCKER_TEAM_SCREENS: needs a built computer image and a
// reachable daemon, no network and no credentials. VERIFY_DOCKER_BIN selects the
// docker binary when the plain `docker` on PATH has no daemon socket.
const DOCKER = process.env.VERIFY_DOCKER_BIN ?? "docker";
const IMAGE = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
const HOME = "/home/rakazo";

interface Exec {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function docker(args: string[], options: { stdin?: Uint8Array; timeoutMs?: number } = {}) {
  return new Promise<Exec>((resolve, reject) => {
    const child = spawn(DOCKER, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

async function mustDocker(args: string[], options?: { stdin?: Uint8Array; timeoutMs?: number }) {
  const result = await docker(args, options);
  if (result.code !== 0) {
    throw new Error(
      `${DOCKER} ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr}`,
    );
  }
  return result;
}

/** The provider's view of one container: exec, cat and a stdin copy, all through the docker CLI. */
class DockerExecSandbox implements AntigravityResearchSandbox {
  constructor(private readonly container: string) {}

  async *execute(
    _computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const result = await docker(["exec", "-w", HOME, this.container, ...request.argv], {
      timeoutMs: request.timeoutMs,
    });
    const stdout = result.stdout.toString("utf8");
    if (stdout) yield { type: "stdout", data: stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.code };
  }

  async readFile(
    _computer: ComputerRef,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const result = await mustDocker(["exec", this.container, "cat", "--", `${HOME}/${filePath}`]);
    if (options?.maxBytes !== undefined && result.stdout.byteLength > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(result.stdout);
  }

  async writeFile(_computer: ComputerRef, file: PortableFile, _context: AdapterContext) {
    await mustDocker(
      [
        "exec",
        "-i",
        this.container,
        "sh",
        "-c",
        'mkdir -p -- "$(dirname -- "$1")" && cat >"$1" && { [ "$2" != 1 ] || chmod +x "$1"; }',
        "sh",
        `${HOME}/${file.path}`,
        file.executable ? "1" : "0",
      ],
      { stdin: file.content },
    );
  }
}

const ctx: AdapterContext = {
  operationId: "docker-research",
  traceId: "docker-research",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "container",
  botId: "test-bot",
  kind: "docker",
  providerRef: "container",
};
const computerId = "computer-db-1";

function request(jobId: string): ResearchStartRequest {
  return {
    jobId,
    workdir: `bots/test-bot/research/${jobId}`,
    computerId,
    brief: {
      title: "Docker stub run",
      goal: 'Say "hi" $(true) `x`\nsecond line\twith a tab and ünïcödé',
      preferredSources: ["https://research.test/sources/1"],
    },
    depth: "standard",
    budgetMs: 5 * 60_000,
  };
}

async function settled(provider: AntigravityResearchProvider, job: ResearchStartRequest) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const observed = await provider.observe(computer, job, ctx);
    if (observed.status !== "running") return observed;
    if (Date.now() > deadline) throw new Error("research job still running");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe("Antigravity library on a Docker computer (opt-in)", () => {
  it("launches a stub agy detached, keeps the computer awake, persists findings, and cancels", async (test) => {
    if (process.env.VERIFY_DOCKER_RESEARCH !== "1") {
      test.skip(
        "Set VERIFY_DOCKER_RESEARCH=1 with a built computer image (RAKAZO_COMPUTER_IMAGE); VERIFY_DOCKER_BIN selects the docker binary.",
      );
    }
    const daemon = await docker(["version", "--format", "{{.Server.Version}}"]).catch(
      (error: Error) => ({ code: 1, stdout: Buffer.alloc(0), stderr: error.message }),
    );
    if (daemon.code !== 0) {
      test.skip(`Docker daemon unreachable through ${DOCKER}: ${daemon.stderr.trim()}`);
    }
    const name = `rakazo-research-docker-${randomUUID()}`;
    await mustDocker(
      ["run", "-d", "--name", name, "--network", "none", IMAGE, "sleep", "infinity"],
      { timeoutMs: 120_000 },
    );
    try {
      const sandbox = new DockerExecSandbox(name);
      const write = (path: string, content: string, executable = false) =>
        sandbox.writeFile(
          computer,
          { path, content: new TextEncoder().encode(content), executable },
          ctx,
        );
      // The stub never contacts anything: it records argv, waits, and replays a fixture.
      await write("agy-stub/completed.ndjson", loadAgyFixture("completed").events);
      await write(
        "agy-stub/agy-quick",
        [
          "#!/bin/bash",
          'printf "%s\\0" "$@" >argv.bin',
          "sleep 6",
          `cat ${HOME}/agy-stub/completed.ndjson`,
          'printf "stub finished\\n" >&2',
        ].join("\n"),
        true,
      );
      await write("agy-stub/agy-slow", "#!/bin/bash\nsleep 300\n", true);
      const provider = (executable: string) =>
        new AntigravityResearchProvider({
          sandbox,
          settings: { executable: `${HOME}/agy-stub/${executable}`, model: "fixture-model" },
        });
      const idleProbe = () =>
        docker(["exec", name, "bash", "-c", BACKGROUND_WORK_PROBE, "probe", computerId]);
      const exists = async (path: string) =>
        (await docker(["exec", name, "test", "-e", `${HOME}/${path}`])).code === 0;

      // The launch returns while the stub is still sleeping, and the idle probe
      // keyed on the database computer id sees the held marker.
      const quick = provider("agy-quick");
      const job = request("quick");
      const started = await quick.start(computer, job, ctx);
      expect(started.status).toBe("running");
      expect(await exists(`${job.workdir}/${ANTIGRAVITY_JOB_FILES.exitCode}`)).toBe(false);
      expect((await idleProbe()).code).toBe(0);

      const done = await settled(quick, job);
      expect(done.status).toBe("completed");
      expect(done.findings).toEqual(EMULATOR_RESEARCH_FINDINGS);
      expect(done.receipt).toMatchObject({ exitCode: 0, truncated: false });
      const read = async (file: string) =>
        new TextDecoder().decode(await sandbox.readFile(computer, `${job.workdir}/${file}`, ctx));
      expect(await read(ANTIGRAVITY_JOB_FILES.exitCode)).toBe("0\n");
      expect(await read(ANTIGRAVITY_JOB_FILES.stderr)).toBe("stub finished\n");
      expect(JSON.parse(await read(ANTIGRAVITY_JOB_FILES.findings))).toEqual(done.findings);
      expect(await read(ANTIGRAVITY_JOB_FILES.report)).toContain("## Confirmed");
      const argv = (await read("argv.bin")).split("\0").slice(0, -1);
      expect(argv).toEqual(
        antigravityResearchArgv(
          antigravityResearchSettingsSchema.parse({
            executable: `${HOME}/agy-stub/agy-quick`,
            model: "fixture-model",
          }),
          job,
        ).slice(1),
      );
      expect(await idleProbe()).toMatchObject({ code: 1 });
      expect(await quick.observe(computer, job, ctx)).toEqual(done);

      // Cancel kills the detached process for this job only and the marker goes away.
      const slow = provider("agy-slow");
      const slowJob = request("slow");
      expect((await slow.start(computer, slowJob, ctx)).status).toBe("running");
      expect((await idleProbe()).code).toBe(0);
      const cancelled = await slow.cancel(computer, slowJob, ctx);
      expect(cancelled).toMatchObject({ status: "cancelled", receipt: { truncated: true } });
      expect((await idleProbe()).code).toBe(1);
      expect((await slow.cancel(computer, slowJob, ctx)).status).toBe("cancelled");
      expect((await slow.start(computer, slowJob, ctx)).status).toBe("cancelled");

      // A missing executable ends before any marker exists.
      const missing = provider("agy-missing");
      expect(await missing.start(computer, request("missing"), ctx)).toMatchObject({
        status: "failed",
        errorCode: "unavailable",
      });
      expect((await idleProbe()).code).toBe(1);
    } finally {
      await docker(["rm", "-f", name]).catch(() => undefined);
    }
  }, 300_000);
});
