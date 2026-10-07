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
    set +e
    # The lane shows what the model says and which tools it calls, as it goes.
    cli "${args[@]}" < "$prompt_file" | tee "$events" | jq -r --unbuffered '
      select(.type == "assistant") | .message.content[]?
      | if .type == "text" then .text elif .type == "tool_use" then "  > " + .name else empty end' 2>/dev/null
    code=${PIPESTATUS[0]}
    set -e
    result=$(jq -c 'select(.type == "result")' "$events" 2>/dev/null | tail -n 1)
    # Did the model itself say anything? (The CLI words its own errors as a
    # message of a model named "<synthetic>".)
    worked=$(jq -c 'select(.type == "assistant" and (.message.model // "") != "<synthetic>")' "$events" 2>/dev/null | head -c 1)
    failed=
    if [ -z "$result" ]; then
      failed=1
      echo "The CLI ended without a result (exit code $code)." > "$body"
      contract_usage '{}'
    else
      [ "$(jq -r '.is_error' <<<"$result")" != true ] || failed=1
      jq -r '.result // "The CLI returned no text."' <<<"$result" > "$body"
      # Sums over every model the session used; the main one is the costliest.
      contract_usage "$(jq -c '
        (.modelUsage // {}) as $m
        | {tokens_in: ([$m[].inputTokens] | add), tokens_out: ([$m[].outputTokens] | add),
           tokens_cache: ([$m[].cacheReadInputTokens] | add), tokens_cache_write: ([$m[].cacheCreationInputTokens] | add),
           cost_usd: .total_cost_usd}
        + (if ($m | length) > 0 then {model: ($m | to_entries | max_by(.value.costUSD) | .key)} else {} end)
        | .tokens_total = ((.tokens_in // 0) + (.tokens_out // 0) + (.tokens_cache // 0) + (.tokens_cache_write // 0))' <<<"$result")"
    fi
    # An error before the model produced anything (model gone, quota reached,
    # CLI not signed in) is "cannot start now": the dispatcher takes the
    # declared fallback. An error after it has worked is a failure.
    if [ -n "$failed" ]; then
      if [ -z "$worked" ]; then code=2; elif [ "$code" = 0 ]; then code=1; fi
    fi
    contract_report claude "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | version | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
