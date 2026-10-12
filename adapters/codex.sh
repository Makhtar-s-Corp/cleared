#!/usr/bin/env bash
# Adapter for the Codex CLI. Contract: lib/contract.sh.
#
# Host execution is the default. A project can still select its own container
# task script with [adapter.codex] runner = container.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/contract.sh"

runner=${ADAPTER_RUNNER:-host}
case "$runner" in host | container) ;; *) echo "codex: unknown runner: $runner (use host or container)" >&2; exit 64 ;; esac

# Codex profiles enforce filesystem and command-network boundaries. A linked
# worktree keeps Git metadata in its main checkout; a role allowed to commit
# needs that metadata writable in addition to the lane's files.
host_permissions() {
  local mode=${ORCH_PERMISSION_MODE:-read-only} network=${ORCH_NETWORK:-no} parent path key joined= gitdir common branch
  local paths=() denies=() entries=('":tmpdir"="deny"' '":slash_tmp"="deny"')
  case "$mode" in read-only) parent=:read-only ;; accept-edits) parent=:workspace ;; *) echo "codex: unknown permission mode: $mode" >&2; return 64 ;; esac
  case "$network" in yes) network=true ;; no) network=false ;; *) echo "codex: unknown network permission: $network" >&2; return 64 ;; esac
  if [ "$mode" = accept-edits ] && [[ ",${ORCH_ALLOW:-}," == *"git commit"* ]]; then
    gitdir=$(git rev-parse --absolute-git-dir)
    common=$(git rev-parse --path-format=absolute --git-common-dir)
    branch=$(git symbolic-ref -q --short HEAD) || { echo 'codex: a commit-capable lane needs a branch' >&2; return 64; }
    [[ "$branch" == */* ]] || { echo 'codex: a commit-capable lane needs a namespaced branch' >&2; return 64; }
    paths+=("$gitdir" "$common/objects" "$common/refs/heads/${branch%/*}" "$common/logs/refs/heads/${branch%/*}")
  fi
  gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null || true)
  codex_tmp=${gitdir:+$gitdir/cleared-tmp}
  codex_tmp=${codex_tmp:-$ORCH_STATE_DIR/tmp/codex-${ORCH_RUN_ID:-text}}
  mkdir -p "$codex_tmp"
  paths+=("$codex_tmp")
  while IFS= read -r path; do
    path=$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$path")
    [ -z "$path" ] || paths+=("$path")
  done < <(tr ',' '\n' <<<"${ORCH_WRITE:-}")
  [ -z "${ORCH_EDIT_ONLY:-}" ] || paths+=("$(dirname "$ORCH_EDIT_ONLY")")
  for path in "${CODEX_HOME:-$HOME/.codex}" "$HOME/.ssh" "$HOME/.config/gh" "$HOME/.config/git" "$HOME/.git-credentials" "$HOME/.gitconfig"; do
    [ ! -e "$path" ] && [ ! -L "$path" ] || denies+=("$path")
  done
  [[ ",${ORCH_WRITE:-}," == *"${ORCH_STATE_DIR}"* ]] || denies+=("$ORCH_STATE_DIR")
  for path in "${paths[@]}"; do
    [ -n "$path" ] || continue
    key=$(jq -Rn --arg path "$path" '$path')
    entries+=("$key=\"write\"")
  done
  for path in "${denies[@]}"; do
    key=$(jq -Rn --arg path "$path" '$path')
    entries+=("$key=\"deny\"")
  done
  for path in "${entries[@]}"; do joined+="${joined:+,}$path"; done
  key=$(jq -Rn --arg path "$PWD" '$path')
  codex_policy=(-c 'approval_policy="never"' -c 'default_permissions="cleared"'
    -c "projects.$key.trust_level=\"untrusted\""
    -c "permissions.cleared={extends=\"$parent\",filesystem={$joined},network={enabled=$network}}")
}

host_run() {
  local code usage_json
  . "$here/../lib/common.sh"
  events=$(mktemp) body=$(mktemp)
  trap 'rm -f "$events" "$body"' EXIT
  host_permissions || return $?
  if ! command -v codex >/dev/null 2>&1; then
    echo 'Codex did not start: codex is not installed on the host.' > "$body"
    contract_usage '{}'; contract_report codex 2 "$body"; return 2
  fi
  if [ -z "${ORCH_TEXT_ONLY:-}" ] && [ -n "${ORCH_LANE:-}" ]; then
    local wait_minutes deadline
    wait_minutes=$(conf_get lanes heavy_wait_minutes)
    [[ "$wait_minutes" =~ ^[0-9]+$ ]] || wait_minutes=30
    deadline=$(( $(date +%s) + wait_minutes * 60 ))
    mkdir -p "$ORCH_STATE_DIR"
    exec 8> "$ORCH_STATE_DIR/heavy.lock"
    while :; do
      if flock -n 8 && [ -z "$(find "$ORCH_STATE_DIR/checks-starting" -mmin -2 2>/dev/null)" ] \
        && [ "$("$ORCH_HOME/host-state.sh" 2>/dev/null | jq -r '.free_for_a_ci_run // false')" = true ]; then break; fi
      flock -u 8 || true
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo 'Codex did not start: the host stayed busy for the configured heavy-command wait.' > "$body"
        contract_usage '{}'; contract_report codex 2 "$body"; return 2
      fi
      sleep 20
    done
    export CLEARED_HEAVY_SLOT="$ORCH_STATE_DIR/heavy.lock"
  fi
  local args=(exec --json --model "$model" --output-last-message "$body" --ignore-user-config "${codex_policy[@]}")
  [ -z "${ORCH_TEXT_ONLY:-}" ] || args+=(--ephemeral)
  set +e
  env -u OPENAI_API_KEY -u GH_TOKEN -u GITHUB_TOKEN -u LINEAR_API_KEY -u LINEAR_APP_CLIENT_ID -u LINEAR_APP_CLIENT_SECRET -u SSH_AUTH_SOCK -u GIT_ASKPASS -u GIT_SSH_COMMAND -u GIT_SSH \
    TMPDIR="$codex_tmp" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=gc.auto GIT_CONFIG_VALUE_0=0 GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null \
    codex "${args[@]}" - < "$prompt_file" | tee "$events" | jq -Rr --unbuffered '
    fromjson? | if .type == "item.completed" and .item.type == "agent_message" then .item.text
      elif .type == "item.started" and .item.type == "command_execution" then "  > " + (.item.command // "command")
      else empty end' 2>/dev/null
  code=${PIPESTATUS[0]}
  set -e
  [ -s "$body" ] || echo "Codex returned no text (exit $code)." > "$body"
  usage_json=$(jq -sc '[.[] | select(.type == "turn.completed") | .usage] | last // {} | {
    tokens_in: (.input_tokens // null), tokens_out: (.output_tokens // null),
    tokens_cache: (.cached_input_tokens // null), tokens_total: ((.input_tokens // 0) + (.output_tokens // 0))}' "$events" 2>/dev/null) || usage_json='{}'
  contract_usage "$usage_json"
  contract_report codex "$code" "$body"
  return "$code"
}

case "${1:-}" in
  list-models)
    shift
    # Codex keeps the list its server sent it: no call is needed.
    cache="${CODEX_HOME:-$HOME/.codex}/models_cache.json"
    [ -f "$cache" ] || exit 0
    listed=$(jq -r '.. | objects | select(has("slug")) | .slug' "$cache" | sort -u)
    if [ $# -eq 0 ]; then
      printf '%s\n' "$listed"
    else
      for candidate in "$@"; do grep -xF -- "$candidate" <<<"$listed" || true; done
    fi
    ;;
  talk)
    echo 'codex: interactive discussion is not available from this adapter' >&2
    exit 2
    ;;
  version)
    if [ "$runner" = container ]; then
      task_script=${ADAPTER_TASK_SCRIPT:-}
      case "$task_script" in "~/"*) task_script="$HOME/${task_script#\~/}" ;; esac
      mounted=$(grep -o -m 1 -E '/[^ :"]+/node_modules/@openai/codex' "$task_script" 2>/dev/null || true)
      installed=$(jq -r '.version' "$mounted/package.json" 2>/dev/null || codex --version 2>/dev/null | awk '{print $NF}')
    else
      installed=$(codex --version 2>/dev/null | awk '{print $NF}')
    fi
    contract_npm_version codex "${ADAPTER_PACKAGE:-}" "$installed"
    ;;
  run)
    shift
    contract_parse_run "$@"
    if [ "$runner" = host ]; then host_run; exit $?; fi
    out=$(mktemp) err=$(mktemp) body=$(mktemp)
    trap 'rm -f "$out" "$err" "$body"' EXIT
    refuse() {
      echo "Codex did not start: $1" | tee "$body" >&2
      contract_usage '{}'
      contract_report codex 2 "$body"
      exit 2
    }
    task_script=${ADAPTER_TASK_SCRIPT:-}
    case "$task_script" in "~/"*) task_script="$HOME/${task_script#\~/}" ;; esac
    [ -x "$task_script" ] || refuse "the isolated task script is missing (${task_script:-not configured})."
    git diff --quiet HEAD || refuse "the worktree has uncommitted changes."
    # With [adapter.codex] task_tools = yes, the work of a lane is given the
    # means of any other lane inside its container (the task script's
    # --tools: the dependencies, a browser, a database, its screenshots). A
    # text-only run (the write-up of a report) needs none of it. Such a
    # session is a heavy operation for the host, from its first minute to
    # its last: it goes through the door of the heavy commands, which waits
    # for the host to be free and keeps the checks of a pull request from
    # starting meanwhile.
    tools=
    [ "${ADAPTER_TASK_TOOLS:-}" != yes ] || [ -n "${ORCH_TEXT_ONLY:-}" ] || tools=1
    launch=("$task_script" "$PWD" "$prompt_file" "$model")
    if [ -n "$tools" ]; then
      # It cannot commit: it says in a file what the commit of its work
      # should be called, and lane-run.sh commits ([adapter.codex] commits).
      with_tools=$(mktemp)
      trap 'rm -f "$out" "$err" "$body" "$with_tools"' EXIT
      {
        cat "$prompt_file"
        printf '\n\nYou cannot commit your work here (there is no git); Cleared commits it after your session. Write `.commit-message` at the repository root with an English conventional commit subject, then a blank line and a short paragraph. Run heavy commands such as screen tests and captures directly here; your whole session already holds its host slot.\n'
      } > "$with_tools"
      launch=("$here/../when-free.sh" "$task_script" "$PWD" "$with_tools" "$model" --tools)
    else
      # Rule of the host (2026-10-06): no container starts while a CI run is
      # in progress, and the task script starts three.
      running=$(gh run list --limit 30 --json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo unknown)
      [ "$running" = 0 ] || refuse "CI is running or its state cannot be read ($running) : no container starts during CI."
    fi

    # Output goes to files, read once the script has ended; the lane follows
    # the transcript meanwhile.
    tail -f "$err" >&2 &
    follow=$!
    set +e
    "${launch[@]}" > "$out" 2> "$err"
    code=$?
    set -e
    sleep 0.3
    kill "$follow" 2> /dev/null || true
    wait "$follow" 2> /dev/null || true
    # The door did not open within its wait (5), or does not know the task
    # script (1): it could not start now. Only the door's own last word says
    # so: nothing runs after it refuses, while a session that did run may
    # end with any code and print anything.
    last=$(sed -n '$p' "$err")
    if [ -n "$tools" ] && { [ "$code" = 5 ] || [ "$code" = 1 ]; } && [[ "$last" == "when-free.sh: "* ]]; then
      refuse "the host was busy for a tool-enabled session, or the task script is absent from the project heavy commands : $last"
    fi
    if [ "$code" != 0 ] && grep -q -E '^(Refus|Refused)' "$err"; then
      {
        grep -E '^(Refus|Refused)' "$err" | tail -n 1
        echo
        echo "What the guard found (locations only, never values):"
        echo
        grep -E '(:[0-9]+)?: (secret|adresse|terme|IBAN|private term( in name)?|application token( in name)?|API key( in name)?|private key( in name)?|credentials in a URL( in name)?|email address( in name)?|phone number( in name)?|literal secret|assigned secret|symbolic link|non-text file)' "$err" | sed -E 's#^/tmp/[^/]+/repo/##; s/^/- /' | sed -n '1,30p' || true
      } > "$body"
      contract_usage '{}'
      contract_report codex 3 "$body"
      exit 3
    fi
    # The task script prints the last message twice (the CLI, then its file).
    half=$(( $(wc -c < "$out") / 2 ))
    if [ "$half" -gt 0 ] && cmp -s <(head -c "$half" "$out") <(tail -c "$half" "$out"); then head -c "$half" "$out" > "$body"; else cp "$out" "$body"; fi
    [ -s "$body" ] || echo "Codex returned no text (exit $code)." > "$body"
    # The CLI itself only prints a total in this mode. The split by kind
    # of token comes from the task script, when it passes on what the CLI
    # counted for the whole session (a line « token usage <json> »): input
    # that was not read from the cache, input read from it, output, and
    # what was written to the cache, as the ledger names them for every
    # backend. A line that cannot be read leaves the split empty.
    total=$(grep -A1 '^tokens used' "$err" | tail -n 1 | tr -dc '0-9') || total=
    split=$(grep '^token usage ' "$err" | tail -n 1 | sed 's/^token usage //' | jq -c '
      def count: if type == "number" and . >= 0 then floor else null end;
      select(type == "object" and (.input_tokens | count) != null and (.output_tokens | count) != null)
      | (.cached_input_tokens | count) as $cached
      | {tokens_in: ((.input_tokens | count) - ($cached // 0) | if . < 0 then 0 else . end), tokens_out: (.output_tokens | count), tokens_cache: $cached, tokens_cache_write: (.cache_write_input_tokens | count)}' 2> /dev/null) || split=
    [ -n "$split" ] || split='{}'
    # Where its subscription stands, when the task script passes on what the
    # CLI recorded (a line « rate limits <json> »: the CLI's own snapshot,
    # primary and secondary windows with the percent used, the length of the
    # window in minutes and the time it starts over): kept like any backend's
    # (lib/limits.mjs), under the names the windows have elsewhere.
    limits=$(grep '^rate limits ' "$err" | tail -n 1 | sed 's/^rate limits //' | jq -c '
      def named: if . == 10080 then "seven_day" elif . == 300 then "five_hour" else "\(.)_minutes" end;
      # Each window by itself: one whose figures cannot be read does not
      # take the other with it; two of the same length keep the fuller one.
      [.primary, .secondary]
      | map(select(type == "object") | try {key: (.window_minutes | floor | named), used: .used_percent, resets_at: (.resets_at | floor | todate)} catch empty)
      | map(select((.used | type) == "number" and .used >= 0 and .used <= 1000))
      | group_by(.key) | map(max_by(.used))
      | if length == 0 then null else {windows: (map({key, value: {used, resets_at}}) | from_entries)} end' 2> /dev/null) || limits=null
    contract_usage "$(jq -nc --arg total "$total" --argjson split "$split" --argjson limits "${limits:-null}" '$split + {tokens_total: (if $total == "" then null else ($total | tonumber) end)} + (if $limits then {limits: $limits} else {} end)')"
    contract_report codex "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | version | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
