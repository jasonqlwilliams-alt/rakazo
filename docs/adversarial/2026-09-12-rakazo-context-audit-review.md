# Thor-class adversarial review — Eleusis Rakazo context audit

- Date: 2026-09-12
- Reviewer: Grokbot adversarial seat (this run). Continuum remains SoT. This file is judgment only.
- Scope: falsify Eleusis findings A–E and the five-item correction packet.
- Non-actions (honored): no live Rakazo `bots` Save, no merge to `main`, no deploy, no production config edit, no fleet seat copy landed in this public repo.

Stamps used: **SOUND** (reproduced or independently corroborated), **THIN** (plausible, unfalsified, insufficient artifact), **WRONG** (contradicted by evidence).

## Method and evidence inventory

Attempted independent close of the SoT loop. It did not close.

| Channel | Result |
|---|---|
| Continuum MCP | Discovery failed. Tools unavailable. Cannot read Continuum SoT, cannot confirm Grokbot seat-kill text, cannot confirm `seat-descriptions-dualrun-apply`. |
| GitHub MCP | Discovery failed. |
| `jasonqlwilliams-alt/rakazo` | Public product repo. Zero matches for Eleusis, The Rite, Spur, Chronicle, Argon, FirstMate, dual-run, Antigravity, AGY, TPM. No `docs/adversarial/` prior to this file. No fleet seed. |
| Notion (Still Labs / Elements of Equity) | No pages titled Eleusis / Rakazo fleet / dual-run seat apply. Continuum SOP `3c713fbd-3d95-8149-9ada-f28e0c583a09` is a one-line stub (vault-path authority claimed, body empty, last edited 2026-08-25). Older NADES pages mention Google Antigravity as a *human* code-gen tool (2026-03), not tonight's fleet order. |
| Slack | No hits for `Eleusis Rakazo`, `The Rite Eleusis`, or `429 quota TPM` in the searched window. |
| Cloud-agent list | This review run only. No sibling Eleusis audit transcript in-environment. |
| Live Rakazo DB | Not queried. Dual-run law + this brief forbid live Save from chat; a read-dump was also not provided. |

Operator-authoritative inputs accepted as *inputs*, not as reproduced facts:

1. Continuum dual-run law (Grokbot = judgment; Rakazo = seat computers; push not pull; no live Save from chat; path Continuum → Eleusis → Meridian → FirstMate → vault/git → Rakazo).
2. Jason tonight: 2M TPM retry belongs *inside Rakazo*; large sweeps/research → Antigravity CLI from Rakazo hands; Eleusis audits, then this review.

What this public repo *does* prove about the product (used below to falsify field, layer, and retry claims):

- `bots` has four identity columns: `name`, `title`, `description`, `instructions` (`packages/db/prisma/schema.prisma`).
- Runtime system prompt prefers `bot.instructions`. Title/description are fallback only when instructions are empty (`packages/adapters/src/executor.ts`).
- Web create/save and mobile create copy Description → `instructions` (`apps/web/src/pages/Shell.tsx`, `apps/mobile/app/new.tsx`). Title is a separate UI field.
- Durable context also includes `MEMORY.md`, user memory, and optional Supermemory recall. Thread history stays in the prompt until compact/clear.
- `spawn_bot` creates a lasting child (own thread, computer, memory). `run_subagent` is in-turn only, gated at `MAX_PARALLEL_SUBAGENTS = 4`. Executor already says never use both for the same request.
- No model-call 429 / TPM / Retry-After path exists in `pi-runtime` or the executor. `UsageRecord` is an append-only ledger, not a governor. Background jobs are `run.continue`, `routine.wakeup`, `computer.sleep`, `computer.control-expire`, `history.compact` only.
- Voice HTTP is the only 429 handler, and it returns a user string — it does not retry.

## 1. Verdicts on findings A–E

### A. Live Rakazo bots table still has Eleusis title=The Rite, Spur=Interrupt, Chronicle=Intake, Argon=ACS Monday pressure — HIGH

**Stamp: THIN**

Why it does not go SOUND:

- No redacted `bots` row dump (id / name / title / description / instructions prefixes or hashes, `updatedAt`). Continuum SoT and Slack are empty. This reviewer cannot see the live table and must not open a Save path to "check."
- Eleusis audited **title**. That is the wrong primary field for "wrong context." Behavioral identity is `instructions` first. If instructions are already populated (the web/mobile Save path writes Description into instructions), a stale title is cosmetic. A title-only HIGH finding can be a false positive.
- The inverse is also unclosed: if instructions are empty, title+description *are* the system prompt, so title drift would be behavioral. Eleusis did not say which branch they observed.
- "Grokbot already updated; Rakazo apply pending FM" is operator narrative. Grokbot text is not in this repo. Continuum MCP could not confirm the seat-kill packet.

Why it does not go WRONG:

- Dual-run law plus Jason's "Grokbot seat kills already applied, Rakazo apply pending" make *some* Rakazo lag expected. The product stores seat text in Postgres, not in this git tree. Drift between Grokbot files and live `bots` is a real class of bug.
- Four named seats (Eleusis / Spur / Chronicle / Argon) matching four old titles is specific enough that wholesale invention is unlikely — but specificity without a dump is still not reproduction.

Falsifier Eleusis must attach before this becomes SOUND: a FirstMate-exported, redacted four-row table showing `title` *and* `instructions` (and `description`) for those seats, plus Continuum SoT hashes for the intended text.

### B. Rakazo Eleusis fan-out entity sweeps → twin-captain smell + mass 429s — HIGH

**Stamp: THIN**

The finding bundles two claims. Split them.

**Twin-captain (governance).** SOUND as *law*, THIN as *tonight's incident*. Dual-run forbids a second captain. This repo has no Grokbot, no Eleusis, no entity-sweep router. Twin-captain cannot be proven from product code. No session IDs, no spawn keys, no child-bot list for Still Labs / Academic / Continuum / MBS. Slack empty. Continuum down.

**Mass 429 amplification (product).** SOUND as *mechanism*, THIN as *attribution to Eleusis tonight*. The product will happily amplify parallel Google spend:

- `run_subagent` admits four nested agents at once.
- `spawn_bot` creates lasting bots that enqueue their own `run.continue` jobs (another quota multiplier, and they persist after the parent turn).
- Team computers can run distinct screens in parallel (landed behavior, not a bug).
- There is no fleet-wide sweep governor and no TPM backoff.

That architecture makes "entity sweep fan-out → 429 storm" easy. It does not prove Rakazo Eleusis did it tonight, nor that Eleusis (Grokbot) and Eleusis (Rakazo seat) were both captaining. 429s can also come from AGY CLI, other seats, OpenRouter-wrapped Google, or a single fat prompt.

Do not treat "smell" as a closed incident. Require: parent run id, child spawn keys, `usage_records` rows (provider/model/tokens/timestamps), and the 429 payload (which product: Google AI Studio, Gemini, Antigravity, OpenRouter).

### C. Misread AGY order as "have the grok bots use antigravity CLI" — inverted — MED-HIGH

**Stamp: THIN** (as an Eleusis-misread finding). The *routing correction* is SOUND given Jason tonight + dual-run law.

Why THIN:

- No source utterance, session, or PR that actually said "have the grok bots use antigravity CLI." Slack and this repo are silent. Notion's AGY hits are a 2026-03 NADES human/code-gen brief — a real inversion *attractor*, not proof of tonight's misread.
- This repo contains zero AGY / Antigravity / CLI-delegation code. There is nothing here to invert. The misread, if it happened, lived in Grokbot/Continuum routing text this reviewer cannot see.

Why the correction still stands (see packet item 3): Jason confirmed large sweeps/research → Antigravity CLI *from Rakazo hands*. Dual-run keeps Grokbot on judgment. "Grok bots run AGY" is the forbidden inversion whether or not Eleusis can produce the guilty sentence. Stamp the *finding* THIN; do not wait to rewrite the routing table.

### D. Google AI 429 on delegated sweeps; chat-level 1-min retry still failed — Confirmed

**Stamp: SOUND**

Jason tonight is accepted as the incident report: 2M TPM/quota stoppage, retry one minute later, retry belongs inside Rakazo, chat-level retry failed. That is enough to stamp the *layer* claim.

Independent product corroboration (this repo, 2026-09-12 `main`):

- No LLM 429 / TPM retry in `packages/adapters/src/pi-runtime.ts` or `executor.ts`. A quota error becomes `agent.state.errorMessage` and is sanitized into the thread. The run does not sleep, does not honor Retry-After, and does not single-flight siblings.
- `UsageRecord` writes tokens after the fact. Nothing reads them to shed load.
- Background jobs have no quota handler. Chat saying "wait 60s and try again" is therefore the only retry that existed — and it is the wrong layer.
- A one-minute retry of the *same* parallel fan-out is expected to fail again: TPM stoppage is a bucket, not a blip. Parallel sibling retries from chat make it worse.

Caveat that stays THIN (does not downgrade the stamp): this reviewer did not see the Google 429 body, request id, or which delegated sweep. Attribution to "delegated sweeps" specifically is Jason/Eleusis narrative. The code still proves chat-level 60s retry cannot be the fix.

### E. SOUND pockets: entity bots claim-safer; Elements noted vault unreachable

**Stamp: THIN**

Eleusis grading its own remainder as SOUND is not a finding. It is a request to stop looking.

- "Entity bots claim-safer" — no claim logs, no Slack, no Continuum objects, no before/after claim text. Unfalsifiable praise. Leave those seats alone (see over-correction), but do not stamp them SOUND.
- "Elements noted vault unreachable" — Continuum MCP is down *in this review*, so vault/SoT unreachability is a live fact tonight. Attribution to Elements, and the implication that the rest of the audit is therefore reliable, is unproven. A down SoT is a reason to *widen* doubt, not to bless pockets.

## 2. Correction packet

**Verdict: approve-with-edits**

Do not reject the direction. Do not approve as written. The packet mixes three SOUND moves with two that recreate the failure (title-only apply; 60s re-fan-out "quota job") and one that violates dual-run if implemented as a Rakazo cron pull.

### Item 1 — Land `seat-descriptions-dualrun-apply` via vault/git (no live Save)

**Approve the path. Edit the payload.**

Required edits:

1. Apply `instructions` and `description`, not `title` alone. Runtime reads instructions first. Web/mobile Save aliases Description → instructions. Title-only is a likely no-op for model behavior and leaves The Rite / Interrupt / Intake / Monday-pressure in the prompt if those strings live in instructions.
2. Do not land production seat copy in `jasonqlwilliams-alt/rakazo`. This tree is public (`AGENTS.md`). Seat text belongs in the private vault/git hop, then FirstMate → Rakazo `bots.update` from an authorized operator path — not a chat Save, not a PR on this repo.
3. Attach the redacted four-row before/after proof named in finding A. No dump, no apply.
4. After apply, treat memory and history as separate residue: `MEMORY.md`, user memory, Supermemory, and in-thread old identity are not updated by `bots.update`.

### Item 2 — Fence Rakazo Eleusis: no twin-captain / no simultaneous fleet entity sweeps without Grokbot Eleusis brief

**Approve the intent. Edit the mechanism.**

Required edits:

1. This is a Grokbot Eleusis routing rule (push a brief, or do not sweep). It is not a Rakazo product fence and must not disable `spawn_bot` / `run_subagent` / Team parallel screens globally.
2. "Without Grokbot Eleusis brief" must not become Rakazo Eleusis polling Grokbot or Continuum. Push, not pull. No CLI→bot messaging MCP.
3. Distinguish three tools: `run_subagent` (in-turn, max 4), `spawn_bot` (lasting fleet children — worse if used for a sweep), AGY CLI from the seat computer (Jason's bulk path). The fence is "no simultaneous *fleet entity* sweeps," not "Eleusis may not use a computer."
4. Do not overwrite Rakazo Eleusis instructions from chat to "install the fence." Same vault/git path as item 1, or Grokbot-only policy.

### Item 3 — Rewrite AGY routing: Rakazo→AGY CLI for bulk; Grokbot stays judgment

**Approve.** This matches Jason tonight and dual-run. Finding C being THIN does not block it.

Required edits:

1. Write the rewrite in Continuum / Grokbot routing, not in this public repo (there is no AGY adapter here to change).
2. AGY is invoked from Rakazo *hands* (seat computer / CLI), not by Grokbot, and not by a new CLI→bot messaging MCP.
3. Do not send judgment, Roundtable chair work, or FirstMate gateway duty to AGY.
4. Note: AGY CLI can still burn the same Google TPM bucket. Routing bulk *off* chat does not by itself stop 429s (see item 4).

### Item 4 — Code-level quota retry FM job; stop parallel chat retries

**Approve "stop chat retries" and "retry lives in Rakazo." Reject the job shape as implied.**

Required edits:

1. Stop parallel chat-level retries immediately (Grokbot policy). SOUND. Do not wait for a code ship.
2. Do **not** add a Graphile / FirstMate job that waits 60s and re-dispatches the same N-way sweep. That is the failed chat retry with a longer name. `UsageRecord` and the current job list prove there is no existing governor to hang that on.
3. If/when code ships (separate FM job, not tonight's chat, not this PR): detect 429/TPM in the runtime; honor Retry-After; exponential backoff with jitter; **single-flight** the seat; **collapse concurrency** (shed `run_subagent` / refuse additional `spawn_bot` while the bucket is hot); do not retry an identical fan-out. One minute is Jason's *floor*, not a complete policy for a 2M TPM stoppage.
4. Do not implement that runtime change in this review PR. Do not live-Save a routine that "retries every minute."

### Item 5 — Standing Eleusis audit job vs Continuum SoT

**Approve only as a Grokbot Eleusis judgment pass. Reject as a Rakazo cron that pulls Continuum or scrapes live `bots`.**

Required edits:

1. Dual-run: push, not pull; no twin captains. A standing Rakazo job that polls Continuum or the live table is a second captain with a schedule.
2. Continuum MCP is down *now*. A standing job launched tonight would fail closed or invent drift. Do not create it until SoT is reachable and the first apply (item 1) has a dump.
3. After SoT is up: Grokbot Eleusis compares Continuum-pushed seat text to a FirstMate-exported redacted snapshot. Trigger is a Meridian/FirstMate push or a Grokbot cadence — not Rakazo waking itself to "check Continuum."

## 3. Blind spots Eleusis missed

1. **Four fields, one glance.** `name` / `title` / `description` / `instructions` are independent. Web/mobile alias Description → instructions on Save. Onboarding can write a third instructions string from Q&A. Auditing title only can both over-alarm and miss the real stale prompt.
2. **Residue after a clean `bots.update`.** `MEMORY.md`, user-scoped memory, Supermemory recall, and thread history will still teach "Eleusis is The Rite" (etc.) until separately cleared or compacted. Child bots spawned under the old parent keep their own instructions and memory.
3. **No incident artifacts.** No run ids, spawn keys, 429 request ids, `usage_records` slice, Continuum object ids. The audit is unreproducible. This review could not get them from Continuum, Slack, Notion, or GitHub.
4. **429 source ambiguity.** Google AI vs Gemini vs Antigravity vs OpenRouter-wrapped Google vs other seats vs voice. Item 3 (move bulk to AGY) can *concentrate* Google spend on the same TPM cap.
5. **Public vs private git.** This repo must not receive production seat text. "Land via vault/git" if misread as "open a rakazo PR with the seat packet" leaks fleet context.
6. **Product features mistaken for Eleusis bugs.** `MAX_PARALLEL_SUBAGENTS = 4`, `spawn_bot`, and Team parallel screens are intended. The bug is ungoverned fleet entity sweeps, not the tools existing.
7. **Surfaces.** Web, Electron (hosts web), and mobile share `bots.update`. Apply once via the API. Do not "fix" one client.
8. **SoT was dark.** Continuum MCP failed discovery. Notion Continuum authority SOP is an empty stub. A standing audit job against that SoT would be theater.
9. **`UsageRecord` is not a brake.** Tokens are logged; nothing gates on them. A quota FM job that only *records* more usage does nothing.
10. **Claim-safer entity bots** were not evidenced. They may still be running under a parent whose instructions still say The Rite.

## 4. Danger of over-correcting — do not change

- Live Rakazo Save from chat, merge to `main`, or deploy from this review.
- Production seat copy, live bot ids, workspace ids, or credentials in this public repo.
- Title-only apply that leaves `instructions` / `description` / memory / history stale — or a wipe of instructions that drops a good seat.
- Global disable or schema collapse of `spawn_bot`, `run_subagent`, Team parallel screens, or `title`/`description`/`instructions`.
- Moving judgment, Roundtable chair, or FirstMate gateway onto AGY or onto Rakazo Eleusis.
- CLI→bot messaging MCP; Grokbot pulling Rakazo; Rakazo polling Continuum.
- Restoring Copilot; renaming product bots in git; inventing Argon "Results."
- A 60s job that re-runs the same delegated sweep.
- Rewriting entity-bot claim language that Eleusis already called safer — no evidence it is wrong, and no dump to edit from.
- Treating vault unreachability as license to skip SoT and push from memory.

## 5. FirstMate go / no-go

**NO-GO as a paired ship. GO vault/git seat apply only after instructions+description (not title-only) plus a redacted live four-row proof; NO-GO the quota job until it is single-flight executor backoff with fan-out collapse — not a 60s re-dispatch or chat twin.**

---

*This file is the sole change on this branch. It does not apply seats, retry quota, or touch production.*
