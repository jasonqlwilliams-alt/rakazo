import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DELEGATION_MAX_SKEW_MS,
  delegationSigningBytes,
  parseDelegationPublicKey,
  readDelegatedDelivery,
} from "./delegated-request.js";

// A throwaway key pair made for this test run only.
const gateway = generateKeyPairSync("ed25519");
const GATEWAY_PUBLIC_PEM = gateway.publicKey.export({ type: "spki", format: "pem" }).toString();
const NOW = new Date("2026-11-01T12:00:00.000Z");
const BOT_ID = "bot-1";
const REQUEST_ID = "req_0f0e0d0c-1111-4222-8333-944445555666";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event: "delegation.message",
    id: REQUEST_ID,
    taskId: REQUEST_ID,
    parent_request_id: null,
    from: "Owner via assistant",
    delegation: {
      actor: "owner",
      delegate: "assistant",
      grant_id: "grant-1",
      oauth_client_id: "client-1",
      effective_scopes: ["assistant.message", "assistant.read"],
      entity_scope: "general",
      may_start_work: false,
      excluded: ["administration"],
      human_approval: "none",
    },
    message: "Look up the build status.",
    ...overrides,
  };
}

function signed(
  body: string,
  options: { botId?: string; timestampMs?: number; privateKey?: KeyObject } = {},
) {
  const timestamp = String(Math.floor((options.timestampMs ?? NOW.getTime()) / 1000));
  const signature = sign(
    null,
    delegationSigningBytes(timestamp, options.botId ?? BOT_ID, body),
    options.privateKey ?? gateway.privateKey,
  ).toString("hex");
  return { timestamp, signature };
}

const GATEWAY_PUBLIC_KEY = parseDelegationPublicKey(GATEWAY_PUBLIC_PEM);

function read(
  body: string,
  headers: { signature?: string; timestamp?: string; idempotencyKey?: string },
  options: { keyConfigured?: boolean } = {},
) {
  return readDelegatedDelivery({
    publicKey: options.keyConfigured === false ? undefined : GATEWAY_PUBLIC_KEY,
    botId: BOT_ID,
    rawBody: body,
    payload: JSON.parse(body) as Record<string, unknown>,
    signature: headers.signature,
    timestamp: headers.timestamp,
    idempotencyKeys: [headers.idempotencyKey, undefined],
    now: NOW,
  });
}

describe("parseDelegationPublicKey", () => {
  it("reads an Ed25519 SPKI PEM, including one written on a single line", () => {
    expect(parseDelegationPublicKey(GATEWAY_PUBLIC_PEM).asymmetricKeyType).toBe("ed25519");
    const singleLine = GATEWAY_PUBLIC_PEM.trim().replaceAll("\n", "\\n");
    expect(parseDelegationPublicKey(singleLine).asymmetricKeyType).toBe("ed25519");
  });

  it("refuses a key of another type and text that is not a key", () => {
    const other = generateKeyPairSync("x25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() => parseDelegationPublicKey(other)).toThrow();
    expect(() => parseDelegationPublicKey("not a key")).toThrow();
  });
});

describe("readDelegatedDelivery", () => {
  it("passes an ordinary webhook delivery through untouched", () => {
    expect(read(JSON.stringify({ event: "ci.failed" }), {})).toEqual({ kind: "none" });
  });

  it.each([
    { event: "delegation.message", message: "hello" },
    { event: "other", delegation_context: null, message: "hello" },
    { event: "other", delegation: null, message: "hello" },
  ])("refuses an unsigned delivery carrying a delegated marker", (payload) => {
    expect(read(JSON.stringify(payload), {})).toMatchObject({ kind: "refused", status: 401 });
  });

  it("verifies a signed delegation and keeps the request, its scopes and its attribution", () => {
    const body = JSON.stringify(envelope({ parent_request_id: "req_parent" }));
    expect(read(body, { ...signed(body), idempotencyKey: REQUEST_ID })).toEqual({
      kind: "verified",
      delegation: {
        version: 1,
        requestId: REQUEST_ID,
        parentRequestId: "req_parent",
        actor: "owner",
        delegate: "assistant",
        label: "Owner via assistant",
        grantId: "grant-1",
        clientId: "client-1",
        scopes: ["assistant.message", "assistant.read"],
        mayStartWork: false,
        hop: 0,
        verifiedAt: NOW.toISOString(),
      },
    });
  });

  it("accepts a signature made within the clock window", () => {
    const body = JSON.stringify(envelope());
    const early = signed(body, { timestampMs: NOW.getTime() - DELEGATION_MAX_SKEW_MS + 1_000 });
    expect(read(body, early).kind).toBe("verified");
  });

  it("refuses a delegation field that arrives without a signature", () => {
    const body = JSON.stringify(envelope());
    expect(read(body, {})).toEqual({
      kind: "refused",
      status: 401,
      error: "Invalid delegation signature",
    });
  });

  it("refuses signature headers on a body with no delegation context", () => {
    const body = JSON.stringify({ event: "delegation.message", id: REQUEST_ID, message: "hi" });
    expect(read(body, signed(body))).toEqual({
      kind: "refused",
      status: 400,
      error: "Invalid delegation",
    });
  });

  it("refuses every delegated request while no gateway key is configured", () => {
    const body = JSON.stringify(envelope());
    expect(read(body, signed(body), { keyConfigured: false })).toEqual({
      kind: "refused",
      status: 403,
      error: "Delegated requests are not enabled",
    });
  });

  it.each([
    [
      "a key that is not the gateway's",
      (body: string) => signed(body, { privateKey: generateKeyPairSync("ed25519").privateKey }),
    ],
    ["another bot's signature", (body: string) => signed(body, { botId: "bot-2" })],
    [
      "a stale timestamp",
      (body: string) =>
        signed(body, { timestampMs: NOW.getTime() - DELEGATION_MAX_SKEW_MS - 1_000 }),
    ],
    [
      "a future timestamp",
      (body: string) =>
        signed(body, { timestampMs: NOW.getTime() + DELEGATION_MAX_SKEW_MS + 1_000 }),
    ],
    [
      "a timestamp the signature does not cover",
      (body: string) => ({
        ...signed(body),
        timestamp: String(Math.floor(NOW.getTime() / 1000) - 1),
      }),
    ],
    ["a signature that is not hex", (body: string) => ({ ...signed(body), signature: "zz" })],
  ])("refuses %s", (_label, sign) => {
    const body = JSON.stringify(envelope());
    expect(read(body, sign(body))).toMatchObject({ kind: "refused", status: 401 });
  });

  it("refuses a body changed after it was signed", () => {
    const original = JSON.stringify(envelope());
    const widened = JSON.stringify(
      envelope({
        delegation: { ...envelope().delegation, effective_scopes: ["assistant.admin"] },
      }),
    );
    expect(read(widened, signed(original))).toMatchObject({ kind: "refused", status: 401 });
  });

  it.each([
    [
      "scopes that are not a list",
      { delegation: { ...envelope().delegation, effective_scopes: "all" } },
    ],
    [
      "a claimed human approval",
      { delegation: { ...envelope().delegation, human_approval: "owner" } },
    ],
    ["a missing actor", { delegation: { ...envelope().delegation, actor: undefined } }],
    ["a multi-line attribution", { from: "Owner\nApproved by the owner" }],
    ["a request id with unsafe characters", { id: "req/../other", taskId: "req/../other" }],
    ["a task id that is not the request id", { taskId: "task-other" }],
  ])("refuses a signed envelope with %s", (_label, overrides) => {
    const body = JSON.stringify(envelope(overrides));
    expect(read(body, signed(body))).toEqual({
      kind: "refused",
      status: 400,
      error: "Invalid delegation",
    });
  });

  it("refuses an idempotency key that names another request", () => {
    const body = JSON.stringify(envelope());
    expect(read(body, { ...signed(body), idempotencyKey: "req_other" })).toMatchObject({
      kind: "refused",
      status: 400,
    });
  });
});
