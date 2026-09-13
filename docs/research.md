# Research

Space owners enable research in web Settings. The bot needs a computer. When
settings are stored, the model gets `research_start`, `research_status`, and
`research_cancel`. Start needs the same approval as `cloud_agent_launch`. Status
is read-only. Cancel does not need approval. One computer runs one research job at
a time. Findings arrive as `findings.json` and `report.md` on that job's thread
message. The card shows the title and one status word.

Install the Antigravity CLI on the bot's computer and sign in there. Set Model.
Project, Executable, and Mode are optional. The default executable is `agy`.
Research is unconfigured when there is no computer.

The built-in `deep-research` skill names those tools. It does not launch a
shell.

The bot's own model quota waits are separate; see
[Model quota retries](model-quota-retry.md).
