#!/usr/bin/env bash
# Adapter for the Claude Code CLI. Contract: lib/contract.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/contract.sh"

# The subscription pays, never an API key: a key left in the environment
# (for instance after loading .env.local) would move the billing to it.
cli() { env -u ANTHROPIC_API_KEY claude "$@"; }

case "${1:-}" in
  list-models)
    shift
    # The CLI has no command that lists models: each candidate is asked for
    # one word, from an empty directory and without tools.
    empty=$(mktemp -d)
    trap 'rm -rf "$empty"' EXIT
    for candidate in "$@"; do
      if out=$(cd "$empty" && timeout 120 env -u ANTHROPIC_API_KEY claude -p --model "$candidate" --no-session-persistence \
          --strict-mcp-config --tools "" --output-format json 'Reply with the single word OK.' 2>/dev/null) \
        && [ "$(jq -r '.is_error' <<<"$out" 2>/dev/null)" = false ]; then
        echo "$candidate"
      fi
    done
    ;;
  version)
    contract_npm_version claude "${ADAPTER_PACKAGE:-}" "$(claude --version 2>/dev/null | awk '{print $1}')"
    ;;
  talk)
    shift
    model= prompt_file= session=
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) model=$2 ;;
        --prompt-file) prompt_file=$2 ;;
        --session-id) session=$2 ;;
        *) echo "talk: unknown option $1" >&2; exit 64 ;;
      esac
      shift 2
    done
    [ -n "$model" ] && [ -f "$prompt_file" ] || { echo "usage: claude.sh talk --model <id> --prompt-file <file> [--session-id <uuid>]" >&2; exit 64; }
    # With the user at the screen, a tool that is not allowed would be asked
    # for, and one "yes" too many would be an action: nothing is asked, what
    # the lists do not name is refused. Reading is limited to the folders of
    # ORCH_READ_DIRS (the current one when unset), files of secrets left out;
    # the search tools, which read anywhere once allowed, are not offered.
    allowed=() denied=(Write NotebookEdit "Read(//**/.env*)")
    while IFS= read -r dir; do [ -n "$dir" ] && allowed+=("Read(/$dir/**)"); done < <(tr ':' '\n' <<<"${ORCH_READ_DIRS:-$PWD}")
    while IFS= read -r prefix; do [ -n "$prefix" ] && allowed+=("Bash($prefix)" "Bash($prefix *)"); done \
      < <(tr ',' '\n' <<<"${ORCH_ALLOW:-}" | sed 's/^ *//; s/ *$//')
    while IFS= read -r prefix; do [ -n "$prefix" ] && denied+=("Bash($prefix)" "Bash($prefix *)"); done \
      < <(tr ',' '\n' <<<"${ORCH_DENY:-}" | sed 's/^ *//; s/ *$//')
    for tool in ${ADAPTER_DENY_TOOLS:-}; do denied+=("$tool"); done
    args=(--model "$model" --permission-mode dontAsk)
    if [ -n "${ORCH_EDIT_ONLY:-}" ]; then
      allowed+=("Edit(/$ORCH_EDIT_ONLY)")
      args+=(--add-dir "$(dirname "$(dirname "$ORCH_EDIT_ONLY")")")
    else
      denied+=(Edit)
    fi
    args+=(--allowedTools "${allowed[@]}" --disallowedTools "${denied[@]}")
    [ "${ADAPTER_CONNECTORS:-}" = none ] && args+=(--strict-mcp-config)
    [ -n "$session" ] && args+=(--session-id "$session")
    cli "${args[@]}" "$(cat "$prompt_file")"
    exit $?
    ;;
  run)
    shift
    contract_parse_run "$@"
    events=$(mktemp) body=$(mktemp)
    trap 'rm -f "$events" "$body"' EXIT
    args=(-p --model "$model" --output-format stream-json --verbose)
    # Without a screen, a tool that is not allowed is refused, not asked for:
    # the list of allowed commands is the limit. The refusals are stated too.
    if [ -n "${ORCH_PERMISSION_MODE:-}" ]; then
      allowed=() denied=()
      while IFS= read -r prefix; do [ -n "$prefix" ] && allowed+=("Bash($prefix)" "Bash($prefix *)"); done \
        < <(tr ',' '\n' <<<"${ORCH_ALLOW:-}" | sed 's/^ *//; s/ *$//')
      while IFS= read -r prefix; do [ -n "$prefix" ] && denied+=("Bash($prefix)" "Bash($prefix *)"); done \
        < <(tr ',' '\n' <<<"${ORCH_DENY:-}" | sed 's/^ *//; s/ *$//')
      for tool in ${ADAPTER_DENY_TOOLS:-}; do denied+=("$tool"); done
      case "$ORCH_PERMISSION_MODE" in
        accept-edits) args+=(--permission-mode acceptEdits) ;;
        read-only) denied+=(Edit Write NotebookEdit) ;;
        *) echo "unknown permission mode: $ORCH_PERMISSION_MODE" >&2; exit 64 ;;
      esac
      [ ${#allowed[@]} -gt 0 ] && args+=(--allowedTools "${allowed[@]}")
      [ ${#denied[@]} -gt 0 ] && args+=(--disallowedTools "${denied[@]}")
    fi
    [ "${ADAPTER_CONNECTORS:-}" = none ] && args+=(--strict-mcp-config)
    [ -n "${ORCH_TEXT_ONLY:-}" ] && args+=(--tools "" --no-session-persistence)
    # Without the helper model: only its setting removes it (tried: refusing
    # the tool by name leaves it there).
    [ "${ORCH_ADVISOR:-}" = no ] && args+=(--settings '{"advisorModel":""}')
    set +e
    # The lane shows what the model says and which tools it calls, as it goes.
    cli "${args[@]}" < "$prompt_file" | tee "$events" | jq -R -r --unbuffered '
      fromjson? | select(.type == "assistant") | .message.content[]?
      | if .type == "text" then .text elif .type == "tool_use" then "  > " + .name else empty end' 2>/dev/null
    code=${PIPESTATUS[0]}
    set -e
    # Each line is read on its own: one cut short (a CLI stopped while
    # writing) does not hide the lines after it.
    result=$(jq -R -c 'fromjson? | select(.type == "result")' "$events" 2>/dev/null | tail -n 1)
    # Did the model itself say anything? (The CLI words its own errors as a
    # message of a model named "<synthetic>".)
    # Counted to the end: cutting the reading short would end this script
    # on a broken pipe, before its report, as soon as the session is long.
    worked=$(jq -R -c 'fromjson? | select(.type == "assistant" and (.message.model // "") != "<synthetic>") | 1' "$events" 2>/dev/null | grep -c . || true)
    refused=
    if [ -z "$result" ]; then
      # Killed or crashed: a failure, whatever it had done. Never a fallback.
      [ "$code" != 0 ] || code=1
      echo "The CLI ended without a result (exit code $code)." > "$body"
      contract_usage '{}'
    else
      [ "$(jq -r '.is_error' <<<"$result")" != true ] || refused=1
      jq -r '.result // "The CLI returned no text."' <<<"$result" > "$body"
      # The model of the run is the one that wrote its messages, not a helper
      # it consulted (which may well cost more): what helpers cost is kept
      # apart. Tokens and cost are summed over every model the session used.
      wrote=$(jq -R -r 'fromjson? | select(.type == "assistant") | .message.model // empty | select(. != "<synthetic>")' "$events" 2>/dev/null | sort | uniq -c | sort -rn | awk 'NR == 1 {print $2}')
      contract_usage "$(jq -c --arg wrote "$wrote" '
        (.modelUsage // {}) as $m
        | {tokens_in: ([$m[].inputTokens] | add), tokens_out: ([$m[].outputTokens] | add),
           tokens_cache: ([$m[].cacheReadInputTokens] | add), tokens_cache_write: ([$m[].cacheCreationInputTokens] | add),
           cost_usd: .total_cost_usd}
        + (if $wrote != "" then {model: $wrote} elif ($m | length) > 0 then {model: ($m | to_entries | max_by(.value.costUSD) | .key)} else {} end)
        + (if $wrote != "" then {helpers: [$m | to_entries[] | select(.key != $wrote) | {model: .key, cost_usd: .value.costUSD}]} else {} end)
        | .tokens_total = ((.tokens_in // 0) + (.tokens_out // 0) + (.tokens_cache // 0) + (.tokens_cache_write // 0))' <<<"$result")"
    fi
    # An error the CLI reports before the model produced anything (model
    # gone, quota reached, not signed in) is "cannot start now": the
    # dispatcher takes the declared fallback. An error after the model has
    # worked is a failure.
    if [ -n "$refused" ]; then
      if [ "$worked" = 0 ]; then code=2; elif [ "$code" = 0 ]; then code=1; fi
    fi
    contract_report claude "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | version | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
