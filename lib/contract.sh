# The adapter contract, shared so that every backend writes the same report.
# Sourced by adapters/<name>.sh. See README.md.
#
#   <adapter> list-models [<model id>...]
#       prints the model ids this backend can run now, one per line
#       (limited to the candidates when some are given).
#   <adapter> probe <model id>
#       asks the real CLI one small question (CONTRACT_PROBE_PROMPT), exactly
#       as a run would start it (same account, prefixes and environment, no
#       API key), from an empty folder, under a timeout (CLEARED_PROBE_TIMEOUT
#       seconds, 120 by default), and prints one line: `ok <model>` when the
#       answer holds the word OK, else `FAIL <model>: <reason>` (the first
#       line of it, never a credential) and exits 1. One small request on the
#       subscription. serve/check-harness.sh runs it for each configured model.
#   <adapter> version
#       prints one JSON line: {cli, installed, latest, days_behind}, where
#       days_behind is how much older the installed release is than the
#       latest one (0 when up to date, null when unknown).
#   <adapter> run --model <id> --prompt-file <file> --report <file> --usage <file>
#       runs the prompt in the current worktree, writes the report and the
#       usage, and exits with 0 (done), 2 (cannot start now: nothing was sent
#       to the model), 3 (its own safeguard refuses the content of the task)
#       or anything else (failed).
#   <adapter> talk --model <id> --prompt-file <file> [--session-id <uuid>]
#       holds a conversation with the user in the current terminal, opened by
#       the prompt, and exits with the code of its CLI, or with 2 when this
#       backend has no conversation to offer here. In a conversation nothing
#       is asked for: what the permissions do not name is refused.
#       ORCH_EDIT_ONLY names the one file the session may edit, and
#       ORCH_READ_DIRS (separated by colons) the folders it may read.
#
# ORCH_BUDGET_USD: what the run may still cost; a run stopped there exits 5.
# ORCH_READ (separated by commas): folders a run may read beyond the one it
# works in, and those only.
#
# ORCH_PERMISSION_MODE (read-only or accept-edits), ORCH_ALLOW and ORCH_DENY
# (comma separated command prefixes) say what the run may do without a
# screen; an adapter that isolates its CLI otherwise may ignore them.
#
# ORCH_ADVISOR=no says the run goes without the helper model its CLI may
# consult by itself (a second model, billed apart).
#
# ORCH_TEXT_ONLY=1 in the environment says the task only rewords a text: an
# adapter may then start its CLI without tools, which costs less.

# contract_npm_version <cli> <npm package> <installed version>: the JSON line
# of `version` for a CLI published on npm, from the dates of the registry.
contract_npm_version() {
  local latest
  latest=$(npm view "$2" version 2>/dev/null || true)
  # The list of release dates is long: it goes through stdin, not an argument.
  { npm view "$2" time --json 2>/dev/null || echo '{}'; } | jq -c --arg cli "$1" --arg installed "$3" --arg latest "$latest" '
    def day: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    . as $times
    | {cli: $cli, installed: $installed, latest: (if $latest == "" then null else $latest end)}
    | .days_behind = (if .latest == null or ($times[$installed] // null) == null or ($times[$latest] // null) == null then null
        else ((($times[$latest] | day) - ($times[$installed] | day)) / 86400 | floor | if . < 0 then 0 else . end) end)'
}

# The probe: one small question, one word expected back.
CONTRACT_PROBE_PROMPT='Reply with the single word OK.'
# contract_probe_timeout: the seconds a probe waits for its answer.
contract_probe_timeout() {
  local limit=${ORCH_PROBE_TIMEOUT:-120}
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || limit=120
  printf '%s\n' "$limit"
}
# contract_probe_reason < text: the line of it that says why, cut short: the
# first one that names an error (error, failed, denied, not logged,
# unauthorized, invalid, refused), else the first that says something (a
# warning or a stack frame often comes before the error). Whatever looks like
# a key or a token is hidden: a word starting with sk-, a run of 24 or more of
# A-Z a-z 0-9 _ + / = . - with both cases and a digit (base64, JWT, most
# keys), or one of 32 or more letters and digits only, with a digit (hex). A
# path stays readable (a piece of it that looks like a key does not), and so
# do model ids, error names and words joined by hyphens.
contract_probe_reason() {
  tr -d '\r' | awk '
    function secret(t) {
      if (t ~ /^sk-/ && length(t) >= 20) return 1
      if (length(t) >= 24 && t ~ /[a-z]/ && t ~ /[A-Z]/ && t ~ /[0-9]/) return 1
      return length(t) >= 32 && t ~ /^[A-Za-z0-9]+$/ && t ~ /[0-9]/ && t ~ /[A-Za-z]/
    }
    function hide(t,   n, part, i, out) {
      if (t !~ /^\.?\//) return secret(t) ? "[hidden]" : t
      n = split(t, part, "/"); out = part[1]
      for (i = 2; i <= n; i++) out = out "/" (secret(part[i]) ? "[hidden]" : part[i])
      return out
    }
    function clean(line,   out) {
      out = ""
      while (match(line, /[A-Za-z0-9_+\/=.-]+/)) {
        out = out substr(line, 1, RSTART - 1) hide(substr(line, RSTART, RLENGTH))
        line = substr(line, RSTART + RLENGTH)
      }
      return out line
    }
    /[^[:space:]]/ {
      if (!seen++) first = $0
      if (tolower($0) ~ /error|failed|denied|not logged|unauthorized|invalid|refused/) { said = $0; found = 1; exit }
    }
    END {
      if (!found) said = first
      if (!found && !seen) exit
      said = clean(said)
      sub(/^[[:space:]]+/, "", said)
      print said
    }' | cut -c1-200
}
# contract_probe_fail <model> <reason>: the line of a probe that failed.
contract_probe_fail() {
  printf 'FAIL %s: %s\n' "$1" "${2:-no reason given}"
  return 1
}
# contract_probe_answer <model> <answer>: ok when the answer holds the word.
contract_probe_answer() {
  if grep -qiw 'OK' <<<"$2"; then printf 'ok %s\n' "$1"; return 0; fi
  contract_probe_fail "$1" "the answer was not OK: $(contract_probe_reason <<<"${2:-(empty)}")"
}

contract_parse_run() {
  model= prompt_file= report= usage=
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) model=$2 ;;
      --prompt-file) prompt_file=$2 ;;
      --report) report=$2 ;;
      --usage) usage=$2 ;;
      *) echo "unknown option $1" >&2; exit 64 ;;
    esac
    shift 2
  done
  [ -n "$model" ] && [ -f "$prompt_file" ] && [ -n "$report" ] && [ -n "$usage" ] || {
    echo "usage: run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
  }
  mkdir -p "$(dirname "$report")" "$(dirname "$usage")"
  contract_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
}

# contract_usage <json>: the usage file. Fields the CLI does not give stay null.
contract_usage() {
  jq -n --arg model "$model" --argjson given "$1" '
    {model: $model, tokens_in: null, tokens_out: null, tokens_cache: null, tokens_cache_write: null, tokens_total: null, cost_usd: null} + $given
  ' > "$usage"
}

# contract_report <adapter> <exit code> <body file>: the report, same shape
# for every backend. The body is what the model answered (or why it did not).
contract_report() {
  local adapter=$1 code=$2 body=$3 outcome changed
  case "$code" in 0) outcome=done ;; 2 | 3) outcome=refused ;; *) outcome=failed ;; esac
  # Zero outside a git worktree (a text-only task runs in an empty directory).
  changed=$( (git status --porcelain 2>/dev/null || true) | wc -l | tr -d ' ')
  {
    echo '---'
    echo 'format: lane-report/1'
    echo "run_id: ${ORCH_RUN_ID:-}"
    echo "lane: ${ORCH_LANE:-}"
    echo "ticket: ${ORCH_TICKET:-}"
    echo "role: ${ORCH_ROLE:-}"
    echo "commit: $(git rev-parse --verify --quiet HEAD 2>/dev/null || true)"
    echo "adapter: $adapter"
    echo "requested_model: ${ORCH_REQUESTED_MODEL:-}"
    echo "model: $(jq -r '.model' "$usage")"
    echo "outcome: $outcome"
    echo "exit_code: $code"
    echo "started_at: $contract_started"
    echo "ended_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    jq -r '"tokens_in: \(.tokens_in // "")\ntokens_out: \(.tokens_out // "")\ntokens_cache: \(.tokens_cache // "")\ntokens_cache_write: \(.tokens_cache_write // "")\ntokens_total: \(.tokens_total // "")\ncost_usd: \(.cost_usd // "")"' "$usage"
    echo "files_changed: $changed"
    echo '---'
    echo
    echo '## Report'
    echo
    cat "$body"
    [ -z "$(tail -c 1 "$body")" ] || echo
    echo
    echo '## Changed files'
    echo
    if [ "$changed" = 0 ]; then
      echo 'None.'
    else
      git status --porcelain | sed -n '1,30s/^/- /p'
      if [ "$changed" -gt 30 ]; then echo "- … and $((changed - 30)) more"; fi
    fi
  } > "$report"
}
