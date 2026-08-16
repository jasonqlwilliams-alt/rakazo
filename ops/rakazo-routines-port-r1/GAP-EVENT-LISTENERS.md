# GAP: event-triggered routines

Job `rakazo-routines-port-r1`. Measured against the live stack on 2026-08-16.

Two of the seventeen source routines are **event-triggered, not scheduled**.
They were not created, and no cron was invented to stand in for them.

## What the sources ask for

Both live on the QA Engineer seat and carry a `trigger` object instead of a
`schedule` string. Their unredacted trigger JSON and prompts are in the job
packet at `packet/automations/` — they are not reproduced here because this
repository is public.

| Source file | Routine name | Trigger shape |
| --- | --- | --- |
| `qa-acs-review-and-firstmate-job-watch.json` | ACS review and FirstMate job watch | `{ type: "group", listeners: [ { type: "slack", channel, match: { kind: "keyword", keyword } } × 2 ] }` |
| `qa-watch-continuum-main-ci-and-merges.json` | Watch continuum-main CI and merges | `{ type: "group", listeners: [ { type: "github", repo, events: ["ci-failed"], ciBranch }, { type: "github", repo, events: ["pr-merged"] } ] }` |

So the trigger vocabulary in use is:

- a **group** of listeners, any of which fires the routine;
- a **Slack** listener: channel + keyword match;
- a **GitHub** listener: repository + event list (`ci-failed`, `pr-merged`),
  optionally narrowed to a branch.

## What Rakazo has

Nothing that can express any of it.

`model Routine` (`packages/db/prisma/schema.prisma`) is:

```
id, workspaceId, botId, userId, name, prompt,
cron, timezone, active, notify, lastRunAt, nextRunAt
```

`CreateRoutineInput` and the `routines.update` input
(`packages/contracts/src/domain.ts`, `packages/contracts/src/rpc.ts`) expose the
same fields. There is no trigger, listener, source, or event column, and
`cron` is required (`z.string().min(1)`), so a routine cannot even be stored
without a schedule.

The only thing that starts a routine run is `routine.wakeup`, a scheduled job
keyed off `nextRunAt` (`packages/adapters/src/executor.ts`). There is no
inbound Slack or GitHub webhook route on the API, so there is no place for an
external event to enter the system and reach a bot.

## Why no cron substitute was made

The prompt for the GitHub routine opens with "A GitHub event just fired … Inspect
the triggering event." A cron cannot supply that event, so a polling copy would
be a routine whose prompt is a lie about why it woke up. The Slack routine
likewise says explicitly "This routine fires on Slack keywords … The fleet-tempo
routine covers the clock. Do not double-ping" — its whole reason to exist is
that it is *not* on the clock, and the clock is already covered by
`Fleet tempo deploy and review`, which was ported. Adding a cron for it would
create the double-ping the prompt forbids.

## What closing the gap would take

1. A trigger representation on `Routine` — minimally a nullable `trigger` JSON
   column plus making `cron` nullable, with a check that exactly one of
   `cron` / `trigger` is set.
2. Contract changes: `CreateRoutineInput` accepting `trigger`, and a discriminated
   union for the listener kinds so Slack and GitHub shapes validate.
3. Inbound webhook routes on the API with signature verification (Slack signing
   secret, GitHub HMAC), resolving a delivery to the matching routines in a
   workspace.
4. A dispatch path parallel to `wakeRoutine` that creates the task/run with
   `trigger: "event"` and makes the triggering payload visible to the prompt —
   otherwise a fired routine still cannot "inspect the triggering event".
5. Deduplication, since both providers retry deliveries and both source routines
   say to stay quiet on a duplicate.

Until that exists, these two remain on their original host.
