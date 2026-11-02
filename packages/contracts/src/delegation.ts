import * as z from "zod";
import { IsoDate } from "./ids.js";

/** One line of text: these values reach prompts and audit lines. */
const DelegationField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, "Use one line");

/** A delegated request id doubles as its task id, so it stays a short, plain token. */
export const DelegatedRequestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "Use letters, digits, underscores or hyphens");

/**
 * A request the owner's delegate made through a delegation gateway, as the API verified it.
 *
 * It is stored on the run it started, and every run that run starts by relaying inherits it
 * with only `hop` increased, so a relay can never widen what the request may do.
 */
export const RunDelegationSchema = z.object({
  version: z.literal(1),
  /** Correlation id of the delegated request, the same on every hop. */
  requestId: DelegatedRequestId,
  /** The gateway's request that this one continues, if any. */
  parentRequestId: DelegationField.nullable(),
  actor: DelegationField,
  delegate: DelegationField,
  /** How the request is attributed, such as "Owner via assistant". */
  label: DelegationField,
  grantId: DelegationField,
  clientId: DelegationField,
  /** Granted scopes exactly as the gateway sent them, each `<namespace>.<capability>`. */
  scopes: z.array(DelegationField).max(32),
  mayStartWork: z.boolean(),
  /** Relays since delivery: 0 for the delivered run. */
  hop: z.number().int().nonnegative(),
  verifiedAt: IsoDate,
});
export type RunDelegation = z.infer<typeof RunDelegationSchema>;

/**
 * The fields of a delegation gateway's webhook delivery that this deployment reads. The
 * gateway signs the whole body; the rest of it stays in the delivered message.
 */
export const DelegatedDeliveryEnvelopeSchema = z.object({
  id: DelegatedRequestId,
  taskId: z.string().optional(),
  parent_request_id: z.string().nullish(),
  from: z.string().optional(),
  delegation: z.object({
    actor: z.string(),
    delegate: z.string(),
    grant_id: z.string(),
    oauth_client_id: z.string(),
    effective_scopes: z.array(z.string()),
    may_start_work: z.boolean(),
    // A delegated request carries no human approval and cannot claim one.
    human_approval: z.literal("none"),
  }),
});
