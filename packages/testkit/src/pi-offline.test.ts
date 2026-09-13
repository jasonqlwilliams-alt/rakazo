import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { type ModelEmulatorRequest, startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

const writeTool: ConnectorTool = {
  name: "write_file",
  description: "Save a UTF-8 file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

function runRequest(
  model: AgentRunRequest["model"],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Save hello to notes.txt.",
    instructions: "Complete the requested task.",
    history: [],
    tools: [writeTool],
    model,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>, events: AgentRuntimeEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

function latestToolResult(request: ModelEmulatorRequest) {
  return request.messages.findLast((message) => message.role === "tool");
}

describe("real Pi against an offline model HTTP endpoint", () => {
  it("keeps the original HTTP 503 diagnostic despite Retry-After", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "error",
            status: 503,
            message: "No available provider",
            headers: { "Retry-After": "10" },
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(new PiAgentRuntime().run(runRequest(server.model)), events),
    ).rejects.toThrow("No available provider");
    expect(events.filter((event) => event.type === "progress")).toEqual([]);
    server.assertComplete();
  });

  it("replays a request whose half-streamed tool call hit a quota stop and runs the tool once", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    let writes = 0;
    let failedRequest: ModelEmulatorRequest | undefined;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            failedRequest = request;
          },
          response: {
            type: "stream-error",
            text: "",
            message: "429 rate limit",
            partialToolCall: { id: "cut-off", name: "write_file", arguments: '{"path":"no' },
          },
        },
        {
          expect(request) {
            expect(request).toEqual(failedRequest);
          },
          response: {
            type: "tool",
            id: "replayed",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(request.messages.filter((message) => message.role === "assistant")).toHaveLength(
              1,
            );
            expect(latestToolResult(request)?.tool_call_id).toBe("replayed");
          },
          response: { type: "text", text: "Saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const executions: string[] = [];
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async (_name, _args, executionId) => {
            writes++;
            executions.push(executionId);
            return { saved: true };
          },
        }),
      ),
    );
    server.assertComplete();
    expect(writes).toBe(1);
    expect(executions).toEqual(["replayed"]);
    expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved." });
  });

  it("replays a request after streamed text hit a quota stop without repeating the text", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    let failedRequest: ModelEmulatorRequest | undefined;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            failedRequest = request;
          },
          response: { type: "stream-error", text: "Saving now. ", message: "429 rate limit" },
        },
        {
          expect(request) {
            expect(request).toEqual(failedRequest);
          },
          response: { type: "text", text: "Saving it now. Saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(new PiAgentRuntime().run(runRequest(server.model)));
    server.assertComplete();
    expect(
      events.filter(
        (event) => event.type === "text" || event.type === "retract" || event.type === "done",
      ),
    ).toEqual([
      { type: "text", text: "Saving now. " },
      { type: "retract", chars: "Saving now. ".length },
      { type: "text", text: "Saving it now. Saved." },
      { type: "done", text: "Saving it now. Saved." },
    ]);
    // The retraction lands after the quota notice and before any replayed text.
    const retract = events.findIndex((event) => event.type === "retract");
    expect(events.slice(0, retract)).toContainEqual({
      type: "progress",
      text: "Quota, retrying in 1s (1/3).",
    });
  });

  it("runs no replayed tool call until the consumer has applied the retraction", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "stream-error", text: "Saving now. ", message: "429 rate limit" },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "update",
            name: "message_user",
            arguments: { text: "Saved it." },
          },
        },
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
    });
    cleanups.push(() => server.close());
    const messageUser: ConnectorTool = {
      name: "message_user",
      description: "Post a short progress update",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    };
    // Stand in for the executor: its unpublished text, and a publish from message_user.
    let unpublished = "";
    const published: string[] = [];
    let toolRan!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      toolRan = resolve;
    });
    const events = new PiAgentRuntime().run(
      runRequest(server.model, {
        tools: [messageUser],
        executeTool: async () => {
          toolRan();
          published.push(unpublished);
          unpublished = "";
          return { ok: true };
        },
      }),
    );
    for await (const event of events) {
      if (event.type === "text") unpublished += event.text;
      if (event.type === "retract") {
        // The executor is mid-await (a lease read or event append) when the replay arrives.
        await Promise.race([toolRunning, new Promise((resolve) => setTimeout(resolve, 300))]);
        unpublished = unpublished.slice(0, unpublished.length - event.chars);
      }
    }
    server.assertComplete();
    expect(published).toEqual([""]);
  });

  it("settles the run when its consumer stops reading at a retraction", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "stream-error", text: "Saving now. ", message: "429 rate limit" },
        },
        {
          expect() {},
          response: { type: "stream-error", text: "Retrying. ", message: "429 rate limit" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const seen: string[] = [];
    for await (const event of new PiAgentRuntime().run(runRequest(server.model))) {
      seen.push(event.type);
      if (event.type === "retract") break;
    }
    expect(seen.at(-1)).toBe("retract");
    server.assertComplete();
  });

  it("orders consecutive quota notices after replayed text during a slow retraction", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "stream-error", text: "First attempt. ", message: "429 rate limit" },
        },
        {
          expect() {},
          response: { type: "stream-error", text: "Second attempt. ", message: "429 rate limit" },
        },
        { expect() {}, response: { type: "text", text: "Saved." } },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(runRequest(server.model))) {
      events.push(event);
      if (event.type === "retract" && event.chars === "First attempt. ".length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    server.assertComplete();
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "text", text: "First attempt. " },
      { type: "progress", text: "Quota, retrying in 1s (1/3)." },
      { type: "progress", text: "" },
      { type: "retract", chars: "First attempt. ".length },
      { type: "text", text: "Second attempt. " },
      { type: "progress", text: "Quota, retrying in 1s (2/3)." },
      { type: "progress", text: "" },
      { type: "retract", chars: "Second attempt. ".length },
      { type: "text", text: "Saved." },
      { type: "done", text: "Saved." },
    ]);
  });

  it("drops a nested model call's discarded text from the subagent result", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "delegate",
            name: "run_subagent",
            arguments: { name: "Research", task: "Summarize the fixture." },
          },
        },
        {
          expect() {},
          response: { type: "stream-error", text: "Research is ", message: "429 rate limit" },
        },
        { expect() {}, response: { type: "text", text: "Research complete." } },
        {
          expect(request) {
            expect(latestToolResult(request)?.content).toBe("Research complete.");
          },
          response: { type: "text", text: "Summary ready." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        }),
      ),
    );
    server.assertComplete();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result: "Research complete.",
      }),
    );
    expect(events.filter((event) => event.type === "retract")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Summary ready." });
  });

  it("retries a nested model call and reports its quota wait as subagent progress", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "delegate",
            name: "run_subagent",
            arguments: { name: "Research", task: "Summarize the fixture." },
          },
        },
        { expect() {}, response: { type: "error", status: 429, message: "Busy" } },
        { expect() {}, response: { type: "text", text: "Research complete." } },
        {
          expect(request) {
            expect(latestToolResult(request)?.content).toContain("Research complete.");
          },
          response: { type: "text", text: "Summary ready." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        }),
      ),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        name: "Research",
        status: "running",
        progress: "Quota, retrying in 1s (1/3).",
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Summary ready." });
    server.assertComplete();
  });

  it("retries the failed continuation without replaying a completed tool effect", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    let writes = 0;
    let failedRequest: ModelEmulatorRequest | undefined;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "quota-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            failedRequest = request;
            expect(latestToolResult(request)?.tool_call_id).toBe("quota-write");
          },
          response: { type: "error", status: 429, message: "Tokens per minute exceeded" },
        },
        {
          expect(request) {
            expect(request).toEqual(failedRequest);
          },
          response: { type: "text", text: "Saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async () => {
            writes++;
            return { saved: true };
          },
        }),
      ),
    );
    server.assertComplete();
    expect(writes).toBe(1);
    expect(events.filter((event) => event.type === "progress" && !event.activity)).toEqual([
      { type: "progress", text: "Quota, retrying in 1s (1/3)." },
      { type: "progress", text: "" },
    ]);
    const resumedTextIndex = events.findIndex((event) => event.type === "text");
    expect(resumedTextIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(0, resumedTextIndex)).toContainEqual({ type: "progress", text: "" });
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved." });
  });

  it("preserves Retry-After and clears visible quota progress on cancellation", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "error",
            status: 429,
            message: "Busy",
            headers: { "Retry-After": "90" },
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    try {
      for await (const event of new PiAgentRuntime().run(runRequest(server.model), {
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "progress" && event.text.startsWith("Quota,")) controller.abort();
      }
    } catch {
      expect(controller.signal.aborted).toBe(true);
    }
    server.assertComplete();
    expect(events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", text: "Quota, retrying in 90s (1/3)." },
      { type: "progress", text: "" },
    ]);
  });

  it("fails the run with the quota receipt when retries are exhausted", async () => {
    vi.stubEnv("RAKAZO_QUOTA_RETRY_MS", "1");
    const server = await startModelEmulator({
      steps: Array.from({ length: 4 }, () => ({
        expect() {},
        response: { type: "error" as const, status: 429, message: "quota exceeded" },
      })),
    });
    cleanups.push(() => server.close());
    await expect(collect(new PiAgentRuntime().run(runRequest(server.model)))).rejects.toThrow(
      "Quota retry failed after 3 retries. Try again later.",
    );
    server.assertComplete();
  });

  it("assembles fragmented tool arguments, executes the write, and sends its result back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-offline-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
    const server = await startModelEmulator({
      apiKey: "fixture-only-key",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: [{ type: "text", text: "Save hello to notes.txt." }],
            });
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "write-1",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello\n" },
            argumentChunks: ['{"pa', 'th":"notes.', 'txt","content":"hel', "lo\\", 'n"}'],
          },
        },
        {
          expect(request) {
            expect(
              request.messages.find((message) => message.role === "assistant")?.tool_calls,
            ).toEqual([
              {
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "notes.txt", content: "hello\n" }),
                },
              },
            ]);
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "write-1" });
            expect(JSON.parse(String(latestToolResult(request)?.content))).toEqual({
              path: "notes.txt",
              bytes: 6,
            });
          },
          response: { type: "text", text: "Saved notes.txt." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          async executeTool(name, args, id) {
            calls.push({ name, args, id });
            expect(name).toBe("write_file");
            expect(args.path).toBe("notes.txt");
            await writeFile(path.join(dir, "notes.txt"), String(args.content));
            return { path: "notes.txt", bytes: Buffer.byteLength(String(args.content)) };
          },
        }),
      ),
    ).catch((error) => {
      try {
        server.assertComplete();
      } catch (fixtureError) {
        throw new AggregateError(
          [error, fixtureError],
          "Pi failed and model fixture validation also failed",
        );
      }
      throw error;
    });
    server.assertComplete();
    expect(calls).toEqual([
      { name: "write_file", args: { path: "notes.txt", content: "hello\n" }, id: "write-1" },
    ]);
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("hello\n");
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved notes.txt." });
  });

  it("returns tool failure to the model and continues without claiming a successful write", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "denied-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "denied-write" });
            expect(String(latestToolResult(request)?.content)).toContain("Fixture write denied");
          },
          response: { type: "text", text: "The file could not be saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async () => {
            calls++;
            throw new Error("Fixture write denied");
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", text: "The file could not be saved." });
  });

  it("propagates a provider rejection without dispatching tools or emitting done", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "error", status: 400, message: "Fixture request rejected" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            executeTool: async () => {
              calls++;
              return {};
            },
          }),
        ),
        events,
      ),
    ).rejects.toThrow(/Fixture request rejected/);
    server.assertComplete();
    expect(calls).toBe(0);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects an interrupted SSE response without emitting successful completion", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "disconnect", text: "Working" } }],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(new PiAgentRuntime().run(runRequest(server.model)), events),
    ).rejects.toThrow();
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("cancels a quiet HTTP stream and closes the provider connection", async () => {
    const opened = deferred();
    const closed = deferred();
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "hold",
            onOpen: opened.resolve,
            onClose: closed.resolve,
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const work = collect(
      new PiAgentRuntime().run(runRequest(server.model), { signal: controller.signal }),
      events,
    );
    // Attach the rejection handler before aborting to avoid an unhandled rejection.
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await closed.promise;
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("keeps two model connections and their responses isolated", async () => {
    const first = await startModelEmulator({
      modelId: "fixture-first",
      apiKey: "first-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "First connection" } }],
    });
    const second = await startModelEmulator({
      modelId: "fixture-second",
      apiKey: "second-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "Second connection" } }],
    });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const runtime = new PiAgentRuntime();
    const results = await Promise.all(
      [first, second].map((server) => collect(runtime.run(runRequest(server.model)))),
    );
    expect(results.map((events) => events.at(-1))).toEqual([
      { type: "done", text: "First connection" },
      { type: "done", text: "Second connection" },
    ]);
    first.assertComplete();
    second.assertComplete();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
