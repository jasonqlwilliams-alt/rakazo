import { describe, expect, it } from "vitest";
import {
  builtinAgentTools,
  DELEGATION_TOOL_NAMES,
  SUBAGENT_EXCLUDED_TOOL_NAMES,
} from "./builtin-tools.js";

const sendToBot = builtinAgentTools.find((tool) => tool.name === "send_to_bot");

describe("send_to_bot tool definition", () => {
  it("is offered to bots alongside spawn_bot", () => {
    expect(sendToBot).toBeTruthy();
    expect(builtinAgentTools.some((tool) => tool.name === "spawn_bot")).toBe(true);
  });

  it("takes a note plus either a bot id or an exact name", () => {
    const schema = sendToBot?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["bot_id", "name", "text"]);
    expect(schema.required).toEqual(["text"]);
  });

  it("tells the model it messages an existing bot and never creates one", () => {
    expect(sendToBot?.description).toMatch(/already exists/i);
    expect(sendToBot?.description).toMatch(/never creates|does not create|that is spawn_bot/i);
  });

  it("is not a delegation tool — it is not a spawn alias", () => {
    expect(DELEGATION_TOOL_NAMES.has("send_to_bot")).toBe(false);
    expect([...DELEGATION_TOOL_NAMES].sort()).toEqual([
      "archive_bot",
      "delete_bot",
      "handoff_to_bot",
      "message_bot",
      "run_subagent",
      "spawn_bot",
    ]);
  });

  it("is kept away from in-turn subagents, which would send under the host bot's name", () => {
    expect(SUBAGENT_EXCLUDED_TOOL_NAMES.has("send_to_bot")).toBe(true);
    for (const name of DELEGATION_TOOL_NAMES) {
      expect(SUBAGENT_EXCLUDED_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});
