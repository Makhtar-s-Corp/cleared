#!/usr/bin/env bash
# Adapter for the Codex CLI. Contract: lib/contract.sh.
#
# Codex never runs on the host. This adapter only calls the trusted task
# script of the main checkout (ADAPTER_TASK_SCRIPT), which runs Codex in a
# container on a guarded snapshot of the commit and brings back a patch. When
# it cannot start now (a CI run in progress, uncommitted changes, the host
# not free for a session with tools) the adapter exits with 2; when the guard
# of that script refuses the content, with 3.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/contract.sh"

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
    # The CLI only runs inside its container, without a screen.
    echo "codex: no conversation from this adapter" >&2
    exit 2
    ;;
  version)
    # The copy that counts is the one the isolated task script mounts in its
    # container, not the one on the PATH.
    task_script=${ADAPTER_TASK_SCRIPT:-}
    case "$task_script" in "~/"*) task_script="$HOME/${task_script#\~/}" ;; esac
    mounted=$(grep -o -m 1 -E '/[^ :"]+/node_modules/@openai/codex' "$task_script" 2>/dev/null || true)
    installed=$(jq -r '.version' "$mounted/package.json" 2>/dev/null || codex --version 2>/dev/null | awk '{print $NF}')
    contract_npm_version codex "${ADAPTER_PACKAGE:-}" "$installed"
    ;;
  run)
    shift
    contract_parse_run "$@"
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
        grep -E '(:[0-9]+)?: (private term( in name)?|application token( in name)?|API key( in name)?|private key( in name)?|IBAN( in name)?|credentials in a URL( in name)?|email address( in name)?|phone number( in name)?|literal secret|assigned secret|symbolic link|non-text file)' "$err" | sed -E 's#^/tmp/[^/]+/repo/##; s/^/- /' | sed -n '1,30p'
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
