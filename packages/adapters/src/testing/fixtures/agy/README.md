# Antigravity CLI output fixtures

Each folder is one job folder as the research launch script leaves it:
`events.ndjson` (stdout in `stream-json` mode), `stderr.log`, and `exit.code`
unless the run died before the wrapper could write it. `AgyComputerEmulator`
replays a folder into a fake computer, and `antigravity-research.test.ts` pins
the status and error code each one maps to.

These folders are still the synthetic goldens the emulator tests pin (conversation
ids and the completed findings document). Slice 2 captured real `agy` 1.2.2
print-mode runs under `../agy-observed/` (see `FACTS.md` there). Real stream-json
uses `{event:"init"|"step_update"|"result"}`, not `{type,subtype}`. Replace these
goldens only when the parser and tests move to that shape.

`oversize-events` is generated in memory by the emulator because an eight
megabyte file does not belong in the repository.
