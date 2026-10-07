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

model_seen() {
  mkdir -p "$ORCH_STATE_DIR/models"
  printf '%s\t%s\n' "$2" "$(date +%s)" >> "$ORCH_STATE_DIR/models/$1.available"
}

# Lanes opened by the dispatcher: branches named <role>/<ticket>.
dispatcher_lanes() {
  local roles
  roles=$(conf_keys roles | paste -sd'|')
  git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's#^branch refs/heads/##p' | grep -E "^($roles)/" || true
}
