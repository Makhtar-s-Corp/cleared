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
