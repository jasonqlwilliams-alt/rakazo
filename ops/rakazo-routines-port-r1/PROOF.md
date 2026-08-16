# PROOF: rakazo-routines-port-r1

Port of 17 source routines onto the eight Rakazo seats. Executed 2026-08-16
against the live local stack (`/health` → `{"ok":true,"runtime":"pi",...}`).

**Result: 15 cron routines created and verified. 2 event routines not created —
see [GAP-EVENT-LISTENERS.md](GAP-EVENT-LISTENERS.md). Every created row is
paused. Nothing fired. Nothing was sent to the user.**

Prompts are not reproduced here — this repository is public. Fidelity is proven
instead by SHA-256 over the stored prompt, which is compared against the
SHA-256 of the `prompt` field in the source file. The source files are in the
job packet at `packet/automations/`.

## How it was done

`scripts/import-routines.mjs`, driven with `--timezone America/Los_Angeles` and
the default paused/quiet flags, against the `routines.create` RPC on the live
stack. Each row was read back through `routines.list` immediately after
creation, then re-verified independently by reading the database directly.

## The 15 created rows

All rows: `timezone=America/Los_Angeles`, `active=false`, `notify=false`,
`nextRunAt=null`, `lastRunAt=null`.

The **Source state** column is whether the routine was enabled on the host it
was ported from — recorded because it determines which copies are candidates to
be activated later, and which must stay paused regardless.

| Seat | Name | Cron | Source state | Routine id | Prompt chars | Prompt SHA-256 (first 16) |
| --- | --- | --- | --- | --- | --- | --- |
| Chronicle | 5am day exists | `0 5 * * *` | enabled | `cmsw8u9lp000clxidlk0umjff` | 571 | `b9ba6d564d58fd6d` |
| Chronicle | Daily note usable | `0 8,12,16,20 * * *` | enabled | `cmsw8u9ms000elxidsuftq7im` | 832 | `219c2cabb374b442` |
| Chronicle | Write the day | `0 21 * * *` | enabled | `cmsw8u9nu000glxidtxzupf5o` | 676 | `fb12d40631a186b9` |
| Eleusis | Captain gates | `4,14,24,34,44,54 * * * *` | enabled | `cmsw8u9ox000ilxidc0u3o9pc` | 978 | `4a90ff263d2f4a08` |
| Eleusis | Lab-day ACS pulse | `0 14,17,20 15,16 8 *` | paused | `cmsw8u9q3000klxidy9l6m9zs` | 991 | `fedc7020da948c45` |
| Flux | Daily activity log | `3 20 * * *` | enabled | `cmsw8u9r7000mlxidzmoalbgl` | 1589 | `27a9d3973019ff27` |
| QA Engineer | Fleet tempo deploy and review | `47 1,3,5,7,8-21,23 * * *` | enabled | `cmsw8u9s8000olxid0j7deg2a` | 1058 | `8d0f0e476b41c109` |
| QA Engineer | Vault improvement pass | `47 8,20 * * *` | enabled | `cmsw8u9t2000qlxidfoowy4qr` | 1100 | `1f31d942fb648536` |
| Spur | FirstMate whip | `23 1,3,5,7,8-21,23 * * *` | enabled | `cmsw8u9u4000slxid9wz0f4a3` | 1998 | `c78baed844fcaffa` |
| Spur | Human-gated list | `2,12,22,32,42,52 * * * *` | enabled | `cmsw8u9ux000ulxidm8zdrbgn` | 1541 | `8392cbddef056bb8` |
| Spur | Session count | `23 16 * * 1-5` | enabled | `cmsw8u9vt000wlxid3b1twpkh` | 271 | `72962caf8d31581e` |
| Spur | Session FirstMate pulse | `*/5 * * * *` | paused | `cmsw8u9wl000ylxiduufvt7g4` | 924 | `aa62301ae3947401` |
| Thor | ACS project quality watch | `31 1,3,5,7,8-21,23 * * *` | paused | `cmsw8u9xo0010lxidtmiyaejg` | 2161 | `dd96e9de7b1c7703` |
| Thor | Continuum smooth 10-min | `2,12,22,32,42,52 * * * *` | paused | `cmsw8u9ym0012lxide8drmtrn` | 1209 | `f9bbb6ec7b0a7dca` |
| Thor | E-drive junkyard sweep | `41 1,3,5,7,8-21,23 * * *` | paused | `cmsw8u9ze0014lxid2gvclwh6` | 857 | `6aa8fa01198d99d4` |

## Checks that passed

Verified by reading the database directly after the import, per row:

- `prompt` byte-identical to the source `prompt` — **15/15**
- `cron` byte-identical to the source `schedule` — **15/15**
- `name` byte-identical to the source `name` — **15/15**
- landed on the correct seat — **15/15**
- `timezone = America/Los_Angeles` — **15/15**
- `active = false` — **15/15**
- `notify = false` — **15/15**
- `nextRunAt = null` and `lastRunAt = null` — **15/15**

Fleet-level:

- Routine rows in the workspace: **15** — Chronicle 3, Eleusis 2, Flux 1,
  QA Engineer 2, Spur 4, Thor 3, **Ledger 0, Argon 0**.
- Flux holds exactly one routine, the daily activity log. No research cron.
- Queued `routine.*` jobs in `graphile_worker.jobs`: **0**. No wakeup is
  scheduled for any row, so none of them can fire.
- Tasks and runs created by this import: **0**. `testRun` was never called.
- Thread events created by this import: 15 × `routine.created`, which is the
  API's own record of a routine being added. No `routine.fired`.

The workspace was empty of routines before this import, so there was nothing to
collide with and no duplicates were created. The importer is idempotent — a
re-run reports `skipped` for a name that already exists on the seat.

## Blocker for the proving stage

The plan for proving a copy is to fire it once and confirm it stays quiet,
relying on `notify=false`. **That does not work on the current code.**

`Routine.notify` is stored and returned by the API but is never read by any
execution path. Push notifications for a routine's run are decided only by
`Bot.notifyOnFinish`, which is `true` on all eight seats, and the `help` and
`takeover` pushes are not gated by anything at all. Details in
[`docs/routines.md`](../../docs/routines.md).

So firing any of these — by `testRun` or by activating one — can push to the
user even though the row says `notify=false` and the prompt says stay quiet.

Before any copy is proven, either:

1. set `notifyOnFinish=false` on that seat for the duration of the test, and
   accept that a `help`/`takeover` push can still get through; or
2. wire `Routine.notify` into the notification path so the flag means what the
   API implies it means.

Option 2 is the real fix and is small: thread the routine's `notify` onto the
run and check it alongside `bot.notifyOnFinish`.

## State left behind

- The 15 rows exist and are inert.
- The routines on the original host were not touched. They are still the live
  clocks.
- No switch-over was stamped. Nothing was activated. Nothing was deleted.
- The two event routines have no Rakazo counterpart, by design.
