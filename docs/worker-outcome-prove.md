# Prove one routine after the worker fix

**Live activation requires the captain's explicit word, the fix merged, the
schema migration applied, and the fixed worker image rebuilt and deployed.**
This checklist does not authorize those actions. Do not activate routines,
change bot configuration from chat, or pause a Grokbot twin while preparing it.

## Before activation

1. Confirm the deployed worker revision contains the fix and migration
   `20260912130000_bot_outcome_retry_budget`. Confirm the worker reports ready.
2. Select exactly one inactive scheduled routine through the authenticated
   `routines.list` RPC with `{ botId: "<selected-bot-id>" }` in its workspace.
   Record its ID, bot ID, `active`, `crons`, `timezone`, `nextRunAt`, and
   `lastRunAt` in a private operator receipt. Verify the bot's existing model
   connection and required capabilities are usable. Do not edit its description
   or instructions.
3. Inspect the existing prompt and schedule. Choose a routine whose scheduled
   work is approved and whose next interval leaves time to pause after one fire.
   Select one with no event triggers enabled, so activation cannot also start
   unscheduled work.
   Check eligibility against [Scheduling](routines.md#scheduling); an event-only
   routine will not prove scheduled activation. If arming an existing one-shot,
   obtain approval for its `runAt`. Do not change the prompt or schedule
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
2. At `nextRunAt`, observe the [scheduled fire](routines.md#scheduling).
   Identify the run by the selected `routineId`, `trigger: "routine"`, and
   activation time. Record its ID, actual `threadId`, and scheduled instant;
   `routines.list` does not expose the target thread. Verify exactly one run for
   that fire and an advanced `lastRunAt`.
3. As soon as that first run exists, call `routines.update` with
   `{ routineId: "<selected-routine-id>", active: false }`. Verify
   `active: false` and `nextRunAt: null`. This cancels the next scheduled wake
   while allowing the already-created run to finish.
4. Follow the run to a terminal state and verify the expected output in its
   thread. If it delegated, follow each resulting `trigger: "bot_message"` run
   too. An automatic return uses nonce
   `bot-message:auto-outcome:<delegated-run-id>` in the requester's thread.
   Confirm a single return and recipient wake, and `botOutcomeReturnedAt` with
   `botOutcomeFailedAt: null` on the delegated run. The sender echo has nonce
   `bot-message-outbound:auto-outcome:<delegated-run-id>`. Explicit results and
   intentionally skipped returns also set the returned timestamp; it alone is
   not proof of successful delivery.
5. Require zero outcome-reconciliation errors for at least 15 minutes under
   representative load, or after a deliberately completed `bot_message` run
   approved for this check. Check the receipt fields below and verify zero
   completed/failed `bot_message` runs with `botOutcomeReturnedAt: null`.
   Require no skipped failure for the proved delegation and continued worker
   dispatch. A quiet worker after manually clearing a backlog is not a pass.
   A skipped failure proves containment, not successful delivery. Keep every
   other routine and every Grokbot twin unchanged; any
   subsequent twin pause is a separate decision after this proof succeeds.

## Receipts and rollback

The durable receipt is the run row, identified in logs as
`bot-outcome:<run-id>`. A read-only inspection for the delegated run is:

```sql
SELECT id, status, "botOutcomeReturnedAt", "botOutcomeAttempts",
       "botOutcomeNextAttemptAt", "botOutcomeFailedAt", "botOutcomeError"
FROM runs WHERE id = '<delegated-run-id>';
```

The executor makes its initial return attempt. Recovery is implemented in
[`bot-outcome-reconciliation.ts`](../packages/adapters/src/bot-outcome-reconciliation.ts)
and uses the existing `run.continue` queue, with at most three persisted recovery
attempts, delayed 30 then 60 seconds after retryable failures. A `P2002` without a matching
inbound or outbound delivery nonce is permanently skipped on its first recovery
attempt; a sequence clash is not assumed to prove prior delivery. Each claim
has a five-minute recovery lease; a crash consumes that attempt. Automatic
outcome delivery commits its messages and success marker in one transaction.
A late commit clears a failure marker written by exhaustion; exhaustion cannot
overwrite an already committed success. For existing deliveries without a
success marker, recovery checks committed receipts and repairs the marker
without another delivery attempt. The inbound
nonce remains discoverable within the run's workspace and user after sender
history clearing removes the source message and outbound receipt. Committed
explicit results to the requesting bot use the same success check as normal
outcome handling. Missing sources and incoming status, result, or FYI messages
require no reply and are marked handled during recovery. This also recovers a
final-attempt delivery whose completion-marker update failed. The reconciler
only enqueues due outcomes; the queue handler performs delivery. This repairs
missed wakes even after the API's in-memory queue is replaced, without an event
dependency on the reconciler or a reset of the budget. Transaction conflicts
still use the existing bounded transaction retry inside message delivery.
Only the first recovery failure writes a diagnostic code and emits the
untruncated structured error receipt,
including Prisma code and metadata, through the logger's normal secret
redaction. The database stores only the code. A skipped failure sets both
`botOutcomeFailedAt` and `botOutcomeReturnedAt`, preserving the original run
status and closing the pending-outcome scan. Successful delivery clears the
failed marker. Do not clear these fields to retry indefinitely.

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
ticks, with no terminal marker or budget. Recovery now skips that permanent
conflict once with a diagnostic receipt. Other failures stop after three
attempts, including across restarts, while routine wakeups continue.

A separate regression reproduces the foreign-key failure from a deleted request
message whose ID remains in a peer message's JSON return address. The fix checks
and locks a surviving parent in the destination thread; otherwise it delivers
without a reply link. Both inbound and outbound messages now have stable
`(threadId, clientNonce)` receipts. Either surviving receipt prevents replay
from duplicating the recipient wake; an unmatched sequence conflict is skipped
with an explicit failure marker rather than represented as successful delivery.
Final-attempt regressions cover a crash after commit, either surviving delivery
receipt after history clearing, automatic and explicit completion-marker
failures, receipt ownership, and an unmatched conflict that rolls back the
outbound receipt. Deterministic races cover delivery committing before and
after exhaustion, including a worker crash immediately after commit. Further
regressions cover transaction rollback, no-reply marker failures, and recovery
after an API in-memory queue restart discards a delayed wake. Recovery preserves
the three-attempt budget in each case.

The initial filing contained no Prisma code or constraint. Its follow-up
identifies `P2002` on `(threadId, seq)` in the outbound create, matching the
offline reproduction. The cause of the counter/row mismatch was not supplied;
no live database or container access was used to investigate it. The fix does
not rewrite counters or direct-message rows. This path writes `Message`, not
`DirectMessage`, and its message input has no workspace field.
