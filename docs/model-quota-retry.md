# Model quota retries

Rakazo waits inside the Pi runtime when a model request hits a quota or rate limit.
The default is a 60-second wait and at most three retries after the initial
request. No polling bot, chat loop, extra model call to decide whether to retry,
or quota purchase is involved. The same credential and model handle the retry.

The classifier accepts HTTP 429, `insufficient_quota`, `RESOURCE_EXHAUSTED`,
and quota/rate-limit/TPM error messages, including nested OpenRouter provider
errors. `Retry-After` alone never classifies a failure as quota. After quota
classification, a valid header sets the wait floor: numeric values are seconds,
and HTTP dates are also supported. The delay is the greater of the configured
wait and `Retry-After`.

Non-quota failures such as HTTP 503 `No available provider` keep their original
diagnostic and do not enter this retry loop, even with `Retry-After` present.
[OpenRouter also uses this header for 503 responses](https://openrouter.ai/docs/api_reference/errors-and-debugging#retry-after-header);
it does not identify the failure category.

For OpenAI-completions transports (including OpenRouter and OpenAI-compatible
connections), Rakazo observes failed HTTP headers before Pi flattens errors.
Other Pi transports use the error metadata and response callbacks they expose;
headers discarded by those transports cannot be recovered here.

During the wait, the existing thread activity or subagent progress displays
`Quota, retrying in 60s (1/3).` The delay and attempt count reflect the actual
wait. The notice clears on continuation or cancellation. If all retries fail,
the failure message is `Quota retry failed after 3 retries. Try again later.`,
using the configured retry count. Parent failures use the existing run failure
receipt; nested failures appear in the failed subagent result returned to the
parent. These messages appear only when quota interrupts work, so a quiet wait
cannot look like a stalled run.

## Operator settings

Set these on the process running the Rakazo worker, then restart that process:

| Setting | Default | Meaning |
| --- | --- | --- |
| `RAKAZO_QUOTA_RETRY_MS` | `60000` | Positive integer minimum wait in milliseconds; an explicit override can lower or raise it. |
| `RAKAZO_QUOTA_RETRY_MAX` | `3` | Nonnegative integer retries per model request, after the initial attempt; `0` disables retries. |

Empty, fractional, negative, nonfinite, and unsafe integer settings fall back to
the defaults (`0` is valid only for the retry count). Longer server delays always
win. Cancellation interrupts the wait. The worker's existing lease heartbeat
continues while waiting. Retry state is in memory for the active model request;
this is not a durable timer that survives a worker restart.

## Replay boundary

`packages/adapters/src/pi-quota-retry.ts` wraps each parent or nested Pi model
stream. It does not retry `agent.prompt`, a tool call, or a whole run. Previously
completed tool results remain in the request context and existing effect IDs are
unchanged. Pi executes tool calls only after a successful model completion.

A quota stop partway through a response replays the same request under the same
retry count. None of its tool calls ran, and thinking is never shown, so only
streamed text can repeat. The runtime emits a `retract` event for that text
before the replayed response streams; the executor removes it from the turn and
restores the live text the quota notice replaced. If that text is no longer
unpublished, the run fails with `Mid-response quota stop was not retried. Try again later.`
rather than guessing. Rakazo never asks a provider to continue a partial
response; previously completed effects remain intact.

[OpenRouter documents mid-stream errors](https://openrouter.ai/docs/api_reference/errors-and-debugging#mid-stream-errors),
including rate-limit failures after streaming begins. These arrive in the stream
while the HTTP status remains `200 OK`, so a successful HTTP status does not rule
out a later quota stop.

Other runtime implementations and history compaction are outside this retry
wrapper. Provider SDK retries are disabled within wrapped calls so they cannot
multiply the configured retry count.

Tests use synthetic streams with fake timers and the real Pi/OpenAI-compatible
transport against a loopback HTTP fixture. They cover a successful retry, longer
headers, non-quota failure, cancellation, exhausted retries, replays after partial
text, reasoning, or tool-call output without repeated text or effects, and a failed
continuation after a tool write that must execute exactly once.

# Large sweeps through Antigravity

The built-in `antigravity-research` skill routes large sweeps, deep research, and
catalog migrations through the optional Antigravity CLI. It appears in the shared
skill catalog and uses the existing `skill_read`, shell, and file tools on the
bot's computer. The skill handles delegation; model selection of a skill remains
model-driven, not a deterministic task classifier. Explicitly invoke the skill
when routing must be requested directly.

Install/configure Antigravity independently on that computer and set
`RAKAZO_ANTIGRAVITY_CLI` there to its executable path; the default is `agy`.
This is a skill-consumed computer setting, not a worker host-command setting.
Configure an existing project and an explicit non-Grok Antigravity model for the
bot. On Windows, reuse existing projects under
`C:\Users\<operator>\antigravity\projects\`. The CLI and project must be accessible
within the bot's existing permissions; a worker-host installation alone does not
make them available inside a sandbox.

The skill reads the project's contracts and hooks, limits the dispatch brief to
8192 UTF-8 bytes, invokes CLI print mode with a five-minute timeout, and verifies
pack/receipt files before reporting completion. It does not create projects,
add mounts or source roots, bypass permission prompts, or apply research results.
If setup is unavailable, it reports the exact blocker rather than performing the
bulk retrieval in the bot's model context. Web, Electron, and mobile all use this
same backend skill and computer boundary.

For a dry run, use `--mode plan`, request no source retrieval or writes, and
capture the JSON CLI response. Returned pack/receipt paths are only planned paths
until files have been created and verified. After a timeout or ambiguous status,
inspect the original run before dispatching again.
