# Antigravity CLI output fixtures

Each folder is one job folder as the research launch script leaves it:
`events.ndjson` (stdout in `stream-json` mode), `stderr.log`, and `exit.code`
unless the run died before the wrapper could write it. `AgyComputerEmulator`
replays a folder into a fake computer, and `antigravity-research.test.ts` pins
the status and error code each one maps to.

Every fixture here is synthetic. No real `agy` run has been captured yet, so
the event shapes, the `error:` lines and the timeout warning follow the CLI
changelog and help text, not observed output. When captured fixtures replace
these, keep the folder names and the redaction rules: no real conversation
ids, emails, usernames, host paths or project names. The `fixture-conversation-*`
ids are placeholders and stay.

`oversize-events` is generated in memory by the emulator because an eight
megabyte file does not belong in the repository.
