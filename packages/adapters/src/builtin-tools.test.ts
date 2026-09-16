import { describe, expect, it } from "vitest";

describe("BUILTIN_AGENT_TOOL_NAMES", () => {
  it("includes the webhook routine allowlist tools", async () => {
    const { BUILTIN_AGENT_TOOL_NAMES } = await import("./builtin-tools.js");
    for (const name of [
      "shell",
      "message_bot",
      "scratchpad_add",
      "scratchpad_update",
      "scratchpad_list",
    ]) {
      expect(BUILTIN_AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});
