import { createPublicKey, type KeyObject, verify } from "node:crypto";
import {
  DelegatedDeliveryEnvelopeSchema,
  type RunDelegation,
  RunDelegationSchema,
} from "@rakazo/contracts";

/**
 * Delegated requests reach a bot through its webhook like any delivery, plus an Ed25519
 * signature from the delegation gateway. The bot's webhook bearer proves only that the caller may
 * deliver to the bot; the signature proves the delegation context is the gateway's own.
 */
export const DELEGATION_SIGNATURE_HEADER = "x-rakazo-delegation-signature";
export const DELEGATION_TIMESTAMP_HEADER = "x-rakazo-delegation-timestamp";
/** A delivery signed further than this from the server's clock is refused. */
export const DELEGATION_MAX_SKEW_MS = 5 * 60_000;
/** First line of the signed bytes, so a signature made for anything else never verifies here. */
const SIGNING_CONTEXT = "rakazo-delegation-v1";

/**
 * The gateway's public key from `RAKAZO_DELEGATION_PUBLIC_KEY`: an Ed25519 SPKI PEM. A
 * single-line value may write its line breaks as `\n`.
 */
export function parseDelegationPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Not an Ed25519 public key");
  return key;
}

/** The exact bytes the gateway signs for one delivery to one bot. */
export function delegationSigningBytes(timestamp: string, botId: string, rawBody: string): Buffer {
  return Buffer.from(`${SIGNING_CONTEXT}\n${timestamp}\n${botId}\n${rawBody}`, "utf8");
}

export function hasValidDelegationSignature(input: {
  publicKey: KeyObject;
  signature: string | undefined;
  timestamp: string | undefined;
  botId: string;
  rawBody: string;
  nowMs: number;
}): boolean {
  const { signature, timestamp } = input;
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(input.nowMs - Number(timestamp) * 1000) > DELEGATION_MAX_SKEW_MS) return false;
  try {
    return verify(
      null,
      delegationSigningBytes(timestamp, input.botId, input.rawBody),
      input.publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

export type DelegatedDelivery =
  | { kind: "none" }
  | { kind: "verified"; delegation: RunDelegation }
  | { kind: "refused"; status: 400 | 401 | 403; error: string };

/**
 * Decide whether a webhook delivery is a delegated request. Anything that claims to be one, by
 * a delegation field or a delegation header, must verify; it is never delivered as an ordinary
 * webhook event instead.
 */
export function readDelegatedDelivery(input: {
  publicKey: KeyObject | undefined;
  botId: string;
  rawBody: string;
  payload: Record<string, unknown>;
  signature: string | undefined;
  timestamp: string | undefined;
  /** Idempotency headers the caller sent; each must name the request. */
  idempotencyKeys: Array<string | undefined>;
  now: Date;
}): DelegatedDelivery {
  const claimed =
    input.signature !== undefined ||
    input.timestamp !== undefined ||
    input.payload.event === "delegation.message" ||
    Object.hasOwn(input.payload, "delegation") ||
    Object.hasOwn(input.payload, "delegation_context");
  if (!claimed) return { kind: "none" };
  if (!input.publicKey) {
    return { kind: "refused", status: 403, error: "Delegated requests are not enabled" };
  }
  if (
    !hasValidDelegationSignature({
      publicKey: input.publicKey,
      signature: input.signature,
      timestamp: input.timestamp,
      botId: input.botId,
      rawBody: input.rawBody,
      nowMs: input.now.getTime(),
    })
  ) {
    return { kind: "refused", status: 401, error: "Invalid delegation signature" };
  }
  const invalid = { kind: "refused", status: 400, error: "Invalid delegation" } as const;
  const wire = DelegatedDeliveryEnvelopeSchema.safeParse(input.payload);
  if (!wire.success) return invalid;
  const { id, taskId, parent_request_id: parentRequestId, from, delegation } = wire.data;
  if (taskId !== undefined && taskId !== id) return invalid;
  if (input.idempotencyKeys.some((key) => key !== undefined && key !== id)) return invalid;
  const stored = RunDelegationSchema.safeParse({
    version: 1,
    requestId: id,
    parentRequestId: parentRequestId ?? null,
    actor: delegation.actor,
    delegate: delegation.delegate,
    label: from ?? `${delegation.actor} via ${delegation.delegate}`,
    grantId: delegation.grant_id,
    clientId: delegation.oauth_client_id,
    scopes: delegation.effective_scopes,
    mayStartWork: delegation.may_start_work,
    hop: 0,
    verifiedAt: input.now.toISOString(),
  });
  if (!stored.success) return invalid;
  return { kind: "verified", delegation: stored.data };
}
