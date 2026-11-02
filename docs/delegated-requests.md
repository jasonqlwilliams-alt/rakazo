# Delegated requests

A delegated request is work an owner's delegate asks a bot to do: an assistant that acts for
the owner through a delegation gateway. It reaches the bot through the bot's webhook like any
delivery, with a delegation context the gateway signs. Rakazo verifies the signature, stores the
context on the run, and enforces it in server code on every agent hop. The run's instructions
describe the limits, but the tool gate decides what runs.

Code: [`delegated-request.ts`](../apps/api/src/delegated-request.ts) (verification),
[`delegation.ts`](../packages/core/src/delegation.ts) (tool rules), and the tool gate in
[`executor.ts`](../packages/adapters/src/executor.ts).

## Signature

The gateway sends two headers with the delivery and leaves the JSON body as it is:

| Header | Value |
| --- | --- |
| `x-rakazo-delegation-timestamp` | Unix seconds when it signed |
| `x-rakazo-delegation-signature` | Hex Ed25519 signature |

The signed bytes are the UTF-8 encoding of `rakazo-delegation-v1`, a newline, the timestamp, a
newline, the bot id from the webhook path, a newline, and the exact body sent. Rakazo checks the
signature with the gateway's public key, refuses a timestamp more than five minutes from its
clock, and requires the body `id` to equal the `idempotency-key` header and `taskId`.

A delivery claims a delegation when its event is `delegation.message`, it has a top-level
`delegation` or `delegation_context` field, or it carries either header.
Such a delivery is never treated as an ordinary webhook event. If it fails a check, Rakazo stores
nothing and starts no run:

| Status | Reason |
| --- | --- |
| `401` | The signature is missing, wrong, for another bot, or outside the time window. |
| `400` | The signed body has no valid delegation context, or claims a human approval. |
| `403` | No gateway public key is configured. |

## What Rakazo reads from the body

`id` (the request id), `taskId`, `parent_request_id`, `from` (the attribution, such as
"Owner via assistant"), and from `delegation`: `actor`, `delegate`, `grant_id`,
`oauth_client_id`, `effective_scopes`, `may_start_work`, and `human_approval`, which must be
`"none"`. Everything else stays in the delivered message.

## What a delegated run may do

A scope must be `<delegate>.read` or `<delegate>.message`, where `<delegate>` exactly matches
the signed context's `delegate` value. Other scope prefixes grant nothing.

| Capability | Granted by | Tools |
| --- | --- | --- |
| Reply | Always | `message_user`, `ask_user`, and the run's own answer |
| Read | The delegate's `.read` scope | History, memory recall, scratchpad and board reads, skill and schedule lists, task catalog, job status, `run_subagent`, and read-only connector tools |
| Relay | The delegate's `.message` scope | `message_bot` only |
| Work | `may_start_work: true` | Scratchpad and memory writes, plus research cancellation. Each one waits for the owner's approval. |

Administration is refused whatever the delegation grants: bot, space, and integration changes,
credentials, skills, schedules, outside agents, and the shell. Generic connector writes are
refused even when `may_start_work` is true. Work that can start another run later (`research_start`,
`ticket_create`, `ticket_update`, and `ticket_comment`) is also refused until delegation can
persist through those jobs. Every other tool, including any tool added later, is refused until it
is listed in `DELEGATED_TOOL_CAPABILITY`.

A delegated run is offered only the tools it may use. Any other call is refused with the reason
before it runs, and the bot's own grants (routine allowlists, always-allow rules) never add to
what the delegation allows.
Without the delegate's `.read` scope, prompt assembly excludes the bot's saved persona, durable
and recalled memory, scratchpad and ticket context, and earlier thread history. Only the delivered
request is supplied as task context. A webhook routine's unattended tool list never preapproves
delegated writes.

## Every hop

- `message_bot` from a delegated run, and the outcome a delegated run returns, start runs that
  carry the same delegation and request id, one hop further. Nothing widens it.
- A delegated delivery always starts its own run. It never steers another run or waits for one,
  and a delegated run never takes the owner's messages as steering.
- A run whose stored delegation is damaged fails before the model starts.

The delivered run's task id is the request id. The webhook answer and
`GET /api/v1/bots/:botId/webhook/runs/:runId` return it as `taskId`, so the gateway can tie the
run to its request.

To follow a request from bot to bot, the inbound MCP `read_thread` returns for each message its
`runId`, the `startedRunId` of a webhook delivery, and the `parentRunId` of a bot-to-bot relay:
the run that sent it, recorded by the server. Text that quotes a request id never sets a parent.

## Setup

1. Set `RAKAZO_DELEGATION_PUBLIC_KEY` on the API to the gateway's Ed25519 public key in SPKI PEM
   form. A single-line value can write its line breaks as `\n`. The gateway keeps the matching
   private key; Rakazo never needs it.
2. Restart the API. It refuses to start if the key is not an Ed25519 public key.

The gateway delivers with each bot's existing webhook bearer. While the key is unset, every
delegated request is refused with `403` and ordinary webhook deliveries are unaffected.
