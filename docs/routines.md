# Routines

A routine is a saved prompt that a bot runs on a schedule. Routines belong to a
single bot inside a workspace and are managed through the `routines` RPC
namespace (`list`, `create`, `update`, `remove`, `testRun`).

## Shape

The `Routine` model (`packages/db/prisma/schema.prisma`) stores:

| Field | Notes |
| --- | --- |
| `name` | 1–80 characters. |
| `prompt` | Sent to the bot verbatim when the routine fires. |
| `cron` | Standard 5-field cron expression. Stored as given; not validated on write. |
| `timezone` | IANA zone the cron is evaluated in. Defaults to `UTC`. |
| `active` | Defaults to `false`. A routine only fires while this is `true`. |
| `notify` | Defaults to `true`. See [Notifications](#notifications) — currently inert. |
| `lastRunAt` / `nextRunAt` | Maintained by the scheduler; `nextRunAt` is `null` while paused. |

## Scheduling

Creating or updating an *active* routine computes `nextRunAt` from the cron
expression and enqueues a `routine.wakeup` job. `wakeRoutine`
(`packages/adapters/src/executor.ts`) re-reads the row when the job fires and
returns immediately unless the routine is still `active` and `nextRunAt` still
matches the scheduled instant. It then creates a task and a run with
`trigger: "routine"`, appends a `routine.fired` thread event, and enqueues the
next wakeup.

A paused routine is inert at two levels: no wakeup job is enqueued while
`active` is `false`, and a stray wakeup job would no-op on the `active` check.
Pausing an active routine cancels its pending wakeup job.

`routines.testRun` bypasses the schedule and runs the routine's prompt
immediately. It is a real run against the bot — it is not a dry run, and it is
not gated by `active`.

## Notifications

`Routine.notify` is persisted and round-tripped through the API, but **no code
path reads it**. Push notifications for a routine-triggered run are decided
entirely by the bot:

- Completion and failure pushes are gated by `Bot.notifyOnFinish`.
- `help` and `takeover` pushes (the agent needs an answer, or needs the user on
  the screen) are **not gated at all** and fire regardless.

Setting `notify: false` on a routine therefore does not keep a firing routine
quiet. To silence a bot's routine runs today, set `notifyOnFinish: false` on the
bot — and note that even then, a run that asks for help or requests a takeover
still pushes.

## Event triggers are not supported

Routines are cron-only. `Routine` and `CreateRoutineInput` have no field for an
event source, and there is no Slack, GitHub, or webhook listener that can start
a routine run. A routine that should react to an external event has no
representation in this model; approximating one with a polling cron changes its
contract (it fires on a clock rather than on the event, and it cannot see the
triggering payload).
