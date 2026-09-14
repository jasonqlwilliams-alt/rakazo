#!/usr/bin/env bash
# Capture redacted agy print-mode fixtures for the research adapter.
# Runs only inside this worktree's .tmp scratch. Does not change agy
# settings, permissions, hooks, MCP servers, plugins, or projects.
# Does not pass --dangerously-skip-permissions, --new-project, or --add-dir.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
EXPECTED_ROOT=$(pwd -P)
if [[ "$ROOT" != "$EXPECTED_ROOT" ]]; then
  echo "error: run from the worktree root ($EXPECTED_ROOT), not $ROOT" >&2
  exit 1
fi
case "$ROOT" in
  */.treehouse/*|*/worktrees/*|*/.orca/*) ;;
  *)
    echo "error: refusing to capture outside an isolated worktree: $ROOT" >&2
    exit 1
    ;;
esac

AGY=${AGY:-agy}
MODEL=${AGY_MODEL:-gemini-3.8-flash-low}
OUT="$ROOT/packages/adapters/src/testing/fixtures/agy-observed"
SCRATCH="$ROOT/.tmp/agy-capture"
REDACT="$ROOT/packages/adapters/src/testing/redact-agy-fixture.mjs"
VERSION=$("$AGY" --version | head -1 | tr -d '[:space:]')
CASES=${*:-usage-exit-2 auth-required json-format completed-plan-mode completed permission-denied schema-violation timed-out-partial run-command quota-exhausted-synthetic crash-no-exit-code-synthetic oversize-events-synthetic provider-error-synthetic unavailable-synthetic write-to-file-synthetic}

mkdir -p "$SCRATCH" "$OUT"
printf '%s\n' "$VERSION" >"$OUT/agy.version"

FINDINGS_SCHEMA=$(cat <<'JSON'
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "claims", "sources", "gaps", "applyNotes"],
  "properties": {
    "summary": { "type": "string" },
    "claims": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "label", "sourceIds"],
        "properties": {
          "text": { "type": "string" },
          "label": { "enum": ["confirmed", "inference"] },
          "sourceIds": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "sources": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "kind", "locator"],
        "properties": {
          "id": { "type": "string" },
          "kind": { "enum": ["url", "file"] },
          "locator": { "type": "string" },
          "title": { "type": "string" },
          "retrievedAt": { "type": "string" }
        }
      }
    },
    "gaps": { "type": "array", "items": { "type": "string" } },
    "applyNotes": { "type": "array", "items": { "type": "string" } }
  }
}
JSON
)

VIOLATION_SCHEMA=$(cat <<'JSON'
{
  "type": "object",
  "additionalProperties": false,
  "required": ["mustEqualZYX"],
  "properties": {
    "mustEqualZYX": { "const": "ZYX" }
  }
}
JSON
)

record_and_run() {
  local case_name=$1 mode=$2 format=$3 timeout=$4 schema_kind=$5
  local brief=$6
  local dest="$OUT/$case_name"
  if [[ -f "$dest/exit.code" && "${FORCE:-}" != "1" ]]; then
    echo "skip $case_name (already captured; FORCE=1 to redo)"
    return 0
  fi
  local work="$SCRATCH/$case_name"
  rm -rf "$work"
  mkdir -p "$work"
  if [[ "$schema_kind" == "findings" ]]; then
    printf '%s\n' "$FINDINGS_SCHEMA" >"$work/findings.schema.json"
  elif [[ "$schema_kind" == "violation" ]]; then
    printf '%s\n' "$VIOLATION_SCHEMA" >"$work/findings.schema.json"
  fi

  local -a cmd=("$AGY" "--print=$brief" "--output-format=$format")
  if [[ "$schema_kind" != "none" ]]; then
    cmd+=("--json-schema=findings.schema.json")
  fi
  cmd+=("--model=$MODEL" "--effort=low" "--mode=$mode" "--sandbox" "--print-timeout=$timeout" "--log-file=agy.log")

  local env_home=${CAPTURE_HOME:-$HOME}
  echo "run $case_name format=$format mode=$mode timeout=$timeout schema=$schema_kind" >&2
  set +e
  (
    cd "$work"
    env HOME="$env_home" timeout --preserve-status 180s "${cmd[@]}" </dev/null
  ) >"$work/events.raw" 2>"$work/stderr.raw"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$work/exit.code"

  mkdir -p "$dest"
  node "$REDACT" "$case_name" "$work/events.raw" "$work/stderr.raw" "$dest/events.ndjson" "$dest/stderr.log"
  cp "$work/exit.code" "$dest/exit.code"
  python3 - "$dest/meta.json" "$case_name" "$VERSION" "$MODEL" "$mode" "$format" "$timeout" "$schema_kind" "$code" <<'PY'
import json, sys
path, case, version, model, mode, fmt, timeout, schema, code = sys.argv[1:]
json.dump(
    {
        "case": case,
        "agyVersion": version,
        "model": model,
        "mode": mode,
        "outputFormat": fmt,
        "printTimeout": timeout,
        "jsonSchema": schema,
        "exitCode": int(code),
        "cwd": "worktree-.tmp-agy-capture",
        "observed": True,
        "argv": [
            "agy",
            "--print=<brief>",
            f"--output-format={fmt}",
            *( ["--json-schema=findings.schema.json"] if schema != "none" else [] ),
            f"--model={model}",
            "--effort=low",
            f"--mode={mode}",
            "--sandbox",
            f"--print-timeout={timeout}",
            "--log-file=agy.log",
        ],
    },
    open(path, "w"),
    indent=2,
)
print()
PY
}

write_synthetic() {
  local case_name=$1 reason=$2
  local dest="$OUT/${case_name}"
  mkdir -p "$dest"
  printf '%s\n' "$reason" >"$dest/reason.txt"
  python3 - "$dest/meta.json" "$case_name" "$VERSION" "$reason" <<'PY'
import json, sys
path, case, version, reason = sys.argv[1:]
json.dump(
    {
        "case": case,
        "agyVersion": version,
        "observed": False,
        "reason": reason,
    },
    open(path, "w"),
    indent=2,
)
PY
}

BRIEF_PLAN='Do not use tools. Do not search the web, fetch URLs, run commands, or write files. Return only a findings JSON document: summary "example.com is a reserved documentation domain", claims [{text:"example.com is reserved for documentation", label:"inference", sourceIds:[]}], sources [], gaps ["No live page was read"], applyNotes ["Nothing to apply"].'

BRIEF_ACCEPT='Stay inside the current directory. Write a file named note.txt containing the word hi. Do not search the web, fetch URLs, or run shell commands. Then return a findings JSON document citing that file as source id s1 kind file locator note.txt, with one confirmed claim that note.txt contains hi, empty gaps, and applyNotes ["The file write succeeded"].'

BRIEF_DENY='You must try these tools in order and record what happened for each: search_web query "IANA example.com", read_url_content https://example.com/, run_command echo hi, write_to_file /etc/agy-capture-forbidden.txt with the word no. Do not use --dangerously-skip-permissions. Then return a findings JSON document. If no source was read, leave sources empty and list each denial under gaps.'

BRIEF_JSON='Do not use tools. Reply with exactly {"ok":true} and nothing else.'

BRIEF_VIOLATION='Do not use tools. Return exactly this JSON object and no other keys: {"summary":"hello","claims":[],"sources":[],"gaps":[],"applyNotes":[]}.'

BRIEF_TIMEOUT='Before any final answer, use search_web at least thirty times with different queries about the history of computing, then read ten URLs. Keep working until the session ends. Do not return early.'

BRIEF_COMMAND='Run exactly one command: echo hi. Do not search the web, fetch URLs, or write files. Then stop.'

for case_name in $CASES; do
  case "$case_name" in
    usage-exit-2)
      dest="$OUT/usage-exit-2"
      if [[ -f "$dest/exit.code" && "${FORCE:-}" != "1" ]]; then
        echo "skip usage-exit-2"
        continue
      fi
      work="$SCRATCH/usage-exit-2"
      rm -rf "$work"
      mkdir -p "$work"
      set +e
      env HOME="$HOME" timeout --preserve-status 30s "$AGY" --not-a-real-flag </dev/null >"$work/events.raw" 2>"$work/stderr.raw"
      code=$?
      set -e
      printf '%s\n' "$code" >"$work/exit.code"
      mkdir -p "$dest"
      node "$REDACT" usage-exit-2 "$work/events.raw" "$work/stderr.raw" "$dest/events.ndjson" "$dest/stderr.log"
      cp "$work/exit.code" "$dest/exit.code"
      python3 - "$dest/meta.json" "$VERSION" "$code" <<'PY'
import json, sys
path, version, code = sys.argv[1:]
json.dump(
    {
        "case": "usage-exit-2",
        "agyVersion": version,
        "observed": True,
        "exitCode": int(code),
        "argv": ["agy", "--not-a-real-flag"],
    },
    open(path, "w"),
    indent=2,
)
PY
      ;;
    auth-required)
      dest="$OUT/auth-required"
      if [[ -f "$dest/exit.code" && "${FORCE:-}" != "1" ]]; then
        echo "skip auth-required"
        continue
      fi
      empty="$SCRATCH/empty-home"
      work="$SCRATCH/auth-required"
      rm -rf "$empty" "$work"
      mkdir -p "$empty" "$work"
      set +e
      env HOME="$empty" timeout --preserve-status 25s "$AGY" --print="Do not use tools. Reply ok." --output-format=json --print-timeout=20s --sandbox --disable-slash-commands </dev/null >"$work/events.raw" 2>"$work/stderr.raw"
      code=$?
      set -e
      printf '%s\n' "$code" >"$work/exit.code"
      mkdir -p "$dest"
      node "$REDACT" auth-required "$work/events.raw" "$work/stderr.raw" "$dest/events.ndjson" "$dest/stderr.log"
      cp "$work/exit.code" "$dest/exit.code"
      python3 - "$dest/meta.json" "$VERSION" "$code" <<'PY'
import json, sys
path, version, code = sys.argv[1:]
json.dump(
    {
        "case": "auth-required",
        "agyVersion": version,
        "observed": True,
        "exitCode": int(code),
        "home": "empty",
        "argv": ["agy", "--print=Do not use tools. Reply ok.", "--output-format=json", "--print-timeout=20s", "--sandbox", "--disable-slash-commands"],
    },
    open(path, "w"),
    indent=2,
)
PY
      ;;
    json-format)
      record_and_run json-format plan json 45s none "$BRIEF_JSON"
      ;;
    completed-plan-mode)
      record_and_run completed-plan-mode plan stream-json 90s findings "$BRIEF_PLAN"
      ;;
    completed)
      record_and_run completed accept-edits stream-json 90s findings "$BRIEF_ACCEPT"
      ;;
    permission-denied)
      record_and_run permission-denied accept-edits stream-json 90s findings "$BRIEF_DENY"
      ;;
    schema-violation)
      record_and_run schema-violation plan stream-json 90s violation "$BRIEF_VIOLATION"
      ;;
    timed-out-partial)
      record_and_run timed-out-partial plan stream-json 5s findings "$BRIEF_TIMEOUT"
      ;;
    run-command)
      record_and_run run-command accept-edits stream-json 60s none "$BRIEF_COMMAND"
      ;;
    quota-exhausted-synthetic)
      write_synthetic quota-exhausted-synthetic "Not observed: exhausting the signed-in account quota would spend more than a few small runs. Keep using the synthetic classifier fixture until a real 429 is captured."
      ;;
    crash-no-exit-code-synthetic)
      write_synthetic crash-no-exit-code-synthetic "Not observed: a mid-print SIGKILL would still create a conversation on the account and the missing exit.code is a harness-wrapper condition, not an agy message."
      ;;
    oversize-events-synthetic)
      write_synthetic oversize-events-synthetic "Not observed as a file: an events stream over 8 MiB does not belong in the repository. The emulator generates this case in memory."
      ;;
    provider-error-synthetic)
      write_synthetic provider-error-synthetic "Not observed: none of the small print runs printed a generic fatal error: line distinct from auth, usage, quota, or timeout."
      ;;
    unavailable-synthetic)
      write_synthetic unavailable-synthetic "Not an agy message. The harness writes this when the configured executable is missing (exit 127). No live agy run produces it."
      ;;
    write-to-file-synthetic)
      write_synthetic write-to-file-synthetic "Not observed: the model did not call write_to_file in the small print runs. The /etc path in the permission-denied brief was never written."
      ;;
    *)
      echo "unknown case: $case_name" >&2
      exit 2
      ;;
  esac
done
