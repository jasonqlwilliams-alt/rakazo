# Routines

A routine is a saved prompt that a bot runs on a schedule or a configured event.
Routines belong to a single bot inside a workspace and are managed through the
`routines` RPC namespace (`list`, `create`, `update`, `remove`, `testRun`).

For a gated live smoke check, follow [Prove one routine after the worker fix](worker-outcome-prove.md).

## Shape

The authoritative stored fields are in the `Routine` model in
[`schema.prisma`](../packages/db/prisma/schema.prisma). API fields and defaults
are defined by `RoutineSchema` and `CreateRoutineInput` in
[`domain.ts`](../packages/contracts/src/domain.ts), with update inputs in
[`rpc.ts`](../packages/contracts/src/rpc.ts).

## Scheduling

Recurring schedules use `crons`, an array of five-field expressions evaluated
in the routine's timezone. Writes validate recurring expressions even while
paused. Activating a recurring routine or changing its active schedule computes
the earliest `nextRunAt` across its expressions and enqueues a `routine.wakeup` job.

A one-shot uses `crons: ["@once"]` and cannot be mixed with recurring expressions.
Activating an existing, unarmed one-shot through `routines.update` requires a
future `runAt` ISO instant. A consumed one-shot cannot be reactivated. It pauses
itself when claimed, clearing `nextRunAt`. An event-only routine has no scheduled
wakeup; see [Event triggers](#event-triggers).

`wakeRoutine` in [`executor.ts`](../packages/adapters/src/executor.ts)
re-reads the row when the job fires and returns immediately unless the routine
is still `active` and `nextRunAt` still matches the scheduled instant.
It atomically claims the fire and creates a task
and a run with `trigger: "routine"` and the routine's ID, then queues
`run.continue`. The `routine.fired` thread event is best effort; the run is the
authoritative record. Recurring schedules enqueue their next wakeup. The saved
prompt expands skill references before execution.

A paused routine is inert at two levels: no wakeup job is enqueued while
`active` is `false`, and a stray wakeup job would no-op on the `active` check.
Pausing an active routine cancels its pending wakeup job.

`routines.testRun` bypasses the schedule and runs the routine's prompt
immediately. It is a real run against the bot — it is not a dry run, and it is
not gated by `active`.

## Notifications

`Routine.notify` is persisted and round-tripped through the API, but does not
control push delivery. Routine runs follow the run notification policy:

- A `trigger: "routine"` run (a scheduled fire or `routines.testRun`) with no
  user interaction shows only its final answer or a message it sends on purpose
  with `message_user`. Text the model writes before a tool call is not posted as
  a chat message, and the run's instructions tell the model to put any report
  after its last tool call instead of asking for progress updates. A
  `message_user` call still posts and marks the chat unread.
- Such a run that ends without a final answer, or with only whitespace, posts
  no bubble, does not mark the chat unread, and does not send a completion
  push. A run that ends with a final answer still posts it, marks unread, and
  can send a completion push.
- If the model stops right after a tool result, such a run asks it once to
  continue and still lets it end without a message. Chat, group-channel,
  bot-message, and event-delivery (`trigger: "webhook"`) runs keep their own
  retries and fallback reply.
- Any user interaction on a routine run turns these rules off for the rest of
  that run: a message the user sends while it runs, an answer to its question,
  input, or approval request, or a takeover hand-back.
- Completion and failure pushes in the bot's own chat are gated by
  `Bot.notifyOnFinish`; group threads enable them regardless of that flag.
- `help` and `takeover` pushes (the agent needs an answer, or needs the user on
  the screen) are **not gated at all** and fire regardless.

Setting `notify: false` on a routine therefore does not keep a firing routine
quiet. Setting `notifyOnFinish: false` on the bot suppresses completion and
failure pushes in its own chat. Group runs and requests for help or takeover
can still push. Completion and failure gating lives in `runNotificationsEnabled`;
`notifyRun` bypasses that preference for `help` and `takeover` (see
[`executor.ts`](../packages/adapters/src/executor.ts)).

## Event triggers

Active routines can also receive authenticated webhook events, signed GitHub
events, or messages from a configured messaging provider. Event-only routines
use `crons: []` with at least one event trigger enabled; they keep
`nextRunAt: null` even while active. Event delivery includes the triggering
payload with the routine prompt. A polling cron does not substitute for this
event context.

The inbound payload stays fenced as untrusted delivery data, not instructions.

A webhook `200` means the delivery was accepted and its run queued, not that the
run succeeded. A caller that needs the outcome can add `?wait=<seconds>` (at most
60): the response is `200` once the run completes, `502` with the failure when it
fails or is cancelled, and `202` with the current `status` when the wait ends or
the run needs the owner. With the same bearer, `GET
/api/v1/bots/:botId/webhook/runs/:runId` reads a run's `status` and failure
`error` later.

Webhook-triggered runs may inspect state unattended, but side effects need
the owner's approval. A routine owner can opt a webhook-enabled routine in to
run named tools unattended by setting `unattendedTools` to an explicit
allowlist of known tool names through `routines.create` or `routines.update`.
An empty list, any other trigger, and any tool not on the list keep that
default.

Authentication and dispatch are implemented in
[`webhook.ts`](../apps/api/src/webhook.ts),
[`github-webhook.ts`](../apps/api/src/github-webhook.ts), and
[`messaging-inbound.ts`](../apps/api/src/messaging-inbound.ts).
