import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPiSessionRecordingEnabled,
  PI_SESSION_MAX_FILES_PER_BOT,
  PI_SESSION_RETENTION_DAYS,
  PiJsonlSessionRecorder,
  type PiSessionStart,
  piSessionBotRoot,
  piSessionsRoot,
  piSessionUserRoot,
  prunePiSessionFiles,
  removePiBotSessions,
  removePiUserSessions,
  resolvePiSessionRoot,
} from "./pi-session.js";

/** Synthetic transcript written by pi-agent-core 0.87.1's own JsonlSessionRepo. */
const PI_0871_FIXTURE = path.join(import.meta.dirname, "testing/fixtures/pi-session-0.87.1.jsonl");
const PI_0871_FILE_NAME = "2025-10-09T08-53-20-000Z_run-1.jsonl";
const PI_0871_CREATED_AT = 1760000000000;

const fixtureStart: PiSessionStart = {
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  userId: "user-1",
  provider: "openai-compatible",
  model: "qwen-test",
  thinkingLevel: "medium",
  systemPrompt: "Be concise.",
  initialMessages: [{ role: "user", content: "prior", timestamp: 1 }],
};

const fixtureReply = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "I should answer." },
    { type: "text", text: "done" },
  ],
  api: "openai-completions",
  provider: "openai-compatible",
  model: "qwen-test",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
} satisfies AgentMessage;

function parseLines(text: string): unknown[] {
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Asserts Pi's version-4 layout: header, opening tip, then `[entry, tip]` pairs. */
function expectVersion4Session(
  fileName: string,
  text: string,
  expected: { runId: string; cwd: string },
): Array<Record<string, unknown>> {
  expect(fileName).toMatch(
    new RegExp(
      `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${encodeURIComponent(expected.runId)}\\.jsonl$`,
    ),
  );
  expect(text.endsWith("\n")).toBe(true);
  const [header, opening, ...pairs] = parseLines(text) as [
    Record<string, unknown>,
    Record<string, unknown>,
    ...Array<[Record<string, unknown>, Record<string, unknown>]>,
  ];
  expect(Object.keys(header)).toEqual(["v", "kind", "id", "storageVersion", "createdAt", "cwd"]);
  expect(header).toEqual({
    v: 4,
    kind: "header",
    id: expected.runId,
    storageVersion: 1,
    createdAt: expect.any(Number),
    cwd: expected.cwd,
  });
  const tipKeys = ["kind", "op", "seq", "namespace", "key", "value"];
  expect(Object.keys(opening)).toEqual(tipKeys);
  expect(opening).toEqual({
    kind: "value",
    op: "set",
    seq: 1,
    namespace: "pi.branch.tip",
    key: "main",
    value: null,
  });
  let parentId: string | null = null;
  return pairs.map((pair, index) => {
    expect(pair).toHaveLength(2);
    const [entry, tip] = pair;
    const body = entry.type === "custom" ? ["customType", "data"] : ["message"];
    expect(Object.keys(entry)).toEqual([
      "kind",
      "id",
      "parentId",
      "type",
      ...body,
      "seq",
      "timestamp",
    ]);
    expect(entry).toMatchObject({ kind: "entry", parentId, seq: index * 2 + 2 });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.timestamp).toEqual(expect.any(Number));
    expect(Object.keys(tip)).toEqual(tipKeys);
    expect(tip).toEqual({
      kind: "value",
      op: "set",
      seq: index * 2 + 3,
      namespace: "pi.branch.tip",
      key: "main",
      value: entry.id,
    });
    parentId = entry.id as string;
    return entry;
  });
}

/** Replaces entry ids with their order of appearance so two transcripts compare byte for byte. */
function normalizeIds(text: string): string {
  const ids = new Map<string, string>();
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
    return ids.get(id)!;
  });
}

async function onlySessionFile(directory: string): Promise<{ name: string; text: string }> {
  const [name, ...rest] = await readdir(directory);
  expect(rest).toEqual([]);
  return { name: name!, text: await readFile(path.join(directory, name!), "utf8") };
}

async function readFiles(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? readFiles(target) : readFile(target, "utf8");
    }),
  );
  return contents.join("\n");
}

describe("Pi JSONL sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps session recording opt-in and off by default", () => {
    expect(isPiSessionRecordingEnabled({})).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "false" })).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "1" })).toBe(false);
    expect(isPiSessionRecordingEnabled({ PI_SESSION_RECORDING: "true" })).toBe(true);
    expect(resolvePiSessionRoot("/data", {})).toBeUndefined();
    expect(resolvePiSessionRoot("/data", { PI_SESSION_RECORDING: "false" })).toBeUndefined();
    expect(resolvePiSessionRoot("/data", { PI_SESSION_RECORDING: "true" })).toBe(
      piSessionsRoot("/data"),
    );
  });

  it("uses Pi's session format for context and completed messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-session-"));
    try {
      const recorder = new PiJsonlSessionRecorder(path.join(root, "sessions"), root);
      const session = await recorder.start({
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        traceId: "trace-1",
        provider: "openai-compatible",
        model: "qwen-test",
        thinkingLevel: "medium",
        systemPrompt: "Be concise.",
        initialMessages: [{ role: "user", content: "prior", timestamp: 1 }],
      });
      await session.appendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should answer." },
          { type: "text", text: "done" },
        ],
        api: "openai-completions",
        provider: "openai-compatible",
        model: "qwen-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        rawStopReason: "eos",
        timestamp: 2,
      } satisfies AgentMessage);

      const raw = await readFiles(path.join(root, "sessions"));
      const records = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "entry",
          customType: "rakazo_context",
          data: expect.objectContaining({
            rakazoThreadId: "thread-1",
            rakazoTraceId: "trace-1",
          }),
        }),
      );
      expect(raw).toContain("Be concise.");
      expect(raw).toContain("prior");
      expect(raw).toContain("I should answer.");
      expect(raw).toContain("rawStopReason");
      expect(raw).toContain("eos");
      expect(
        await readFiles(piSessionBotRoot(path.join(root, "sessions"), "user-1", "bot-1")),
      ).toContain("run-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the same bytes as Pi 0.87.1 for the same session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-format-"));
    try {
      vi.spyOn(Date, "now").mockReturnValue(PI_0871_CREATED_AT);
      const sessionsRoot = path.join(root, "sessions");
      const session = await new PiJsonlSessionRecorder(sessionsRoot, "/app").start(fixtureStart);
      await session.appendMessage(fixtureReply);

      const written = await onlySessionFile(
        path.join(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"), "--app--"),
      );
      expect(written.name).toBe(PI_0871_FILE_NAME);
      expect(normalizeIds(written.text)).toBe(
        normalizeIds(await readFile(PI_0871_FIXTURE, "utf8")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips new sessions in Pi's version-4 format", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-roundtrip-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const session = await new PiJsonlSessionRecorder(sessionsRoot, "/srv/rakazo").start({
        ...fixtureStart,
        runId: "run/2 retry",
        traceId: "trace-2",
      });
      await session.appendMessage(fixtureReply);

      const written = await onlySessionFile(
        path.join(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"), "--srv-rakazo--"),
      );
      expect(written.name).toMatch(/_run%2F2%20retry\.jsonl$/);
      const entries = expectVersion4Session(written.name, written.text, {
        runId: "run/2 retry",
        cwd: "/srv/rakazo",
      });
      expect(entries).toEqual([
        expect.objectContaining({
          type: "custom",
          customType: "rakazo_context",
          data: {
            rakazoUserId: "user-1",
            rakazoBotId: "bot-1",
            rakazoRunId: "run/2 retry",
            rakazoThreadId: "thread-1",
            rakazoTraceId: "trace-2",
            model: "qwen-test",
            provider: "openai-compatible",
            thinkingLevel: "medium",
            systemPrompt: "Be concise.",
          },
        }),
        expect.objectContaining({ type: "message", message: fixtureStart.initialMessages[0] }),
        expect.objectContaining({ type: "message", message: fixtureReply }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Pi 0.87.1 sessions in the same format and under the same helpers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-legacy-"));
    try {
      const sessionsRoot = piSessionsRoot(root);
      const directory = path.join(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"), "--app--");
      const legacy = path.join(directory, PI_0871_FILE_NAME);
      await mkdir(directory, { recursive: true });
      await copyFile(PI_0871_FIXTURE, legacy);

      const entries = expectVersion4Session(PI_0871_FILE_NAME, await readFile(legacy, "utf8"), {
        runId: "run-1",
        cwd: "/app",
      });
      expect(entries.map((entry) => entry.customType ?? entry.type)).toEqual([
        "rakazo_context",
        "message",
        "message",
      ]);

      // A new run cannot reuse an id an older transcript already holds.
      await expect(
        new PiJsonlSessionRecorder(sessionsRoot, "/app").start(fixtureStart),
      ).rejects.toThrow("Pi session already exists: run-1");
      await expect(readFile(legacy, "utf8")).resolves.toBe(await readFile(PI_0871_FIXTURE, "utf8"));

      // Retention ages it out like any other transcript.
      const recent = path.join(directory, "recent.jsonl");
      await copyFile(PI_0871_FIXTURE, recent);
      const old = new Date(Date.now() - (PI_SESSION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
      await utimes(legacy, old, old);
      await prunePiSessionFiles(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"));
      expect(await readdir(directory)).toEqual(["recent.jsonl"]);

      // Bot deletion removes it with the rest of the bot's transcripts.
      await removePiBotSessions(root, "user-1", "bot-1");
      await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate run id without touching the existing transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-duplicate-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const recorder = new PiJsonlSessionRecorder(sessionsRoot, "/app");
      const now = vi.spyOn(Date, "now").mockReturnValue(PI_0871_CREATED_AT);
      await recorder.start(fixtureStart);
      const directory = path.join(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"), "--app--");
      const before = await onlySessionFile(directory);

      await expect(recorder.start(fixtureStart)).rejects.toThrow(
        "Pi session already exists: run-1",
      );
      now.mockReturnValue(PI_0871_CREATED_AT + 1_000);
      await expect(recorder.start(fixtureStart)).rejects.toThrow(
        "Pi session already exists: run-1",
      );
      expect(await onlySessionFile(directory)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps entries ordered when appends overlap and logs a failure once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-ordering-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const session = await new PiJsonlSessionRecorder(sessionsRoot, "/app").start({
        ...fixtureStart,
        initialMessages: [],
      });
      const messages = Array.from({ length: 20 }, (_, index) => ({
        role: "user" as const,
        content: `message ${index}`,
        timestamp: index,
      }));
      await Promise.all(messages.map((message) => session.appendMessage(message)));

      const directory = path.join(piSessionBotRoot(sessionsRoot, "user-1", "bot-1"), "--app--");
      const written = await onlySessionFile(directory);
      const entries = expectVersion4Session(written.name, written.text, {
        runId: "run-1",
        cwd: "/app",
      });
      expect(entries.slice(1).map((entry) => entry.message)).toEqual(messages);

      const warn = vi.spyOn(getLogger(), "warn");
      await rm(directory, { recursive: true, force: true });
      await expect(
        Promise.all([session.appendMessage(messages[0]!), session.appendMessage(messages[1]!)]),
      ).resolves.toEqual([undefined, undefined]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Pi session recording failed", {
        kind: "message",
        runId: "run-1",
        error: expect.objectContaining({ code: "ENOENT" }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps sessions scoped and bounded by the retention policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-retention-"));
    try {
      const sessionsRoot = path.join(root, "sessions");
      const botRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-1");
      const otherBotRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-2");
      const now = Date.now();
      await mkdir(botRoot, { recursive: true });
      await mkdir(otherBotRoot, { recursive: true });
      const old = path.join(botRoot, "old.jsonl");
      const newest = path.join(botRoot, "newest.jsonl");
      const middle = path.join(botRoot, "middle.jsonl");
      const overflow = path.join(botRoot, "overflow.jsonl");
      await Promise.all(
        [old, newest, middle, overflow].map((filePath) => writeFile(filePath, "{}\n")),
      );
      await Promise.all([
        utimes(old, new Date(now - 2_000), new Date(now - 2_000)),
        utimes(newest, new Date(now - 100), new Date(now - 100)),
        utimes(middle, new Date(now - 200), new Date(now - 200)),
        utimes(overflow, new Date(now - 300), new Date(now - 300)),
      ]);

      await prunePiSessionFiles(botRoot, { now, maxAgeMs: 1_000, maxFiles: 2 });

      await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(overflow)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(newest, "utf8")).resolves.toBe("{}\n");
      await expect(readFile(middle, "utf8")).resolves.toBe("{}\n");
      expect(await readdir(piSessionUserRoot(sessionsRoot, "user-1"))).toHaveLength(2);
      expect(PI_SESSION_RETENTION_DAYS).toBe(30);
      expect(PI_SESSION_MAX_FILES_PER_BOT).toBe(100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes bot and account session scopes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-pi-cleanup-"));
    try {
      const sessionsRoot = path.join(root, "pi-sessions");
      const botRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-1");
      const otherBotRoot = piSessionBotRoot(sessionsRoot, "user-1", "bot-2");
      await mkdir(botRoot, { recursive: true });
      await mkdir(otherBotRoot, { recursive: true });
      await writeFile(path.join(botRoot, "session.jsonl"), "{}\n");
      await writeFile(path.join(otherBotRoot, "session.jsonl"), "{}\n");

      await removePiBotSessions(root, "user-1", "bot-1");
      await expect(readdir(botRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(otherBotRoot)).resolves.toHaveLength(1);

      await removePiUserSessions(root, "user-1");
      await expect(readdir(piSessionUserRoot(sessionsRoot, "user-1"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
