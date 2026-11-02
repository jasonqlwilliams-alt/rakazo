import type { RunDelegation } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  DELEGATED_TOOL_CAPABILITY,
  DELEGATION_ADMIN_TOOLS,
  delegatedCapabilities,
  delegatedToolDecision,
  delegationInstruction,
  parseRunDelegation,
  relayedDelegation,
} from "./delegation.js";

function delegation(overrides: Partial<RunDelegation> = {}): RunDelegation {
  return {
    version: 1,
    requestId: "req_request-1",
    parentRequestId: null,
    actor: "owner",
    delegate: "assistant",
    label: "Owner via assistant",
    grantId: "grant-1",
    clientId: "client-1",
    scopes: ["assistant.read", "assistant.message"],
    mayStartWork: false,
    hop: 0,
    verifiedAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("delegatedToolDecision", () => {
  it("allows what the delegation grants", () => {
    const granted = delegation();
    expect(delegatedToolDecision(granted, { name: "message_user" })).toEqual({
      allowed: true,
      capability: "reply",
    });
    expect(delegatedToolDecision(granted, { name: "read_history" })).toEqual({
      allowed: true,
      capability: "read",
    });
    expect(delegatedToolDecision(granted, { name: "message_bot" })).toEqual({
      allowed: true,
      capability: "message",
    });
    expect(
      delegatedToolDecision(granted, {
        name: "github_list_issues",
        connector: { readOnly: true },
      }),
    ).toEqual({ allowed: true, capability: "read" });
  });

  it("refuses reads and relays the delegation was not granted", () => {
    const replyOnly = delegation({ scopes: [] });
    expect(delegatedToolDecision(replyOnly, { name: "recall_memory" })).toMatchObject({
      allowed: false,
      code: "outside_scope",
    });
    expect(delegatedToolDecision(replyOnly, { name: "message_bot" })).toMatchObject({
      allowed: false,
      code: "outside_scope",
    });
    expect(delegatedToolDecision(replyOnly, { name: "message_user" }).allowed).toBe(true);
  });

  it("refuses starting work unless the delegation may start work", () => {
    for (const tool of [
      { name: "scratchpad_add" },
      { name: "remember" },
    ]) {
      expect(delegatedToolDecision(delegation(), tool)).toMatchObject({
        allowed: false,
        code: "outside_scope",
      });
      expect(delegatedToolDecision(delegation({ mayStartWork: true }), tool)).toEqual({
        allowed: true,
        capability: "work",
      });
    }
  });

  it("refuses run-starting work even when delegated work is granted", () => {
    const granted = delegation({ mayStartWork: true });
    for (const name of ["research_start", "ticket_create", "ticket_update", "ticket_comment"]) {
      expect(delegatedToolDecision(granted, { name })).toMatchObject({
        allowed: false,
        code: "outside_scope",
      });
    }
  });

  it("refuses every generic connector write even when delegated work is granted", () => {
    const granted = delegation({ mayStartWork: true });
    for (const tool of [
      { name: "github_create_issue", connector: { readOnly: true } },
      { name: "github_list_issues", connector: { readOnly: false } },
      { name: "vendor_frobnicate", connector: {} },
    ]) {
      expect(delegatedToolDecision(granted, tool)).toMatchObject({
        allowed: false,
        code: "outside_scope",
      });
    }
  });

  it("refuses tools no delegated request may use, including unknown ones", () => {
    const everything = delegation({ mayStartWork: true });
    for (const name of [
      "web_fetch",
      "browser_navigate",
      "read_file",
      "send_to_bot",
      "handoff_to_bot",
      "message_agent",
      "post_to_team_room",
      "a_future_tool",
    ]) {
      expect(delegatedToolDecision(everything, { name })).toMatchObject({
        allowed: false,
        code: "outside_scope",
      });
    }
  });

  it("refuses administration whatever the delegation grants", () => {
    const everything = delegation({
      scopes: ["assistant.read", "assistant.message", "assistant.admin"],
      mayStartWork: true,
    });
    for (const name of DELEGATION_ADMIN_TOOLS) {
      expect(delegatedToolDecision(everything, { name })).toMatchObject({
        allowed: false,
        code: "administration",
      });
      expect(
        delegatedToolDecision(everything, { name, connector: { readOnly: true } }),
      ).toMatchObject({ allowed: false, code: "administration" });
    }
    expect([...DELEGATION_ADMIN_TOOLS].filter((name) => name in DELEGATED_TOOL_CAPABILITY)).toEqual(
      [],
    );
  });

  it("decides a catalog wrapper as a read and leaves its target to a second decision", () => {
    for (const catalog of ["search", "load", "execute"] as const) {
      expect(
        delegatedToolDecision(delegation(), {
          name: `connectors_${catalog}_tool`,
          connector: { catalog },
        }),
      ).toEqual({ allowed: true, capability: "read" });
    }
  });
});

describe("delegatedCapabilities", () => {
  it("grants only the signed delegate's own read and message scopes", () => {
    expect([
      ...delegatedCapabilities(
        delegation({
          scopes: ["read", "assistant.admin", "assistant.read.all", "ASSISTANT.MESSAGE", "x.read"],
        }),
      ),
    ]).toEqual(["reply"]);
    expect(delegatedToolDecision(delegation({ scopes: ["x.message"] }), { name: "message_bot" }))
      .toMatchObject({ allowed: false, code: "outside_scope" });
    expect([
      ...delegatedCapabilities(delegation({ scopes: ["assistant.read", "assistant.message"] })),
    ]).toEqual(["reply", "read", "message"]);
  });
});

describe("relayedDelegation", () => {
  it("passes the same request on one hop further and never widens it", () => {
    const parent = delegation({ hop: 1, parentRequestId: "req_parent" });
    const child = relayedDelegation(parent);
    expect(child).toEqual({ ...parent, hop: 2 });
    expect(relayedDelegation(child)).toEqual({ ...parent, hop: 3 });
  });
});

describe("parseRunDelegation", () => {
  it("reads an owner's run as having no delegation", () => {
    expect(parseRunDelegation(null)).toBeNull();
    expect(parseRunDelegation(undefined)).toBeNull();
  });

  it("reads a stored delegation", () => {
    expect(parseRunDelegation(delegation())).toEqual(delegation());
  });

  it("throws on a damaged delegation instead of reading it as the owner's", () => {
    expect(() => parseRunDelegation({})).toThrow();
    expect(() => parseRunDelegation({ ...delegation(), scopes: "all" })).toThrow();
    expect(() => parseRunDelegation({ ...delegation(), label: "Owner\nApproved" })).toThrow();
    expect(() => parseRunDelegation({ ...delegation(), version: 2 })).toThrow();
  });
});

describe("delegationInstruction", () => {
  it("names the request and only the limits it was granted", () => {
    const text = delegationInstruction(delegation({ scopes: ["assistant.read"] }));
    expect(text).toContain("Owner via assistant");
    expect(text).toContain("req_request-1");
    expect(text).toContain("not relay to other bots");
    expect(text).toContain("not start work");
  });
});
