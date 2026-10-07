# Shared by the dispatcher scripts. Sourced, never executed.
# Nothing here names a model or a provider: both come from agents.conf.

ORCH_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ORCH_CONF=${ORCH_CONF:-$ORCH_HOME/agents.conf}
# The main checkout holds the one shared state, whatever worktree runs this.
ORCH_REPO=${ORCH_REPO:-$(git -C "$ORCH_HOME" worktree list --porcelain | sed -n '1s/^worktree //p')}
ORCH_STATE_DIR=${ORCH_STATE_DIR:-$ORCH_REPO/ops/orchestration/state}
export ORCH_HOME ORCH_CONF ORCH_REPO ORCH_STATE_DIR

die() { echo "$(basename "$0"): $*" >&2; exit 1; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

expand_home() { case "$1" in "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;; *) printf '%s\n' "$1" ;; esac; }

ledger() { node --no-warnings "$ORCH_HOME/lib/ledger.mjs" "$@"; }

# lane_worktree <name>: the worktree of that name, as git knows it. Fails when
# there is none, or more than one.
lane_worktree() {
  local found
  found=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | awk -F/ -v name="$1" '$NF == name')
  [ -n "$found" ] && [ "$(grep -c . <<<"$found")" -eq 1 ] && printf '%s\n' "$found"
}

# orca_terminal <handle>: "<connected> <worktree path>" of that terminal as
# Orca shows it now, nothing when Orca has no such terminal. Orca that does
# not answer, or answers without a list, is said and stops the script.
orca_terminal() {
  local listed
  listed=$(orca terminal list --json 2> /dev/null) || die "Orca did not answer (orca terminal list): nothing done"
  jq -e '(.result.terminals // .result) | type == "array"' <<<"$listed" > /dev/null 2>&1 || die "Orca gave no list of terminals: nothing done"
  jq -r --arg handle "$1" '(.result.terminals // .result)[] | select(.handle == $handle) | "\(.connected) \(.worktreePath)"' <<<"$listed" | sed -n '1p'
}

# conf_get <section> <key>: one value of agents.conf (empty when absent).
conf_get() {
  awk -v section="[$1]" -v wanted="$2" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ {
      i = index($0, "="); if (!i) next
      key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == wanted) { value = substr($0, i + 1); gsub(/^[ \t]+|[ \t]+$/, "", value); print value; exit }
    }' "$ORCH_CONF"
}

# conf_keys <section>: the keys of a section, one per line.
conf_keys() {
  awk -v section="[$1]" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ { i = index($0, "="); if (i) { key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key); print key } }' "$ORCH_CONF"
}

# Every key of [adapter.<name>] reaches the adapter as ADAPTER_<KEY>.
adapter_env() {
  local key
  while IFS= read -r key; do
    [ -n "$key" ] && export "ADAPTER_$(printf '%s' "$key" | tr '[:lower:]-' '[:upper:]_')=$(conf_get "adapter.$1" "$key")"
  done < <(conf_keys "adapter.$1")
  return 0
}

# What a role may do without a screen, from [permissions.<role>], handed to
# the adapter as ORCH_PERMISSION_MODE, ORCH_ALLOW and ORCH_DENY (comma
# separated command prefixes). No section: nothing is set, and the CLI keeps
# the settings of the user.
permissions_env() {
  unset ORCH_PERMISSION_MODE ORCH_ALLOW ORCH_DENY
  local mode
  mode=$(conf_get "permissions.$1" mode)
  [ -n "$mode" ] || return 0
  export ORCH_PERMISSION_MODE=$mode ORCH_ALLOW ORCH_DENY
  ORCH_ALLOW=$(conf_get "permissions.$1" allow)
  ORCH_DENY=$(conf_get "permissions.$1" deny)
}

adapter_path() {
  local path="$ORCH_HOME/adapters/$1.sh"
  [ -x "$path" ] || die "no adapter for \"$1\": add $path (contract in README.md)"
  printf '%s\n' "$path"
}

# model_available <adapter> <model id>: asks the adapter (list-models), and
# remembers a yes for a day so that a spawn does not probe again.
model_available() {
  local adapter=$1 model=$2 cache="$ORCH_STATE_DIR/models/$1.available" ttl=${ORCH_MODELS_TTL:-86400} seen
  mkdir -p "$ORCH_STATE_DIR/models"
  seen=$(awk -F'\t' -v m="$model" '$1 == m { t = $2 } END { print t + 0 }' "$cache" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - seen )) -lt "$ttl" ]; then return 0; fi
  adapter_env "$adapter"
  if "$(adapter_path "$adapter")" list-models "$model" < /dev/null | grep -qxF "$model"; then
    model_seen "$adapter" "$model"
    return 0
  fi
  return 1
}

# available_chain <chain as JSON, from route.mjs>: the candidates the adapters
# say are available now, in order, as a JSON array (empty when none is).
available_chain() {
  local kept='[]' alias adapter model
  while IFS=$'\t' read -r alias adapter model; do
    if model_available "$adapter" "$model"; then
      kept=$(jq -c --arg alias "$alias" --arg adapter "$adapter" --arg model "$model" '. + [{alias: $alias, adapter: $adapter, model: $model}]' <<<"$kept")
    else
      echo "$(basename "$0"): $alias ($adapter: $model) is not available" >&2
    fi
  done < <(jq -r '.[] | [.alias, .adapter, .model] | @tsv' <<<"$1")
  printf '%s\n' "$kept"
}

model_seen() {
  mkdir -p "$ORCH_STATE_DIR/models"
  printf '%s\t%s\n' "$2" "$(date +%s)" >> "$ORCH_STATE_DIR/models/$1.available"
}

# The worktree where a discussion writes docs/decisions.md, and nothing else.
decisions_worktree() {
  printf '%s\n' "${ORCH_DECISIONS_WORKTREE:-$(expand_home "$(conf_get lanes root)")/$(conf_get talk role)-$(conf_get lead report_on)}"
}

# github_down: what GitHub says is down among the parts the dispatcher needs,
# as its public status page has it (nothing when all is well, or when the
# page cannot be read). A slowdown is not an outage.
github_down() {
  curl -fsS --max-time 8 "${ORCH_GITHUB_STATUS:-https://www.githubstatus.com/api/v2/components.json}" 2> /dev/null \
    | jq -r '[.components[] | select(.name == "Git Operations" or .name == "Pull Requests" or .name == "Actions" or .name == "API Requests")
        | select(.status == "major_outage" or .status == "partial_outage") | .name] | join(", ")' 2> /dev/null || true
}

# talk_open: is a discussion open in the lane of the lead? talk.sh writes
# "opening <time>" in the mark before it opens the terminal (good for five
# minutes: Orca may take two to open one), talk-run.sh puts
# its process there and takes the mark away when the conversation ends. A
# mark whose process is gone, or is no longer a conversation (its number was
# given to something else), or an opening that never came, holds nothing.
talk_open() {
  local mark="$ORCH_STATE_DIR/wake/talk" first second
  read -r first second < "$mark" 2> /dev/null || return 1
  if [ "$first" = opening ]; then
    [ $(( $(date +%s) - ${second:-0} )) -lt "${ORCH_TALK_OPENING:-300}" ]
  else
    [[ "$first" =~ ^[0-9]+$ ]] && tr '\0' ' ' < "/proc/$first/cmdline" 2> /dev/null | grep -q "talk-run.sh"
  fi
}

# close_old_terminals <lane> <kept>: closes in Orca the terminals of the past
# sessions of a lane, all but the last <kept> (run folders are named by their
# time). What a session said stays in its run folder and in the ledger. A
# terminal is closed once; one that Orca no longer shows is forgotten.
close_old_terminals() {
  local lane=$1 kept=$2 env dir handle listed
  while IFS= read -r env; do
    dir=$(dirname "$env")
    [ -s "$dir/terminal.handle" ] && [ ! -f "$dir/terminal.closed" ] || continue
    handle=$(sed -n '1p' "$dir/terminal.handle")
    if orca terminal close --terminal "$handle" --tab > /dev/null 2>&1 \
      || { listed=$(orca terminal list --json 2> /dev/null) && jq -e --arg handle "$handle" '(.result.terminals // .result) | type == "array" and (any(.handle == $handle) | not)' <<<"$listed" > /dev/null 2>&1; }; then
      now_utc > "$dir/terminal.closed"
    fi
  done < <(grep -l -x -F "ORCH_LANE=$lane" "$ORCH_STATE_DIR"/runs/*/lane.env 2> /dev/null | head -n "-$kept")
  return 0
}

# guard_text <file>: refuses, without showing any value, a text the guard of
# the repository would not let out (private terms, secrets, IBANs, addresses,
# phone numbers). For anything a script sends to an outside service: Linear,
# GitHub. The guard comes from the trusted ref, like scripts/codex-task.sh.
guard_text() {
  local ref=${ORCH_GUARD_REF:-origin/main} dir part
  dir=$(mktemp -d)
  for part in codex-guard.mjs codex-guard-allow.json private-terms.mjs private-terms.json; do
    git -C "$ORCH_REPO" show "$ref:scripts/$part" > "$dir/$part" 2>/dev/null || {
      rm -rf "$dir"
      echo "$(basename "$0"): not sent, the guard (scripts/$part on $ref) could not be read" >&2
      return 1
    }
  done
  if ! node "$dir/codex-guard.mjs" --strict "$1" >&2; then
    rm -rf "$dir"
    echo "$(basename "$0"): not sent, the guard refuses this text" >&2
    return 1
  fi
  rm -rf "$dir"
}

# open_terminal <worktree> <title> <command> [<ticket>]: opens a terminal of
# the lane in Orca and prints its handle. Orca only knows a new worktree a few
# seconds after git does, sometimes much later: the attempt is repeated for
# ORCH_ORCA_WAIT seconds (120), then made once more. A wait longer than
# ORCH_ORCA_SLOW seconds (30), and a failure, are written to the ledger.
open_terminal() {
  local worktree=$1 title=$2 command=$3 ticket=${4:-} wait=${ORCH_ORCA_WAIT:-120} step=${ORCH_ORCA_STEP:-5} slow=${ORCH_ORCA_SLOW:-30}
  local started answer waited last=
  started=$(date +%s)
  while :; do
    if answer=$(orca terminal create --worktree "path:$worktree" --title "$title" --command "$command" --json 2> /dev/null); then
      waited=$(( $(date +%s) - started ))
      if [ "$waited" -ge "$slow" ]; then
        ledger event --kind orca_terminal_delayed --ticket "$ticket" --value "$waited" --detail "$title: Orca took $waited s to open the terminal"
      fi
      jq -r '.. | objects | .handle? // empty' <<<"$answer" | sed -n '1p'
      return 0
    fi
    [ -z "$last" ] || break
    # Past the wait: one more attempt, then give up.
    if [ $(( $(date +%s) - started )) -ge "$wait" ]; then last=1; fi
    sleep "$step"
  done
  ledger event --kind orca_terminal_failed --ticket "$ticket" --value "$(( $(date +%s) - started ))" --detail "$title: Orca did not open a terminal in $worktree"
  return 1
}

# Lanes opened by the dispatcher: branches named <role>/<ticket>.
dispatcher_lanes() {
  local roles
  roles=$(conf_keys roles | paste -sd'|')
  git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's#^branch refs/heads/##p' | grep -E "^($roles)/" || true
}

# Those that take one of the max_lanes places: the roles of [limits]
# counted_roles (every role when it is not set). A lane that only watches or
# reads, like the project lead's, does not hold a place.
counted_lanes() {
  local counted
  counted=$(conf_get limits counted_roles | tr -s ' ' '|')
  if [ -z "$counted" ]; then dispatcher_lanes; else dispatcher_lanes | grep -E "^($counted)/" || true; fi
}
