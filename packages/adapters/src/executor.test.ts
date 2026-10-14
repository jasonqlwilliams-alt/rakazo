import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToText, MAX_MODEL_TOOL_COUNT, selectModelTools } from "./executor.js";

function tool(name: string, description = name): ConnectorTool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
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

  it("uses a provider-safe default ceiling", () => {
    const discovered = Array.from({ length: 400 }, (_, index) =>
      tool(`${["SLACK", "GMAIL", "GOOGLEDRIVE", "GOOGLECALENDAR"][index % 4]}_ACTION_${index}`),
    );
    const selection = selectModelTools([tool("shell")], discovered, "status");

    expect(selection.tools).toHaveLength(MAX_MODEL_TOOL_COUNT);
    expect(selection.tools.length).toBeLessThan(350);
  });
});
