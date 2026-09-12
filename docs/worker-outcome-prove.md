# Prove one routine after the worker fix

**Live activation requires the captain's explicit word, the fix merged, the
schema migration applied, and the fixed worker image rebuilt and deployed.**
This checklist does not authorize those actions. Do not activate routines,
change bot configuration from chat, or pause a Grokbot twin while preparing it.

## Before activation

1. Confirm the deployed worker revision contains the fix and migration
   `20260912130000_bot_outcome_retry_budget`. Confirm the worker reports ready.
2. Select exactly one inactive scheduled routine through the authenticated
   `routines.list` RPC in its workspace. Record its ID, bot ID, target thread,
   `active`, `crons`, `timezone`, `nextRunAt`, and `lastRunAt` in a private
   operator receipt. Verify the bot's existing model connection and required
   capabilities are usable. Do not edit its description or instructions.
3. Inspect the existing prompt and schedule. Choose a routine whose scheduled
   work is approved and whose next interval leaves time to pause after one fire.
   An event-only routine (`crons: []`) will not prove scheduled activation.
   An unarmed one-shot needs an explicitly approved future `runAt`; an already
   consumed one-shot cannot be reactivated. Do not change the prompt or schedule
   to manufacture a pass. If the selected prompt never delegates to a peer, its
   successful run proves scheduling only; record that outcome delivery remains
   unexercised instead of claiming that path passed.

## Activate, observe, and pause

1. After approval, call `routines.update` with
   `{ routineId: "<selected-routine-id>", active: true }` in the selected
   workspace. For an unarmed one-shot, also pass its approved `runAt` ISO instant.
   Verify the response has `active: true` and a future `nextRunAt`. Use this RPC
   rather than a SQL flag update: it calculates the next time and enqueues the
   wakeup. Do not use `routines.testRun`; that bypasses activation and scheduling.
2. At `nextRunAt`, `routine.wakeup` checks the active flag and scheduled instant,
   atomically claims that fire, and creates a task plus a run with
   `trigger: "routine"` and the selected `routineId`. It queues `run.continue`
   and emits `routine.fired` (the event is best effort; the run is authoritative).
   Record that run ID and scheduled instant. Verify exactly one run for that
   fire, an advanced `lastRunAt`, and the expected output in the target thread.
3. As soon as that first run exists, call `routines.update` with
   `{ routineId: "<selected-routine-id>", active: false }`. Verify
   `active: false` and `nextRunAt: null`. This cancels the next scheduled wake
   while allowing the already-created run to finish. One-shots pause themselves.
4. Follow the run to a terminal state. If it delegated, follow each resulting
   `trigger: "bot_message"` run too. An automatic return uses nonce
   `bot-message:auto-outcome:<delegated-run-id>` in the requester's thread.
   Confirm a single return and recipient wake, and `botOutcomeReturnedAt` on
   the delegated run. Explicit results and intentionally skipped returns also
   set this timestamp without creating an automatic return.
5. Observe the worker for at least two reconciliation intervals after completion
   (30 seconds each by default), and check the receipt fields below. Require no
   repeated create-error flood, no dead-letter for the proved delegation, and
   continued worker dispatch. A dead-letter proves containment, not successful
   delivery. Keep every other routine and every Grokbot twin unchanged; any
   subsequent twin pause is a separate decision after this proof succeeds.

## Receipts and rollback

The durable receipt is the run row, identified in logs as
`bot-outcome:<run-id>`. A read-only inspection for the delegated run is:

```sql
SELECT id, status, "botOutcomeReturnedAt", "botOutcomeAttempts",
       "botOutcomeNextAttemptAt", "botOutcomeFailedAt", "botOutcomeError"
FROM runs WHERE id = '<delegated-run-id>';
```

The executor makes its initial return attempt. Recovery uses the existing
`run.continue` queue, with at most three persisted recovery attempts, delayed
30 then 60 seconds after failures. Each claim has a five-minute recovery lease;
a crash consumes that attempt. The reconciler repairs missed queue wakes, but
cannot reset the budget. Transaction conflicts still use the existing bounded
transaction retry inside message delivery. Only the first recovery failure
writes a diagnostic code and emits a receipt log; query dumps and peer content
are not stored in it. `botOutcomeFailedAt` is the dead-letter marker, distinct
from a successful `botOutcomeReturnedAt`; it preserves the original run status.
Do not clear these fields to retry indefinitely.

On any unexpected behavior, pause the selected routine through the same RPC and
verify the paused state. Pausing does not cancel an in-flight run or reverse its
external actions. If needed, use the existing thread Stop control with separate
authorization for the affected active run. Preserve run IDs, timestamps, deployed
revision, and receipt fields privately for diagnosis. Do not activate another
routine as a workaround or pause the Grokbot twin.

## Offline diagnostic evidence

`packages/adapters/src/bot-messages.test.ts` drives real outcome delivery with a
fake database enforcing representative message-create failures. Before the fix,
a persistent `(threadId, seq)` conflict caused ten inserts in ten reconciliation
ticks, with no terminal marker or budget. Recovery now stops at three attempts,
including across reconciler restarts, while routine wakeups continue.

A separate regression reproduces the foreign-key failure from a deleted request
message whose ID remains in a peer message's JSON return address. The fix checks
and locks a surviving parent in the destination thread; otherwise it delivers
without a reply link. The existing delivery-key replay handles duplicate
`(threadId, clientNonce)` outcomes without duplicating the recipient wake.

The incident filing contained no Prisma code or constraint, so these tests do
not identify which constraint failed in the live incident. The bounded-loop
cause is established; the initiating live create failure remains unconfirmed.
No live database or container access was used. Sequence-counter drift is not
silently repaired, and direct-message rows are not rewritten: this path writes
`Message`, not `DirectMessage`, and its message input has no workspace field.
