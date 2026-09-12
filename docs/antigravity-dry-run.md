# Antigravity CLI dry-run receipt

Date: 2026-09-12

A read-only invocation of the installed Antigravity CLI against an existing
configured project completed successfully using `gemini-3.8-flash-low`.
The invocation used `--mode plan`, `--output-format json`, and a 30-second
print timeout. It explicitly prohibited tools, source retrieval, file writes,
permission changes, and research. The brief was below the 8192-byte skill limit.

The CLI returned status `SUCCESS`. Its response contained:

```json
{
  "status": "dry-run",
  "packPath": "packs/2026-09-12-rakazo-cli-dry-run.md",
  "receiptPath": "artifacts/2026-09-12-rakazo-cli-dry-run.json",
  "filesCreated": false
}
```

These are **planned paths**, not produced research artifacts. This verifies CLI
reachability, project selection, bounded prompt delivery, and receipt parsing.
It does not prove a production research pack, the bot's selection of the skill,
or CLI availability inside every bot computer. Project identity and CLI
conversation identifiers are intentionally omitted from this public receipt.

A separate quota probe reported `Antigravity process discovery failed`.
The successful CLI invocation demonstrates that this discovery failure did not
block CLI access in the verification environment. No Grok model was invoked.
