import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  archivalHistoryExclusion,
  blocksToText,
  MAX_MODEL_TOOL_BYTES,
  MAX_MODEL_TOOL_COUNT,
  modelToolMaxBytes,
  selectModelTools,
  toolSchemaBytes,
} from "./executor.js";

function tool(name: string, description = name): ConnectorTool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

/** A tool whose schema costs roughly `bytes`, the way a real connector's biggest ones do. */
function fatTool(name: string, bytes: number): ConnectorTool {
  return { name, description: "x".repeat(Math.max(0, bytes - name.length)), inputSchema: {} };
}

const note = {
  kind: "agent_note",
  fromBotId: "bot-eleusis",
  fromName: "Eleusis",
  toBotId: "bot-thor",
  toName: "Thor",
  text: "hold the venue list until I confirm",
} as const;

describe("model context for a peer note", () => {
  it("tells the receiving bot the note came from a peer, not the user", () => {
    const text = blocksToText([{ ...note, direction: "received" } as MessageBlock]);

    expect(text).toBe("[agent] note from peer bot Eleusis: hold the venue list until I confirm");
    // The bare note text alone would read as if the user had typed it.
    expect(text).not.toBe(note.text);
  });

  it("tells the sending bot the note went out", () => {
    const text = blocksToText([{ ...note, direction: "sent" } as MessageBlock]);

    expect(text).toBe("[agent] note sent to Thor: hold the venue list until I confirm");
  });

  it("leaves every other block kind alone", () => {
    expect(blocksToText([{ kind: "text", text: "plain" }])).toBe("plain");
    expect(blocksToText([{ kind: "meta", text: "Created by Chief" }])).toBe("Created by Chief");
  });
});

describe("model tool selection", () => {
  it("leaves a deduplicated tool set below the limit unchanged", () => {
    const builtins = [tool("shell"), tool("read_file")];
    const selection = selectModelTools(
      builtins,
      [tool("shell"), tool("SLACK_SEND_MESSAGE")],
      "send a message",
      10,
    );

    expect(selection).toEqual({
      tools: [...builtins, tool("SLACK_SEND_MESSAGE")],
      curated: false,
      omittedCount: 0,
    });
  });

  it("caps a large catalog while retaining built-ins, gateways, and every toolkit", () => {
    const builtins = [tool("shell"), tool("read_file")];
    const gateways = [
      tool("destination.write"),
      tool("COMPOSIO_SEARCH_TOOLS"),
      tool("COMPOSIO_EXECUTE_TOOL"),
    ];
    const direct = ["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLETASKS"].flatMap((group) =>
      Array.from({ length: 120 }, (_, index) => tool(`${group}_ACTION_${index}`)),
    );

    const selection = selectModelTools(builtins, [...gateways, ...direct], "status", 40);
    const names = selection.tools.map((entry) => entry.name);

    expect(selection.curated).toBe(true);
    expect(selection.tools).toHaveLength(40);
    expect(selection.omittedCount).toBe(builtins.length + gateways.length + direct.length - 40);
    expect(names).toEqual(expect.arrayContaining(builtins.map((entry) => entry.name)));
    expect(names).toEqual(expect.arrayContaining(gateways.map((entry) => entry.name)));
    for (const group of ["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLETASKS"]) {
      expect(names.some((name) => name.startsWith(`${group}_`))).toBe(true);
    }
  });

  it("ranks prompt-relevant tools first within a toolkit", () => {
    const selection = selectModelTools(
      [tool("shell")],
      [
        tool("COMPOSIO_SEARCH_TOOLS"),
        tool("SLACK_ARCHIVE_CHANNEL"),
        tool("SLACK_SEND_MESSAGE", "Send a message to Slack"),
        tool("GMAIL_LIST_THREADS"),
        tool("GMAIL_SEND_EMAIL"),
      ],
      "Send a Slack message",
      4,
    );
    const names = selection.tools.map((entry) => entry.name);

    expect(names).toContain("SLACK_SEND_MESSAGE");
    expect(names).toContain("GMAIL_SEND_EMAIL");
    expect(names).not.toContain("SLACK_ARCHIVE_CHANNEL");
  });

  it("caps the tool schemas by bytes, not only by count", () => {
    // Twelve 40 KB tools are only twelve tools, so the count cap never fires -- but they
    // are 480 KB of prompt. The live workspace's largest single schema is 18 KB.
    const discovered = ["SLACK", "GMAIL", "SUPABASE"].flatMap((group) =>
      Array.from({ length: 4 }, (_, index) => fatTool(`${group}_FAT_${index}`, 40_000)),
    );

    const selection = selectModelTools([tool("shell")], discovered, "status", 300, 100_000);
    const bytes = selection.tools.reduce((total, entry) => total + toolSchemaBytes(entry), 0);

    expect(selection.curated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(100_000);
    expect(selection.tools.length).toBeLessThan(discovered.length + 1);
    expect(selection.omittedCount).toBeGreaterThan(0);
    // The built-in still has to be there.
    expect(selection.tools.map((entry) => entry.name)).toContain("shell");
  });

  it("steps over one oversized schema to admit the smaller tools behind it", () => {
    const selection = selectModelTools(
      [tool("shell")],
      [fatTool("SLACK_HUGE", 90_000), tool("SLACK_SEND_MESSAGE"), tool("GMAIL_SEND_EMAIL")],
      "status",
      300,
      20_000,
    );
    const names = selection.tools.map((entry) => entry.name);

    expect(names).not.toContain("SLACK_HUGE");
    expect(names).toContain("SLACK_SEND_MESSAGE");
    expect(names).toContain("GMAIL_SEND_EMAIL");
  });

  it("takes the tool-schema budget from the environment when one is set", () => {
    expect(modelToolMaxBytes({})).toBe(MAX_MODEL_TOOL_BYTES);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "65536" })).toBe(65_536);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "" })).toBe(MAX_MODEL_TOOL_BYTES);
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "nonsense" })).toBe(
      MAX_MODEL_TOOL_BYTES,
    );
    expect(modelToolMaxBytes({ AGENT_MODEL_TOOL_MAX_BYTES: "-1" })).toBe(MAX_MODEL_TOOL_BYTES);
  });

  it("uses a provider-safe default ceiling", () => {
    const discovered = Array.from({ length: 400 }, (_, index) =>
      tool(`${["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLECALENDAR"][index % 4]}_ACTION_${index}`),
    );
    const selection = selectModelTools([tool("shell")], discovered, "status");

    expect(selection.tools).toHaveLength(MAX_MODEL_TOOL_COUNT);
    expect(selection.tools.length).toBeLessThan(350);
  });
});

describe("recent history excludes imported Grokbot transcript", () => {
  // The importer writes archival records into the live thread at the newest seq, so without
  // this every seat's window filled with old Grokbot conversation and its real Rakazo work
  // fell out entirely -- 200 of 200 on seven seats, 198 of 200 on the eighth.
  const matches = (blocks: Array<{ kind: string; text: string }>) => {
    const [first] = blocks;
    const clause = archivalHistoryExclusion().NOT.AND;
    const kind = clause[0]?.blocks as { path: string[]; equals: string };
    const text = clause[1]?.blocks as { path: string[]; string_starts_with: string };
    return first?.kind === kind.equals && first.text.startsWith(text.string_starts_with);
  };

  it("targets the first block's kind and source label", () => {
    const clause = archivalHistoryExclusion().NOT.AND;

    expect(clause).toHaveLength(2);
    const [kindClause, textClause] = clause;
    expect((kindClause?.blocks as { path: string[] } | undefined)?.path).toEqual(["0", "kind"]);
    expect((textClause?.blocks as { path: string[] } | undefined)?.path).toEqual(["0", "text"]);
  });

  it("excludes an imported transcript record", () => {
    expect(
      matches([
        { kind: "meta", text: "Source: Grok · transcript 22425e78 · record 37440/37440" },
        { kind: "text", text: "Grok keeps two piles on my computer" },
      ]),
    ).toBe(true);
  });

  it("excludes it whether the importer says Grok or Grokbot", () => {
    expect(matches([{ kind: "meta", text: "Source: Grokbot · transcript abc · record 1/2" }])).toBe(
      true,
    );
  });

  it("keeps the seat's own Rakazo turns", () => {
    expect(matches([{ kind: "text", text: "MemoraX 58.02, MemOS 45.89" }])).toBe(false);
    expect(matches([{ kind: "meta", text: "Created by Chief" }])).toBe(false);
  });
});
