#!/usr/bin/env bash
# Adapter for the Claude Code CLI. Contract: lib/contract.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/contract.sh"
. "$here/../lib/common.sh"
. "$here/../lib/tracker/adapters/env.sh"
tracker_unset=()
for tracker_secret in "${TRACKER_SECRET_ENV[@]}"; do tracker_unset+=(-u "$tracker_secret"); done

agent_user=$(conf_get security agent_user)
verify_agent_account
agent_home=
[ -z "$agent_user" ] || agent_home=$(getent passwd "$agent_user" | cut -d: -f6)
# The subscription pays, never an API key: a key left in the environment
# (for instance after loading .env.local) would move the billing to it.
# No forge credential either (lib/common.sh, forge_harness_unset): the
# dispatcher pushes and opens pull requests, never the model.
# CLI_LIMIT (for instance `timeout 120`) is put in front of the program
# itself, inside the command: `timeout cli` cannot work, timeout runs
# programs and cli is a function of this shell (it exited 127, and no model
# was ever said available). Under the agents' account it runs as that account,
# so that what it stops (bubblewrap, the CLI and its children) is its own.
CLI_LIMIT=()
cli() {
  forge_harness_unset
  if [ -n "$agent_user" ] && [ "$(id -un)" != "$agent_user" ]; then
    agent_mount_args
    agent_prefix=("${AGENT_MOUNT_ARGS[@]}")
    [ "${#agent_prefix[@]}" = 0 ] || agent_prefix+=(--)
    sudo -n -u "$agent_user" -- env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN "${FORGE_UNSET[@]}" "${tracker_unset[@]}" \
      PATH="$agent_home/.local/bin:/usr/local/bin:/usr/bin:/bin" ORCH_REPO="$ORCH_REPO" ORCH_STATE_DIR="$ORCH_STATE_DIR" ORCH_CONF="$ORCH_CONF" "${CLI_LIMIT[@]}" "${agent_prefix[@]}" claude "$@"
  else
    env -u ANTHROPIC_API_KEY -u GH_TOKEN -u GITHUB_TOKEN "${FORGE_UNSET[@]}" "${tracker_unset[@]}" "${CLI_LIMIT[@]}" claude "$@"
  fi
}

case "${1:-}" in
  list-models)
    shift
    # The CLI has no command that lists models: each candidate is asked for
    # one word, from an empty directory and without tools.
    empty=$(contract_probe_dir)
    [ -z "$agent_user" ] || chmod 755 "$empty"
    trap 'rm -rf "$empty"' EXIT
    # timeout puts the CLI in a process group of its own: stdin from
    # nowhere, so that it never waits stopped on a terminal it cannot read.
    CLI_LIMIT=(timeout -k 10 120)
    for candidate in "$@"; do
      if out=$(cd "$empty" && cli -p --model "$candidate" --no-session-persistence \
          --strict-mcp-config --tools "" --output-format json 'Reply with the single word OK.' < /dev/null 2>/dev/null) \
        && [ "$(jq -r '.is_error' <<<"$out" 2>/dev/null)" = false ]; then
        echo "$candidate"
      fi
    done
    ;;
  probe)
    # The real CLI, started by cli() as a run starts it (under the agents'
    # account through sudo and bubblewrap, without API key nor forge and
    # tracker credentials), asked one word from an empty folder: no tools,
    # no connectors, no helper model, no session kept. The question is the
    # cost; the budget is only a guard behind it.
    model=${2:-}
    [ -n "$model" ] || { echo "usage: claude.sh probe <model>" >&2; exit 64; }
    empty=$(contract_probe_dir) err=$(mktemp)
    [ -z "$agent_user" ] || chmod 755 "$empty"
    trap 'rm -rf "$empty" "$err"' EXIT
    limit=$(contract_probe_timeout)
    CLI_LIMIT=(timeout -k 10 "$limit")
    set +e
    out=$(cd "$empty" && cli -p --model "$model" --no-session-persistence --strict-mcp-config --tools "" \
      --settings '{"advisorModel":""}' --max-budget-usd 0.5 --output-format json "$CONTRACT_PROBE_PROMPT" < /dev/null 2> "$err")
    code=$?
    set -e
    # Read as a stream of JSON values, whatever their line breaks; a line
    # that is not JSON (a warning on stdout) breaks the stream: then each
    # line is read on its own.
    result=$(jq -c 'select(type == "object" and .type == "result")' <<<"$out" 2>/dev/null | tail -n 1) || true
    [ -n "$result" ] || result=$(jq -R -c 'fromjson? | select(type == "object" and .type == "result")' <<<"$out" 2>/dev/null | tail -n 1)
    if [ "$code" = 124 ] || [ "$code" = 137 ]; then
      contract_probe_fail "$model" "no answer within ${limit}s"
    elif [ -z "$result" ]; then
      reason=$({ cat "$err"; printf '%s\n' "$out"; } | contract_probe_reason)
      contract_probe_fail "$model" "${reason:-the CLI ended without an answer (exit $code)}"
    elif [ "$(jq -r '.is_error' <<<"$result")" != false ]; then
      reason=$(jq -r '.result // .subtype // empty' <<<"$result" | contract_probe_reason)
      contract_probe_fail "$model" "${reason:-the CLI reported an error (exit $code)}"
    else
      contract_probe_answer "$model" "$(jq -r '.result // ""' <<<"$result")"
    fi
    ;;
  version)
    contract_npm_version claude "${ADAPTER_PACKAGE:-}" "$(cli --version 2>/dev/null | awk '{print $1}')"
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
    [ "${ORCH_ADVISOR:-}" = no ] && args+=(--settings '{"advisorModel":""}')
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
      # Folders the role may read beyond its own worktree, and those only.
      while IFS= read -r folder; do [ -n "$folder" ] && allowed+=("Read(/$folder/**)"); done \
        < <(tr ',' '\n' <<<"${ORCH_READ:-}" | sed 's/^ *//; s/ *$//')
      for tool in ${ADAPTER_DENY_TOOLS:-}; do denied+=("$tool"); done
      case "$ORCH_PERMISSION_MODE" in
        accept-edits) args+=(--permission-mode acceptEdits) ;;
        read-only) denied+=(Edit Write NotebookEdit) ;;
        *) echo "unknown permission mode: $ORCH_PERMISSION_MODE" >&2; exit 64 ;;
      esac
      [ ${#allowed[@]} -gt 0 ] && args+=(--allowedTools "${allowed[@]}")
      [ ${#denied[@]} -gt 0 ] && args+=(--disallowedTools "${denied[@]}")
    fi
    # What the session may still cost (the cap of its ticket, less what was
    # spent): the CLI stops by itself there.
    [ -z "${ORCH_BUDGET_USD:-}" ] || args+=(--max-budget-usd "$ORCH_BUDGET_USD")
    [ "${ADAPTER_CONNECTORS:-}" = none ] && args+=(--strict-mcp-config)
    [ -n "${ORCH_TEXT_ONLY:-}" ] && args+=(--tools "" --no-session-persistence)
    # Without the helper model: only its setting removes it (tried: refusing
    # the tool by name leaves it there).
    [ "${ORCH_ADVISOR:-}" = no ] && args+=(--settings '{"advisorModel":""}')
    set +e
    # The lane shows, as it goes, what the model says, what it thinks, and
    # what each of its actions is about (the reason it gave for a command,
    # else the command; the file, from the folder it works in), one line an
    # action. What a helper it called says is left out.
    cli "${args[@]}" < "$prompt_file" | tee "$events" | jq -R -r --unbuffered --arg here "$PWD/" '
      def line: gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "");
      def short: line | if length > 160 then .[0:157] + "…" else . end;
      def file: (. // "") | if startswith($here) then .[($here | length):] else . end;
      fromjson? | select(.type == "assistant" and (.parent_tool_use_id // null) == null) | .message.content[]?
      | if .type == "text" then .text
        elif .type == "thinking" then ((.thinking // "") | short | select(. != "") | "  (thinking) " + .)
        elif .type == "tool_use" then
          (.input // {}) as $in
          | (if ($in.description // "") != "" then ($in.description | short)
             elif ($in.command // "") != "" then ($in.command | split("\n")[0] | short)
             elif ($in.file_path // "") != "" then ($in.file_path | file)
             elif ($in.pattern // "") != "" then ($in.pattern | short) + (if ($in.path // "") != "" then " (" + ($in.path | file) + ")" else "" end)
             elif ($in.prompt // "") != "" then ($in.prompt | short)
             else "" end) as $about
          | "  > " + .name + (if $about != "" then " : " + $about else "" end)
        else empty end' 2>/dev/null
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
      # (The messages of a sub-agent are in the stream too: only the main thread counts.)
      wrote=$(jq -R -r 'fromjson? | select(.type == "assistant" and (.parent_tool_use_id // null) == null) | .message.model // empty | select(. != "<synthetic>")' "$events" 2>/dev/null | sort | uniq -c | sort -rn | awk 'NR == 1 {print $2}')
      # Where the subscription stands, as the session said it last (a CLI on
      # a subscription says it; one on a key says nothing): each window with
      # the percent used and when it starts over. Kept by whoever ran this.
      limits=$(jq -R -c 'fromjson? | select(.type == "rate_limit_event") | .rate_limit_info' "$events" 2> /dev/null | tail -n 1 \
        | jq -c '{windows: ((.unifiedWindows // {}) | with_entries(select((.value.utilization | type) == "number" and (.value.resetsAt | type) == "number") | .value = {used: (.value.utilization * 100 | round), resets_at: (.value.resetsAt | todate)})), beyond: (.overageStatus // null)} | select((.windows | length) > 0)' 2> /dev/null || true)
      contract_usage "$(jq -c --arg wrote "$wrote" --argjson limits "${limits:-null}" '
        (.modelUsage // {}) as $m
        | {tokens_in: ([$m[].inputTokens] | add), tokens_out: ([$m[].outputTokens] | add),
           tokens_cache: ([$m[].cacheReadInputTokens] | add), tokens_cache_write: ([$m[].cacheCreationInputTokens] | add),
           cost_usd: .total_cost_usd}
        + (if $wrote != "" then {model: $wrote} elif ($m | length) > 0 then {model: ($m | to_entries | max_by(.value.costUSD) | .key)} else {} end)
        + (if $wrote != "" then {helpers: [$m | to_entries[] | select(.key != $wrote) | {model: .key, cost_usd: .value.costUSD}]} else {} end)
        | .tokens_total = ((.tokens_in // 0) + (.tokens_out // 0) + (.tokens_cache // 0) + (.tokens_cache_write // 0))
        | . + (if $limits then {limits: $limits} else {} end)' <<<"$result")"
    fi
    # An error the CLI reports before the model produced anything (model
    # gone, quota reached, not signed in) is "cannot start now": the
    # dispatcher takes the declared fallback. An error after the model has
    # worked is a failure.
    if [ -n "$refused" ]; then
      if [ "$worked" = 0 ]; then code=2; elif [ "$code" = 0 ]; then code=1; fi
    fi
    # Stopped by its budget: neither a failure nor a refusal. Said with a
    # code of its own (5): what it committed is still sent, and it is not
    # run again as a session that stopped short.
    if [ -n "$result" ] && [ "$(jq -r '.subtype // ""' <<<"$result")" = error_max_budget_usd ]; then
      code=5
      echo "The session stopped: its ticket cost cap was reached. Its committed work remains." > "$body"
    fi
    contract_report claude "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | probe <model> | version | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
