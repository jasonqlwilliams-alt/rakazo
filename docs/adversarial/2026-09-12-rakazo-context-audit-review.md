# Thor-class adversarial review — seat-context audit (redacted)

- Date: 2026-09-12
- Reviewer: judgment-plane adversarial seat (this run). Private SoT remains authoritative. This file is judgment only.
- Scope: falsify audit findings A–E and the five-item correction packet. Named seats, live titles, operator identity, quota figures, and private object IDs stay in the private vault/SoT packet — not in this public tree.
- Non-actions (honored): no live `bots` Save, no merge to `main`, no deploy, no production config edit, no fleet seat copy landed here.

Stamps used: **SOUND** (reproduced or independently corroborated), **THIN** (plausible, unfalsified, insufficient artifact), **WRONG** (contradicted by evidence).

Placeholders used below: **Seat-Chair**, **Seat-Alpha**, **Seat-Bravo**, **Seat-Charlie** (four named seats in the private packet). **Old-Title-A/B/C/D** (retired titles the audit claimed were still live). **Bulk-CLI** (large-sweep research CLI, invoked from seat hands). **Apply-GW** (authorized apply gateway). **SoT** (private source of truth). **Judgment plane** vs **seat plane** (dual-run: judgment/routing vs seat computers).

## Method and evidence inventory

Attempted independent close of the SoT loop. It did not close.

| Channel | Result |
|---|---|
| Private SoT MCP | Discovery failed. Tools unavailable. Cannot read SoT, cannot confirm judgment-plane seat-kill text, cannot confirm the dual-run apply packet. |
| GitHub MCP | Discovery failed. |
| This public product repo | Zero matches for the private fleet names, retired titles, apply-gateway, dual-run packet, bulk-CLI, or TPM governor. No `docs/adversarial/` prior to this file. No fleet seed. |
| Connected knowledge workspace | No pages titled as the audit seat / fleet / dual-run apply packet. One SoT-authority SOP exists as a one-line stub (body empty). Older project notes mention a human code-gen CLI from early 2026 — not tonight's fleet order. No workspace or object IDs recorded here. |
| Chat workspace search | No hits for the audit-seat + product pair, retired-title queries, or quota/TPM incident strings in the searched window. |
| Cloud-agent list | This review run only. No sibling audit transcript in-environment. |
| Live product DB | Not queried. Dual-run + this brief forbid live Save from chat; a read-dump was also not provided. |

Operator-authoritative inputs accepted as *inputs*, not as reproduced facts:

1. Dual-run law (judgment plane = judgment/routing; seat plane = computers/adapters; push not pull; no live Save from chat; seat text travels SoT → audit seat → staging → Apply-GW → private vault/git → product).
2. Tonight's operator order: provider TPM/quota retry belongs *inside the seat plane*; large sweeps/research → Bulk-CLI from seat hands; the audit seat audits, then this review.

What this public repo *does* prove about the product (used below to falsify field, layer, and retry claims):

- `bots` has four identity columns: `name`, `title`, `description`, `instructions` (`packages/db/prisma/schema.prisma`).
- Runtime system prompt prefers `bot.instructions`. Title/description are fallback only when instructions are empty (`packages/adapters/src/executor.ts`).
- Web create/save and mobile create copy Description → `instructions` (`apps/web/src/pages/Shell.tsx`, `apps/mobile/app/new.tsx`). Title is a separate UI field.
- Durable context also includes `MEMORY.md`, user memory, and optional memory-provider recall. Thread history stays in the prompt until compact/clear.
- `spawn_bot` creates a lasting child (own thread, computer, memory). `run_subagent` is in-turn only, gated at `MAX_PARALLEL_SUBAGENTS = 4`. Executor already says never use both for the same request.
- No model-call 429 / TPM / Retry-After path exists in `pi-runtime` or the executor. `UsageRecord` is an append-only ledger, not a governor. Background jobs are `run.continue`, `routine.wakeup`, `computer.sleep`, `computer.control-expire`, `history.compact` only.
- Voice HTTP is the only 429 handler, and it returns a user string — it does not retry.

## 1. Verdicts on findings A–E

### A. Live `bots` table still carries Old-Title-A/B/C/D on Seat-Chair / Seat-Alpha / Seat-Bravo / Seat-Charlie — HIGH

**Stamp: THIN**

Why it does not go SOUND:

- No redacted `bots` row dump (id hashes / name / title / description / instructions prefixes, `updatedAt`). SoT and chat search are empty. This reviewer cannot see the live table and must not open a Save path to "check."
- The audit inspected **title**. That is the wrong primary field for "wrong context." Behavioral identity is `instructions` first. If instructions are already populated (the web/mobile Save path writes Description into instructions), a stale title is cosmetic. A title-only HIGH finding can be a false positive.
- The inverse is also unclosed: if instructions are empty, title+description *are* the system prompt, so title drift would be behavioral. The audit did not say which branch they observed.
- "Judgment plane already updated; seat-plane apply pending Apply-GW" is operator narrative. Judgment-plane text is not in this repo. SoT MCP could not confirm the seat-kill packet.

Why it does not go WRONG:

- Dual-run law plus "judgment-plane seat kills already applied, seat-plane apply pending" make *some* product lag expected. The product stores seat text in Postgres, not in this git tree. Drift between judgment-plane files and live `bots` is a real class of bug.
- Four named seats matching four retired titles is specific enough that wholesale invention is unlikely — but specificity without a dump is still not reproduction.

Falsifier the audit must attach before this becomes SOUND: an Apply-GW-exported, redacted four-row table showing `title` *and* `instructions` (and `description`) for those seats, plus SoT hashes for the intended text. Keep that dump in the private vault, not here.

### B. Seat-Chair fan-out entity sweeps → twin-captain smell + mass 429s — HIGH

**Stamp: THIN**

The finding bundles two claims. Split them.

**Twin-captain (governance).** SOUND as *law*, THIN as *tonight's incident*. Dual-run forbids a second captain. This repo has no judgment plane, no audit seat, no entity-sweep router. Twin-captain cannot be proven from product code. No session IDs, no spawn keys, no child-bot list for the named entities in the private packet. Chat search empty. SoT down.

**Mass 429 amplification (product).** SOUND as *mechanism*, THIN as *attribution to Seat-Chair tonight*. The product will happily amplify parallel provider spend:

- `run_subagent` admits four nested agents at once.
- `spawn_bot` creates lasting bots that enqueue their own `run.continue` jobs (another quota multiplier, and they persist after the parent turn).
- Team computers can run distinct screens in parallel (landed behavior, not a bug).
- There is no fleet-wide sweep governor and no TPM backoff.

That architecture makes "entity sweep fan-out → 429 storm" easy. It does not prove the seat-plane chair did it tonight, nor that the judgment-plane chair and the seat-plane chair were both captaining. 429s can also come from Bulk-CLI, other seats, a gateway-wrapped provider, or a single fat prompt.

Do not treat "smell" as a closed incident. Require (private vault): parent run id, child spawn keys, `usage_records` rows (provider/model/tokens/timestamps), and the 429 payload (which product surface).

### C. Misread Bulk-CLI order as "have the judgment-plane bots use the bulk CLI" — inverted — MED-HIGH

**Stamp: THIN** (as a misread finding). The *routing correction* is SOUND given tonight's operator order + dual-run law.

Why THIN:

- No source utterance, session, or PR that actually said the inverted sentence. Chat search and this repo are silent. Older knowledge-workspace notes of a human using a code-gen CLI (early 2026) are a real inversion *attractor*, not proof of tonight's misread.
- This repo contains zero bulk-CLI / research-CLI delegation code. There is nothing here to invert. The misread, if it happened, lived in judgment-plane / SoT routing text this reviewer cannot see.

Why the correction still stands (see packet item 3): the operator ordered large sweeps/research → Bulk-CLI *from seat hands*. Dual-run keeps the judgment plane on judgment. "Judgment-plane bots run Bulk-CLI" is the forbidden inversion whether or not the audit can produce the guilty sentence. Stamp the *finding* THIN; do not wait to rewrite the routing table (in SoT, not here).

### D. Provider 429 on delegated sweeps; chat-level ~1-min retry still failed — Confirmed

**Stamp: SOUND**

Tonight's operator report is accepted as the incident: provider TPM/quota stoppage, retry about one minute later, retry belongs inside the seat plane, chat-level retry failed. That is enough to stamp the *layer* claim.

Independent product corroboration (this repo, current `main`):

- No LLM 429 / TPM retry in `packages/adapters/src/pi-runtime.ts` or `executor.ts`. A quota error becomes `agent.state.errorMessage` and is sanitized into the thread. The run does not sleep, does not honor Retry-After, and does not single-flight siblings.
- `UsageRecord` writes tokens after the fact. Nothing reads them to shed load.
- Background jobs have no quota handler. Chat saying "wait a minute and try again" is therefore the only retry that existed — and it is the wrong layer.
- A one-minute retry of the *same* parallel fan-out is expected to fail again: TPM stoppage is a bucket, not a blip. Parallel sibling retries from chat make it worse.

Caveat that stays THIN (does not downgrade the stamp): this reviewer did not see the 429 body, request id, or which delegated sweep. Attribution to "delegated sweeps" specifically is operator/audit narrative. The code still proves chat-level minute-scale retry cannot be the fix.

### E. Self-graded "SOUND pockets": entity bots claim-safer; one org noted vault unreachable

**Stamp: THIN**

The audit grading its own remainder as SOUND is not a finding. It is a request to stop looking.

- "Entity bots claim-safer" — no claim logs, no chat hits, no SoT objects, no before/after claim text. Unfalsifiable praise. Leave those seats alone (see over-correction), but do not stamp them SOUND.
- "Org noted vault unreachable" — SoT MCP is down *in this review*, so vault/SoT unreachability is a live fact tonight. Attribution to that org, and the implication that the rest of the audit is therefore reliable, is unproven. A down SoT is a reason to *widen* doubt, not to bless pockets.

## 2. Correction packet

**Verdict: approve-with-edits**

Do not reject the direction. Do not approve as written. The packet mixes three SOUND moves with two that recreate the failure (title-only apply; minute-scale re-fan-out "quota job") and one that violates dual-run if implemented as a seat-plane cron pull.

### Item 1 — Land the dual-run seat-description apply via vault/git (no live Save)

**Approve the path. Edit the payload.**

Required edits:

1. Apply `instructions` and `description`, not `title` alone. Runtime reads instructions first. Web/mobile Save aliases Description → instructions. Title-only is a likely no-op for model behavior and leaves Old-Title-A/B/C/D in the prompt if those strings live in instructions.
2. Do not land production seat copy in this public product repo (`AGENTS.md`). Seat text belongs in the private vault/git hop, then Apply-GW → product `bots.update` from an authorized operator path — not a chat Save, not a PR here.
3. Attach the redacted four-row before/after proof named in finding A (private vault). No dump, no apply.
4. After apply, treat memory and history as separate residue: `MEMORY.md`, user memory, memory-provider recall, and in-thread old identity are not updated by `bots.update`.

### Item 2 — Fence the seat-plane chair: no twin-captain / no simultaneous fleet entity sweeps without a judgment-plane brief

**Approve the intent. Edit the mechanism.**

Required edits:

1. This is a judgment-plane routing rule (push a brief, or do not sweep). It is not a product fence and must not disable `spawn_bot` / `run_subagent` / Team parallel screens globally.
2. "Without judgment-plane brief" must not become the seat-plane chair polling the judgment plane or SoT. Push, not pull. No CLI→bot messaging MCP.
3. Distinguish three tools: `run_subagent` (in-turn, max 4), `spawn_bot` (lasting fleet children — worse if used for a sweep), Bulk-CLI from the seat computer (tonight's bulk path). The fence is "no simultaneous *fleet entity* sweeps," not "the chair seat may not use a computer."
4. Do not overwrite the seat-plane chair's instructions from chat to "install the fence." Same vault/git path as item 1, or judgment-plane-only policy.

### Item 3 — Rewrite Bulk-CLI routing: seat plane → Bulk-CLI for bulk; judgment plane stays judgment

**Approve.** This matches tonight's operator order and dual-run. Finding C being THIN does not block it.

Required edits:

1. Write the rewrite in SoT / judgment-plane routing, not in this public repo (there is no Bulk-CLI adapter here to change).
2. Bulk-CLI is invoked from seat *hands* (seat computer / CLI), not by the judgment plane, and not by a new CLI→bot messaging MCP.
3. Do not send judgment, chair work, or Apply-GW duty to Bulk-CLI.
4. Note: Bulk-CLI can still burn the same provider TPM bucket. Routing bulk *off* chat does not by itself stop 429s (see item 4).

### Item 4 — Code-level quota retry Apply-GW job; stop parallel chat retries

**Approve "stop chat retries" and "retry lives in the seat plane." Reject the job shape as implied.**

Required edits:

1. Stop parallel chat-level retries immediately (judgment-plane policy). SOUND. Do not wait for a code ship.
2. Do **not** add a Graphile / Apply-GW job that waits ~60s and re-dispatches the same N-way sweep. That is the failed chat retry with a longer name. `UsageRecord` and the current job list prove there is no existing governor to hang that on.
3. If/when code ships (separate Apply-GW job, not tonight's chat, not this PR): detect 429/TPM in the runtime; honor Retry-After; exponential backoff with jitter; **single-flight** the seat; **collapse concurrency** (shed `run_subagent` / refuse additional `spawn_bot` while the bucket is hot); do not retry an identical fan-out. One minute is the operator's *floor*, not a complete policy for a large TPM stoppage.
4. Do not implement that runtime change in this review PR. Do not live-Save a routine that "retries every minute."

### Item 5 — Standing audit-seat job vs SoT

**Approve only as a judgment-plane audit-seat pass. Reject as a seat-plane cron that pulls SoT or scrapes live `bots`.**

Required edits:

1. Dual-run: push, not pull; no twin captains. A standing seat-plane job that polls SoT or the live table is a second captain with a schedule.
2. SoT MCP is down *now*. A standing job launched tonight would fail closed or invent drift. Do not create it until SoT is reachable and the first apply (item 1) has a dump.
3. After SoT is up: the judgment-plane audit seat compares SoT-pushed seat text to an Apply-GW-exported redacted snapshot. Trigger is a staging/Apply-GW push or a judgment-plane cadence — not the seat plane waking itself to "check SoT."

## 3. Blind spots the audit missed

1. **Four fields, one glance.** `name` / `title` / `description` / `instructions` are independent. Web/mobile alias Description → instructions on Save. Onboarding can write a third instructions string from Q&A. Auditing title only can both over-alarm and miss the real stale prompt.
2. **Residue after a clean `bots.update`.** `MEMORY.md`, user-scoped memory, memory-provider recall, and thread history will still teach the old identity until separately cleared or compacted. Child bots spawned under the old parent keep their own instructions and memory.
3. **No incident artifacts.** No run ids, spawn keys, 429 request ids, `usage_records` slice, SoT object ids. The audit is unreproducible. This review could not get them from SoT, chat, the knowledge workspace, or GitHub.
4. **429 source ambiguity.** Direct provider vs gateway-wrapped vs Bulk-CLI vs other seats vs voice. Item 3 (move bulk to Bulk-CLI) can *concentrate* spend on the same TPM cap.
5. **Public vs private git.** This repo must not receive production seat text. "Land via vault/git" if misread as "open a product PR with the seat packet" leaks fleet context.
6. **Product features mistaken for audit-seat bugs.** `MAX_PARALLEL_SUBAGENTS = 4`, `spawn_bot`, and Team parallel screens are intended. The bug is ungoverned fleet entity sweeps, not the tools existing.
7. **Surfaces.** Web, Electron (hosts web), and mobile share `bots.update`. Apply once via the API. Do not "fix" one client.
8. **SoT was dark.** SoT MCP failed discovery. The knowledge-workspace SoT-authority SOP is an empty stub. A standing audit job against that SoT would be theater.
9. **`UsageRecord` is not a brake.** Tokens are logged; nothing gates on them. A quota job that only *records* more usage does nothing.
10. **Claim-safer entity bots** were not evidenced. They may still be running under a parent whose instructions still carry Old-Title-A.

## 4. Danger of over-correcting — do not change

- Live product Save from chat, merge to `main`, or deploy from this review.
- Production seat copy, live bot ids, workspace ids, credentials, operator names, quota figures, or private object IDs in this public repo.
- Title-only apply that leaves `instructions` / `description` / memory / history stale — or a wipe of instructions that drops a good seat.
- Global disable or schema collapse of `spawn_bot`, `run_subagent`, Team parallel screens, or `title`/`description`/`instructions`.
- Moving judgment, chair work, or Apply-GW duty onto Bulk-CLI or onto the seat-plane chair.
- CLI→bot messaging MCP; judgment plane pulling the product; seat plane polling SoT.
- Restoring a retired judgment-plane gateway; renaming product bots in git; inventing results for Seat-Charlie.
- A ~60s job that re-runs the same delegated sweep.
- Rewriting entity-bot claim language the audit already called safer — no evidence it is wrong, and no dump to edit from.
- Treating vault unreachability as license to skip SoT and push from memory.
- Expanding this PR to fix unrelated CI (mobile `expo install --check` registry drift on `main`).

## 5. Apply-GW go / no-go

**NO-GO as a paired ship. GO vault/git seat apply only after instructions+description (not title-only) plus a redacted live four-row proof in the private vault; NO-GO the quota job until it is single-flight executor backoff with fan-out collapse — not a minute-scale re-dispatch or chat twin.**

---

*This file is the sole change on this branch. It does not apply seats, retry quota, or touch production. Map placeholders to the private packet off-tree.*
