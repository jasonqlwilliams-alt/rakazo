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

- Completion and failure pushes in the bot's own chat are gated by
  `Bot.notifyOnFinish`; group threads enable them regardless of that flag.
- `help` and `takeover` pushes (the agent needs an answer, or needs the user on
  the screen) are **not gated at all** and fire regardless.

Setting `notify: false` on a routine therefore does not keep a firing routine
quiet. Setting `notifyOnFinish: false` on the bot suppresses completion and
failure pushes in its own chat. Group runs and requests for help or takeover
can still push. The decision is implemented by `runNotificationsEnabled` in
[`executor.ts`](../packages/adapters/src/executor.ts).

## Event triggers

Active routines can also receive authenticated webhook events, signed GitHub
events, or messages from a configured messaging provider. Event-only routines
use `crons: []` with at least one event trigger enabled; they keep
`nextRunAt: null` even while active. Event delivery includes the triggering
payload with the routine prompt. A polling cron does not substitute for this
event context.

Authentication and dispatch are implemented in
[`webhook.ts`](../apps/api/src/webhook.ts),
[`github-webhook.ts`](../apps/api/src/github-webhook.ts), and
[`messaging-inbound.ts`](../apps/api/src/messaging-inbound.ts).
