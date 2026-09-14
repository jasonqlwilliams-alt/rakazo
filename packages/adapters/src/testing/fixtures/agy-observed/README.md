# Observed Antigravity CLI fixtures

Redacted stdout/stderr from real `agy` 1.2.2 print-mode runs.
Captured by `packages/adapters/src/testing/capture-agy-fixtures.sh`.
Facts: `FACTS.md`.

Each observed folder has `events.ndjson`, `stderr.log`, `exit.code`, and `meta.json`.
Synthetic folders have `reason.txt` instead of a run.

Do not replace `../agy/<case>/` with these files in this slice: the emulator tests pin those goldens. A later product slice can teach the parser the real `{event, result}` stream.
