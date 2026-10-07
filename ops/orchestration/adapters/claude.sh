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
  run)
    shift
    contract_parse_run "$@"
    events=$(mktemp) body=$(mktemp)
    trap 'rm -f "$events" "$body"' EXIT
    args=(-p --model "$model" --output-format stream-json --verbose)
    [ -n "${ADAPTER_PERMISSION_MODE:-}" ] && args+=(--permission-mode "$ADAPTER_PERMISSION_MODE")
    [ -n "${ORCH_TEXT_ONLY:-}" ] && args+=(--tools "" --strict-mcp-config --no-session-persistence)
    set +e
    # The lane shows what the model says and which tools it calls, as it goes.
    cli "${args[@]}" < "$prompt_file" | tee "$events" | jq -r --unbuffered '
      select(.type == "assistant") | .message.content[]?
      | if .type == "text" then .text elif .type == "tool_use" then "  > " + .name else empty end' 2>/dev/null
    code=${PIPESTATUS[0]}
    set -e
    result=$(jq -c 'select(.type == "result")' "$events" 2>/dev/null | tail -n 1)
    if [ -z "$result" ]; then
      [ "$code" = 0 ] && code=1
      echo "The CLI ended without a result (exit code $code)." > "$body"
      contract_usage '{}'
    else
      [ "$(jq -r '.is_error' <<<"$result")" = true ] && [ "$code" = 0 ] && code=1
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
    contract_report claude "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
