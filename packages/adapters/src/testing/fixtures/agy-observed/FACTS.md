# Slice 2 facts (agy 1.2.2)

Captured 2026-09-14 from small print-mode runs on the signed-in operator account.
The capture script is `packages/adapters/src/testing/capture-agy-fixtures.sh`.
Raw runs stayed in worktree `.tmp/agy-capture/`. Settings, permissions, hooks, MCP, plugins, and projects were not changed.
`--dangerously-skip-permissions`, `--new-project`, and `--add-dir` were never passed.

## Open facts

1. **Event shapes.** `--output-format=json` prints one envelope: `conversation_id`, `status` (`SUCCESS` or `ERROR`), `response`, `error`, `duration_seconds`, `num_turns`, `usage`. `--output-format=stream-json` is NDJSON of `{event, ...}` objects, not `{type, subtype}`. Observed events: `init` (model, cwd, tools, `permission_mode`, optional `json_schema`, optional `expanded_commands`), `step_update` (`step_index`, `state`, `step_type` `user_input`|`agent_response`|`tool`|`finish`, `text_delta`, `tool_name`, `tool_info`), and `result` nested under `result` with `status`, `response`, optional `structured_output`, optional `json_schema`, `usage`, optional `denied_actions`. The final result event is `{"event":"result","result":{...}}`. The library's current parser looks for `type: "result"`; it will not read this stream until a later product slice updates it. `--json` envelopes still match the dry-run `status`/`response` shape.

2. **`--json-schema` in stream-json.** Help text is accurate: it applies to the final result. `init.json_schema` and `result.json_schema` echo the file. Both no-tool schema runs (`completed-plan-mode`, `schema-enforced`) have the same steps and `num_turns: 2`: a free-text `agent_response`, an injected `user_input`, a structured JSON `agent_response`, then `finish`. `structured_output` comes from that final structured turn, not the free text. In `schema-enforced` the free text did not match the schema, the final turn did (`mustEqualZYX: "ZYX"`), and the process exited 0 with `status: SUCCESS`. No stderr violation text was printed. Extra keys in the final turn (`toolAction`, `toolSummary`) were stripped from `structured_output`. A final turn that does not match the schema was not observed, so a CLI schema-miss print is unobservable in print mode on 1.2.2; invalid findings remain a harness check (the `../agy/schema-violation` golden; here `schema-violation-synthetic`).

3. **Headless tool denials.** Default print auto-denies tools that need a prompt. Observed stderr, always the same shape: `jetski: no output produced — a tool required the "<perm>" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. <perm>(<target>)). Alternatively, re-run with --dangerously-skip-permissions...` Result also lists `denied_actions: [{action, display_name}]`.
   - `search_web`: ran (~2s), not listed in `denied_actions`. Allowed by default.
   - `read_url_content`: denied. Permission `read_url`, display `ReadUrlContent`. Allow-rule `read_url(<target>)`.
   - `run_command`: denied. Permission `command`, allow-rule `command(<target>)`.
   - `list_dir` / `read_file`: denied. Permission `read_file`, display `ListDir`. Allow-rule `read_file(<target>)`.
   - `write_to_file`: unobservable. The model did not call it in the small runs; `/etc/agy-capture-forbidden.txt` was not created.
   Narrowest operator allowlist for web page reads without commands, quoted from the CLI, not applied: `read_url(<target>)`. `search_web` already works. Do not add `--dangerously-skip-permissions`.

4. **`--mode plan` vs `accept-edits`.** Every stream-json run reported `permission_mode: "request-review"` (json envelopes do not carry it). Plan additionally set `expanded_commands: [{name:"plan", type:"system"}]`. Accept-edits did not relax headless auto-deny: `read_url`, `read_file`, and `command` were denied; file writes were not observed. Plan-mode web reads and file writes are unobserved: no plan run called a tool (the plan briefs asked for no tools, and `timed-out-partial` stopped before a tool step). The shared `request-review` mode only suggests the same denials. `--mode plan` has no effect with `--disable-slash-commands` (warning on stderr, `json-format`). Plan returned a no-tool structured reply.

5. **`--sandbox`.** Always on in the live runs. Help: "Run in a sandbox with terminal restrictions enabled." The unsandboxed delta was not probed (would risk writes outside the throwaway dir). Observed denials above are headless permission prompts, not a separate sandbox message.

6. **Timeout.** `--print-timeout=5s` exited 0. stderr: `[agy] print timeout after 5s with turn in progress; returning partial output`. `result.status` was still `SUCCESS`, `response` empty, no `structured_output`. No `notice: the response may be truncated` line. The changelog 1.1.28 wording was close; the observed line is the `[agy] print timeout after <duration> with turn in progress` form.

7. **Auth.** Empty `HOME`, stdin closed: exit 1. stdout JSON `status: ERROR`, `conversation_id` empty, `error: "authentication failed or timed out"`. stderr: `Authentication required. Please visit the URL to log in:` then a Google OAuth URL (redacted), `Waiting for authentication (timeout 60s)...`, `Or, paste the authorization code here and press Enter:`, `Error: authentication interrupted.`, `error: authentication failed or timed out`. Not the binary's `HeadlessAuthRequired` string.

8. **Usage.** `agy --not-a-real-flag` exits 2. stderr starts `flags provided but not defined: -not-a-real-flag` then the full `--help` text. Not `unexpected argument "Bioactives"` (that was a spaced positional). The current classifier looks for `unexpected argument` / `usage:`; this real first line would not match until a later product slice.

9. **Conversation id.** Present as `conversation_id` (UUID) on json envelopes and on every stream-json event except empty on the auth-failed json envelope. Redacted to `fixture-conversation-<case>` in this tree.

10. **Docker computer image.** Not live-tested (Q1 computer-image work is out of scope). From the image and supervisor: `infra/sandboxes/computer/Dockerfile` does not install `agy`. `HOME=/home/rakazo` is the portable volume; `start.sh` puts `$HOME/.local/bin` on `PATH`. If an operator later installs `agy` and signs in under that home, both the binary and `~/.gemini` would survive computer replacement. As shipped, `agy` is unavailable inside the image.

## `--mode` pick

Keep `accept-edits` (already the space-settings default). It is the only mode whose tool behavior was observed. Plan-mode tool access is unobserved.

## Cases

| Folder | Observed? | Notes |
| --- | --- | --- |
| `json-format` | yes | json envelope, no schema, `--disable-slash-commands` |
| `completed-plan-mode` | yes | stream-json, schema-bound findings, no tools |
| `read-file-denied` | yes | accept-edits; `read_file` denied; no `structured_output` |
| `permission-denied` | yes | `search_web` ran; `read_url` denied |
| `run-command` | yes | `command` denied |
| `schema-enforced` | yes | final structured turn matched; no printed violation |
| `timed-out-partial` | yes | exit 0, `[agy] print timeout after 5s...` |
| `usage-exit-2` | yes | exit 2, unknown flag |
| `auth-required` | yes | empty HOME |
| `completed-synthetic` | no | sourced findings need a denied read |
| `schema-violation-synthetic` | no | non-matching final turn not seen |
| `quota-exhausted-synthetic` | no | would exhaust the account |
| `crash-no-exit-code-synthetic` | no | wrapper condition, not an agy message |
| `oversize-events-synthetic` | no | generated in memory by the emulator |
