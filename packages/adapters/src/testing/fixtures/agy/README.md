# Antigravity CLI output fixtures

Each folder is one job folder as the research launch script leaves it:
`events.ndjson` (stdout in `stream-json` mode), `stderr.log`, and `exit.code`
unless the run died before the wrapper could write it. `AgyComputerEmulator`
replays a folder into a fake computer, and `antigravity-research.test.ts` pins
the status and error code each one maps to.

These folders are synthetic goldens: the emulator tests pin their conversation ids
and the completed findings document. Real `agy` runs are captured under
`../agy-observed/`, and `FACTS.md` there records the real stream shape. Replace
these goldens only when the parser and tests move to that shape. Keep the folder
names, and keep real conversation ids, emails, usernames, host paths and project
names out. The `fixture-conversation-*` ids are placeholders and stay.

`oversize-events` is generated in memory by the emulator because an eight
megabyte file does not belong in the repository.
