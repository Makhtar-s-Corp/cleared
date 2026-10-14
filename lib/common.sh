# Shared by the dispatcher scripts. Sourced, never executed.
# Nothing here names a model or a provider: both come from agents.conf.

# Map public Cleared environment names to the internal script variables.
while IFS= read -r cleared_name; do
  old_name=ORCH_${cleared_name#CLEARED_}
  printf -v "$old_name" '%s' "${!cleared_name}"
  export "$old_name"
done < <(compgen -e | grep '^CLEARED_' || true)

ORCH_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ORCH_REPO=${CLEARED_REPO:-${ORCH_REPO:-}}
ORCH_CONF=${CLEARED_CONF:-${ORCH_CONF:-}}
ORCH_STATE_DIR=${CLEARED_STATE_DIR:-${ORCH_STATE_DIR:-}}
# The project these scripts work on, by its main checkout: said by whoever
# runs them (ORCH_REPO), else once for the machine (first line of
# ~/.config/cleared/project), else the repository these scripts sit in (a
# project that carries its own copy of the tool).
cleared_config_root=${XDG_CONFIG_HOME:-$HOME/.config}
cleared_project_file=$cleared_config_root/cleared/project
ORCH_REPO=${ORCH_REPO:-$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$cleared_project_file" 2> /dev/null || true)}
ORCH_REPO=${ORCH_REPO:-$(git -C "$ORCH_HOME" worktree list --porcelain 2> /dev/null | sed -n '1s/^worktree //p' || true)}
# No project at all (nobody named one, and the tool sits in no repository):
# nothing is done « wherever this was started from ».
[ -n "$ORCH_REPO" ] || { echo "$(basename "$0"): no project is named (ORCH_REPO, or the first line of $cleared_project_file)" >&2; exit 1; }
# Its settings are the tracked .cleared/agents.conf in the project checkout.
if [ -z "${ORCH_CONF:-}" ]; then
  if [ -f "$ORCH_REPO/.cleared/agents.conf" ] && git -C "$ORCH_REPO" ls-files --error-unmatch -- .cleared/agents.conf > /dev/null 2>&1; then ORCH_CONF=$ORCH_REPO/.cleared/agents.conf
  elif [ -f "$ORCH_REPO/.cleared/agents.conf" ]; then ORCH_CONF=$ORCH_REPO/.cleared/tracked-agents.conf-missing
  else ORCH_CONF=$ORCH_REPO/.cleared/agents.conf; fi
  if [ -f "$ORCH_REPO/.cleared/agents.conf" ] && [ "$ORCH_CONF" != "$ORCH_REPO/.cleared/agents.conf" ]; then CLEARED_IGNORED_UNTRACKED_CONF=$ORCH_REPO/.cleared/agents.conf; fi
fi
# The state is kept on the machine, outside the repositories: one folder per
# project, named after its checkout.
if [ -z "${ORCH_STATE_DIR:-}" ]; then
  cleared_state_root=${XDG_STATE_HOME:-$HOME/.local/state}
  ORCH_STATE_DIR=$cleared_state_root/cleared/$(basename "$ORCH_REPO")
fi
export ORCH_HOME ORCH_CONF ORCH_REPO ORCH_STATE_DIR CLEARED_IGNORED_UNTRACKED_CONF
export CLEARED_REPO="$ORCH_REPO" CLEARED_CONF="$ORCH_CONF" CLEARED_STATE_DIR="$ORCH_STATE_DIR"

# prompt_file <name>: the prompt of that name. The project's own
# (.cleared/prompts/<name>.md in its main checkout) comes before the one of the
# tool: what an agent is told about a product is the product's.
prompt_asset() {
  if [ -f "$ORCH_REPO/.cleared/prompts/$1" ]; then printf '%s\n' "$ORCH_REPO/.cleared/prompts/$1"
  else printf '%s\n' "$ORCH_HOME/prompts/$1"; fi
}
prompt_file() { prompt_asset "$1.md"; }
# prompt_text <file>: its text, with {orch} standing for where these scripts
# are on this machine (the same word as in [permissions.*]).
# Written as it is, whatever characters the path holds (a quoted replacement
# is taken literally).
prompt_text() {
  local text language verdict report_on
  [ -r "$1" ] || { echo "$(basename "$0"): no prompt to read at $1" >&2; return 1; }
  text=$(cat "$1"; printf x)
  text=${text%x}
  if [[ "$text" == *'@REVIEW_VERDICT@'* ]]; then
    verdict=$(conf_get merge verdict) || return 1
    text=${text//@REVIEW_VERDICT@/$verdict}
  fi
  if [[ "$text" == *'@REPORT_ON@'* ]]; then
    report_on=$(conf_get lead report_on) || return 1
    text=${text//@REPORT_ON@/$report_on}
  fi
  language=$(conf_get owner language)
  language=${language:-en}
  if [[ "$text" == *'{owner_language}'* ]]; then
    text=${text//\{owner_language\}/$language}
  else
    text="Write to the user in $language. Work and communicate with other agents in English."$'\n\n'"$text"
  fi
  printf '%s' "${text//\{orch\}/"$ORCH_HOME"}"
}

die() { echo "$(basename "$0"): $*" >&2; exit 1; }

agent_mount_args() {
  # The model sees the team files, but Git's control data remains read-only
  # even when the worktree root itself is writable. The dispatcher commits.
  local bwrap worktree common expected
  bwrap=$(conf_get security bwrap_path)
  bwrap=${bwrap:-/usr/bin/bwrap}
  worktree=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ "${ORCH_ACTIVE_PERMISSION_ROLE:-}" = release-live ]; then
    # (Compared as the file system resolves both: git names the top of the
    # checkout so, whatever link ORCH_REPO goes through.)
    [ -n "$worktree" ] && [ "$(realpath -m -- "$worktree")" = "$(realpath -m -- "$ORCH_REPO")" ] || die "release role must run from the service-owned main checkout"
    # Its sudo bridge needs setuid, which bubblewrap's NoNewPrivs forbids.
    # The account cannot write the main checkout or Cleared state.
    AGENT_MOUNT_ARGS=()
    return 0
  fi
  [ -x "$bwrap" ] || die "[security] agent_user needs bubblewrap at $bwrap"
  # The sandbox dies whole with what started it (sudo, under the session):
  # --die-with-parent alone kills only the harness, not what it started;
  # with a process namespace of its own, the end of its first process ends
  # every other one in it, even one that left the process group (tried on
  # bubblewrap 0.12). Its /proc is that of the namespace: numbers read there
  # are the ones the processes inside use.
  AGENT_MOUNT_ARGS=("$bwrap" --dev-bind / / --die-with-parent --unshare-pid --proc /proc)
  [ -n "$worktree" ] || return 0
  expected=$(git -C "$ORCH_REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  [ -n "$expected" ] && [ "$common" = "$expected" ] || die "agent worktree does not share the service-owned project Git directory"
  AGENT_MOUNT_ARGS+=(--ro-bind "$common" "$common")
  [ ! -e "$worktree/.git" ] || AGENT_MOUNT_ARGS+=(--ro-bind "$worktree/.git" "$worktree/.git")
}

verify_agent_account() {
  local agent_user expected actual
  agent_user=$(conf_get security agent_user)
  [ -n "$agent_user" ] || return 0
  expected=$(id -u "$agent_user") || die "agent account $agent_user does not exist"
  if [ "$(id -u)" = "$expected" ]; then actual=$expected
  else actual=$(sudo -n -u "$agent_user" -- id -u) || die "cannot launch harness under $agent_user"; fi
  [ "$actual" = "$expected" ] || die "harness would run as UID $actual instead of $expected"
  if [ "$(id -u)" = "$expected" ]; then
    [ ! -w "$ORCH_STATE_DIR" ] || die "agent account can write Cleared state"
  else
    sudo -n -u "$agent_user" -- test ! -w "$ORCH_STATE_DIR" || die "agent account can write Cleared state"
  fi
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

expand_home() { case "$1" in "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;; *) printf '%s\n' "$1" ;; esac; }

# The door of the heavy commands (when-free.sh): one file that whoever runs
# a heavy operation on the host holds with flock for as long as it runs. The
# teams' heavy commands, the checks the rules start (flow-lanes.sh) and a host
# Codex session all go through these functions, never through a path of
# their own.
# heavy_lock_path: [lanes] heavy_lock (an absolute path), else heavy.lock in
# the state, as before. Under [security] agent_user the teams cannot open a
# file of the state: the setting must then name a file outside it, in a
# directory of the service that the agents' account may traverse but not
# write (serve/install.sh checks it).
heavy_lock_path() {
  local path
  path=$(conf_get lanes heavy_lock) || return 1
  path=$(expand_home "$path")
  if [ -z "$path" ]; then printf '%s\n' "$ORCH_STATE_DIR/heavy.lock"; return 0; fi
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) echo "$(basename "$0"): [lanes] heavy_lock must be an absolute path, not \"$path\"" >&2; return 1 ;;
  esac
}
# heavy_lock_in_state <path>: whether that path lies in Cleared's state.
heavy_lock_in_state() {
  case "$(realpath -m -- "$1")/" in "$(realpath -m -- "$ORCH_STATE_DIR")"/*) return 0 ;; esac
  return 1
}
# heavy_lock_open <path>: the door, opened READ-ONLY on a new descriptor, in
# HEAVY_FD. flock takes an exclusive lock on a descriptor opened for reading
# as well, so nobody needs the right to write the file: the agents' account
# never gets it. A missing file is created by whoever may write its
# directory (the service, never a team: theirs is not writable to them).
# Closed with heavy_lock_close.
heavy_lock_open() {
  if [ ! -e "$1" ]; then (umask 022 && : >> "$1") 2> /dev/null || true; fi
  [ -f "$1" ] || return 1
  exec {HEAVY_FD}< "$1"
}
heavy_lock_close() {
  [ -z "${HEAVY_FD:-}" ] || exec {HEAVY_FD}<&-
  HEAVY_FD=
}
# The host status the teams read instead of asking the host (GitHub, the
# state), which they cannot under agent_user: written by the service next to
# the door, readable by everyone, booleans and times only. Written at every
# wake and when the rules start checks; older than this many minutes, a team
# takes it for unknown and runs nothing.
HOST_STATUS_STALE_MINUTES=5
host_status_path() {
  local lock
  lock=$(heavy_lock_path) || return 1
  printf '%s\n' "${lock%.lock}.status.json"
}
# host_status_write [<host-state.sh JSON>]: writes it, from that answer or a
# new one, when [security] agent_user and [lanes] heavy_lock are both set
# (nothing otherwise: the teams then ask the host themselves). An answer that
# cannot be read counts as a host that is not free.
host_status_write() {
  local status lock host starting part
  [ -n "$(conf_get security agent_user)" ] && [ -n "$(conf_get lanes heavy_lock)" ] || return 0
  status=$(host_status_path) || return 1
  # (The door itself too, when it is missing: the teams cannot create it.)
  lock=$(heavy_lock_path) || return 1
  [ -e "$lock" ] || (umask 022 && : >> "$lock") || return 1
  host=${1:-}
  [ -n "$host" ] || host=$("$ORCH_HOME/host-state.sh" 2> /dev/null) || host=
  jq -e 'type == "object"' <<<"$host" > /dev/null 2>&1 || host='{}'
  # Checks the rules have just started are not listed by GitHub for some
  # seconds: for two minutes after it, the host is not free.
  starting=false
  [ -z "$(find "$ORCH_STATE_DIR/checks-starting" -mmin -2 2> /dev/null)" ] || starting=true
  part=$(mktemp "$status.XXXXXX") || return 1
  if jq -n --argjson host "$host" --argjson starting "$starting" --arg at "$(now_utc)" --argjson epoch "$(date +%s)" '{
      written_at: $at, written_epoch: $epoch,
      free: (($host.free_for_a_ci_run == true) and ($starting | not)),
      checks_starting: $starting,
      ci_running: ((($host.ci_runs_in_progress // []) | length) > 0),
      deployment_settling: ($host.a_deployment_may_be_in_progress == true),
      github_down: ($host.github_is_down != null),
      host_read: ($host | has("free_for_a_ci_run"))}' > "$part" && chmod 0644 "$part" && mv -f "$part" "$status"; then
    return 0
  fi
  rm -f "$part"
  return 1
}

ledger() { node --no-warnings "$ORCH_HOME/lib/ledger.mjs" "$@"; }

# lane_worktree <name>: the worktree of that name, as git knows it. Fails when
# there is none, or more than one.
lane_worktree() {
  local found
  found=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | awk -F/ -v name="$1" '$NF == name')
  [ -n "$found" ] && [ "$(grep -c . <<<"$found")" -eq 1 ] && printf '%s\n' "$found"
}

# terminal <verb> [<argument>...]: what is done with the terminals of the
# lanes, by the adapter the project names ([terminal] adapter: orca when it
# says nothing). The verbs and what each one promises are written at the top
# of lib/terminal/orca.sh; open, show, close, stop, close-worktree,
# remove-worktree, name-worktree, send, has-screen. A name with no adapter
# is said and stops the script, before anything is done with it.
# The project's main checkout is never closed nor removed as a lane, by any
# adapter: the acting lead runs there under [security] agent_user (wake.sh),
# and it is the service's own checkout.
terminal() {
  [ -n "${terminal_loaded:-}" ] || terminal_adapter
  case "$1" in
    close-worktree | remove-worktree)
      if [ "$(realpath -m -- "${2:-}")" = "$(realpath -m -- "$ORCH_REPO")" ]; then
        echo "$(basename "$0"): $ORCH_REPO is the project's main checkout, not the worktree of a lane: it is neither closed nor removed" >&2
        return 1
      fi
      ;;
  esac
  "terminal_${1//-/_}" "${@:2}"
}
terminal_adapter() {
  local name
  name=$(conf_get terminal adapter)
  if ! [[ "$name" =~ ^[a-z0-9-]+$ ]] || [ ! -f "$ORCH_HOME/lib/terminal/$name.sh" ]; then
    die "unknown [terminal] adapter \"$name\" in $ORCH_CONF (known: $(cd "$ORCH_HOME/lib/terminal" && ls -1 -- *.sh | sed 's/\.sh$//' | paste -sd' ' -))"
  fi
  . "$ORCH_HOME/lib/terminal/$name.sh"
  terminal_loaded=$name
}

# update_setting <key>: a setting of [update]. How the checkouts on this
# machine follow their bases is said by the project when it says it, else by
# the settings that come with the tool: a project that keeps its own file
# and says nothing of it does not switch the updates off by leaving it out.
update_setting() {
  conf_get update "$1"
}

# conf_get <section> <key>: one value of agents.conf (empty when absent).
conf_get_from() {
  awk -v section="[$1]" -v wanted="$2" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ {
      i = index($0, "="); if (!i) next
      key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == wanted && !found) { value = substr($0, i + 1); gsub(/^[ \t]+|[ \t]+$/, "", value); found = 1 }
    }
    END { if (!found) exit 1; print value }' "$3"
}
conf_get() {
  local value code=0
  if [ -f "$ORCH_CONF" ] && value=$(conf_get_from "$1" "$2" "$ORCH_CONF"); then
    if [ -z "$value" ] && node "$ORCH_HOME/lib/conf.mjs" required "$1" "$2"; then
      echo "Missing required [$1] $2 in project agents.conf" >&2
      return 2
    fi
  else
    value=$(node "$ORCH_HOME/lib/conf.mjs" default "$1" "$2") || code=$?
    [ "$code" != 2 ] || return 2
    [ "$code" = 0 ] || value=
  fi
  printf '%s\n' "$value"
}

user_message() {
  local language
  language=$(conf_get owner language)
  node "$ORCH_HOME/lib/i18n.mjs" "${language:-en}" "$@"
  printf '\n'
}

# shown_left <record of a request>: of the pull requests the user was shown
# on a ticket and that are not live, how many are still open and how many
# GitHub cannot be asked about, as "<open> <unknown>". One GitHub says
# closed, or merged by another hand, no longer counts.
shown_left() {
  local other state open=0 unknown=0
  while IFS= read -r other; do
    state=$(cd "$ORCH_REPO" && gh pr view "$other" --json state 2> /dev/null | jq -r '.state // empty' 2> /dev/null) || state=
    case "$state" in CLOSED | MERGED) ;; OPEN) open=$((open + 1)) ;; *) unknown=$((unknown + 1)) ;; esac
  done < <(jq -r '.pulls[] | select(.merged_at == null) | .pr' "$1")
  echo "$open $unknown"
}

# A go-live was done, and its ticket could not be closed because GitHub did
# not say what became of another pull request shown on it (merge-pr.sh marks
# the record): asked again at each wake, with no model, under the lock of
# the go-lives since both write these records. Nothing is given up in
# silence: while that pull request is open or unknown, or while tracker does
# not answer or has not written yet who moved the ticket, the mark stays and
# the next wake tries again. The ticket is closed only if it still is where
# the user put it himself; if it is not, it is left as it is, and said.
close_tickets_left_open() {
  local record ticket open unknown code go
  ls "$ORCH_STATE_DIR/validations"/*.json > /dev/null 2>&1 || return 0
  go=$(conf_get tracker go_state)
  (
    flock -n 9 || exit 0
    for record in "$ORCH_STATE_DIR/validations"/*.json; do
      [ "$(jq -r '.closing // false' "$record" 2> /dev/null)" = true ] || continue
      ticket=$(jq -r '.ticket' "$record")
      # The result of a team he did not choose, that GitHub did not close
      # at the go-live of the other: closed here.
      # (One that is closed already, or that somebody merged by hand since,
      # has nothing left to close: the second is said, once.)
      open=$(jq -r '.close // empty' "$record")
      if [ -n "$open" ]; then
        case "$(cd "$ORCH_REPO" && gh pr view "$open" --json state 2> /dev/null | jq -r '.state // empty' 2> /dev/null)" in
          CLOSED) ;;
          MERGED) ledger event --kind ticket_left_open --ticket "$ticket" --value "$open" --detail "#$open, the result of the team the user did not choose for $ticket, was merged by another hand than the script's after the go-live of the one he chose: both are live. Tell the user, nothing else can be done from here" ;;
          OPEN) (cd "$ORCH_REPO" && gh pr close "$open") > /dev/null 2>&1 || continue ;;
          *) continue ;;
        esac
        jq 'del(.close)' "$record" > "$record.next" && mv "$record.next" "$record"
      fi
      read -r open unknown <<<"$(shown_left "$record")"
      [ "$open" = 0 ] && [ "$unknown" = 0 ] || continue
      code=0
      "$ORCH_HOME/tracker.sh" moved-by-owner "$ticket" "$go" || code=$?
      case "$code" in
        0) "$ORCH_HOME/tracker.sh" move "$ticket" "$(conf_get tracker done_state)" > /dev/null || continue ;;
        5 | 6) ledger event --kind ticket_left_open --ticket "$ticket" --detail "everything shown on $ticket is live or closed, but the ticket is no longer in « $go » by the user's own hand (he moved it, or someone else did): the wake leaves it as it is and closes nothing. Tell the user where the ticket stands" ;;
        *) continue ;;
      esac
      jq 'del(.closing)' "$record" > "$record.next" && mv "$record.next" "$record"
    done
  ) 9> "$ORCH_STATE_DIR/merge.lock"
  return 0
}

# conf_keys <section>: the keys of a section, one per line.
conf_keys() {
  if [ -f "$ORCH_CONF" ]; then awk -v section="[$1]" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ { i = index($0, "="); if (i) { key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key); if (!seen[key]++) print key } }' "$ORCH_CONF"; fi
  node "$ORCH_HOME/lib/conf.mjs" default-keys "$1"
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
# separated command prefixes), plus ORCH_NETWORK and ORCH_WRITE for host
# sandbox translation. No section: nothing is set for the provider CLI.
permissions_env() {
  unset ORCH_PERMISSION_MODE ORCH_ALLOW ORCH_DENY ORCH_ADVISOR ORCH_READ ORCH_NETWORK ORCH_WRITE ORCH_ACTIVE_PERMISSION_ROLE
  export ORCH_ACTIVE_PERMISSION_ROLE=$1
  local mode
  # advisor = no: the role runs without the helper model the CLI may consult.
  [ "$(conf_get "permissions.$1" advisor)" != no ] || export ORCH_ADVISOR=no
  mode=$(conf_get "permissions.$1" mode)
  [ -n "$mode" ] || return 0
  export ORCH_PERMISSION_MODE=$mode ORCH_ALLOW ORCH_DENY ORCH_NETWORK ORCH_WRITE
  ORCH_ALLOW=$(conf_get "permissions.$1" allow)
  ORCH_DENY=$(conf_get "permissions.$1" deny)
  if [ -n "$(conf_get security agent_user)" ]; then
    # The agent only edits team files; the dispatcher commits after the run.
    local item agent_allow=
    while IFS= read -r item; do
      item=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"$item")
      case "$item" in 'git add'|'git commit'|'git merge'|'git reset'|'git checkout') ;; *) [ -z "$item" ] || agent_allow="${agent_allow:+$agent_allow, }$item" ;; esac
    done < <(tr ',' '\n' <<<"$ORCH_ALLOW")
    ORCH_ALLOW=$agent_allow
    ORCH_DENY="${ORCH_DENY:+$ORCH_DENY, }git add, git commit, git merge, git reset, git checkout"
  fi
  ORCH_NETWORK=$(conf_get "permissions.$1" network)
  ORCH_NETWORK=${ORCH_NETWORK:-no}
  ORCH_WRITE=$(conf_get "permissions.$1" write)
  ORCH_WRITE=${ORCH_WRITE//\{state\}/"$ORCH_STATE_DIR"}
  ORCH_WRITE=${ORCH_WRITE//\{repo\}/"$ORCH_REPO"}
  if [ "$1" = release-live ]; then
    # An installed project may still carry the old trusted-script grants.
    # They cannot survive the broker upgrade, even before its config is edited.
    ORCH_WRITE=
    local item safe_allow=
    while IFS= read -r item; do
      item=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"$item")
      case "$item" in *merge-pr.sh*|*ask-validation.sh*|*tracker.sh*|*tell-lane.sh*|*review-pr.sh*|*digest-note.sh*|*host-state.sh*) ;; *) [ -z "$item" ] || safe_allow="${safe_allow:+$safe_allow, }$item" ;; esac
    done < <(tr ',' '\n' <<<"$ORCH_ALLOW")
    ORCH_ALLOW="${safe_allow:+$safe_allow, }{orch}/lead-command.mjs, {orch}/release-request.mjs"
  fi
  # {orch} is where these scripts are: a lane is handed the dispatcher's own
  # copy of a script, never the one of the branch it works on.
  ORCH_ALLOW=${ORCH_ALLOW//\{orch\}/"$ORCH_HOME"}
  ORCH_DENY=${ORCH_DENY//\{orch\}/"$ORCH_HOME"}
  # read: folders the role may read beyond its own worktree, separated by
  # commas. {kept} is where what the lanes set apart for the user is kept
  # ([lanes] kept_in): the lead shows it to him. Nothing else is opened.
  ORCH_READ=$(conf_get "permissions.$1" read)
  if [ -n "$ORCH_READ" ]; then
    ORCH_READ=${ORCH_READ//\{kept\}/"$(expand_home "$(conf_get lanes kept_in)")"}
    export ORCH_READ
  fi
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

# flush_outbox: the comments the hourly limit held back (lane-run.sh) leave in
# one grouped comment on the ticket of the reports, as soon as the user may be
# written again. Nothing is removed before tracker has it.
flush_outbox() {
  local box="$ORCH_STATE_DIR/tracker-outbox" sending grouped file count code left
  # What a wake killed while sending had taken aside comes back first.
  for left in "$box"/sending.*; do
    [ -d "$left" ] || continue
    mv "$left"/*.md "$box"/ 2> /dev/null || true
    rmdir "$left" 2> /dev/null || true
  done
  ls "$box"/*.md > /dev/null 2>&1 || return 0
  # Taken aside first: a report that arrives while these are sent is not
  # among them, and stays for the next time.
  sending=$(mktemp -d "$box/sending.XXXXXX")
  mv "$box"/*.md "$sending"/
  count=$(ls -1 "$sending" | grep -c .)
  grouped=$(mktemp)
  {
    user_message grouped_reports "count=$count"
    for file in "$sending"/*.md; do
      printf '\n### %s\n\n' "$(basename "$file" | sed 's/--.*//')"
      cat "$file"
    done
  } > "$grouped"
  code=0
  "$ORCH_HOME/tracker.sh" comment "$(conf_get lead report_on)" "$grouped" "$(user_message grouped_sender)" > /dev/null || code=$?
  rm -f "$grouped"
  # Not sent: back where they were, for the next wake.
  [ "$code" = 0 ] || mv "$sending"/*.md "$box"/
  rm -rf "$sending"
  return 0
}

# open_queued_reviews: the reviews review-pr.sh could not open at once, opened
# now if they may, oldest first, one a wake. No model: the same script, with
# the same rules. A failure that may pass (GitHub or the network not
# answering) is tried again at every wake for an hour. One that will never
# open (already reviewed, pull request closed), one that kept failing for
# that hour, and an entry that cannot be read leave the queue: each is
# written to the ledger (review_dropped) and told to the lead at its next
# wake, as a review to ask for again.
open_queued_reviews() {
  local queue="$ORCH_STATE_DIR/reviews-queue" entry pr ticket author code limit recent since why
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  for entry in "$queue"/*.json; do
    jq -e '(.pr | type) == "number" and (.ticket | type) == "string"' "$entry" > /dev/null 2>&1 && continue
    ledger event --kind review_dropped --detail "an entry of the queue of reviews ($(basename "$entry")) cannot be read: removed, the review is to be asked for again"
    rm -f "$entry"
  done
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  limit=$(conf_get review per_hour)
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  recent=$(ledger sql "select count(*) n from runs where role = 'review' and source = 'dispatcher' and started_at >= '$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)'" | jq -r '.[0].n')
  [ "$recent" -lt "$limit" ] || return 0
  while IFS= read -r entry; do
    pr=$(jq -r '.pr' "$entry") ticket=$(jq -r '.ticket' "$entry") author=$(jq -r '.author // ""' "$entry")
    code=0
    why=$(ORCH_FROM_QUEUE=1 "$ORCH_HOME/review-pr.sh" "$pr" "$ticket" ${author:+--author-model "$author"} 2>&1 > /dev/null) || code=$?
    case "$code" in
      0) rm -f "$entry"; return 0 ;;
      5)
        # "Not now" is no failure: the hour of failures, if one had begun, starts again.
        jq 'del(.failing_since)' "$entry" > "$entry.next" && mv "$entry.next" "$entry"
        ;;
      6) drop_queued_review "$entry" "$pr" "$ticket" "$why" ;;
      *)
        # Only a time in the form this script writes counts: anything else
        # (unreadable, or a word date would take for a time to come) is no
        # time, and the hour starts now.
        since=$(jq -r '.failing_since // empty' "$entry")
        if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then since=$(date -d "$since" +%s 2> /dev/null) || since=; else since=; fi
        if [ -z "$since" ]; then
          jq --arg since "$(now_utc)" '.failing_since = $since' "$entry" > "$entry.next" && mv "$entry.next" "$entry"
        elif [ $(( $(date +%s) - since )) -ge 3600 ]; then
          drop_queued_review "$entry" "$pr" "$ticket" "it kept failing for an hour, the last time: $why"
        fi
        ;;
    esac
  done < <(for entry in "$queue"/*.json; do printf '%s\t%s\n' "$(jq -r '.at // ""' "$entry")" "$entry"; done | sort | cut -f2)
  return 0
}

drop_queued_review() {
  ledger event --kind review_dropped --ticket "$3" --detail "the review of #$2 left the queue without opening: $(tr '\n' ' ' <<<"$4" | cut -c1-400)"
  rm -f "$1"
}

# open_queued_merges: the go-lives merge-pr.sh could not do at once, tried
# again now, oldest first, one a wake (a merge takes the host for a while).
# No model: the same script, with every check again. One that is refused for
# good leaves the queue: written to the ledger (merge_refused) and told to
# the lead at its next wake.
open_queued_merges() {
  local queue="$ORCH_STATE_DIR/merge-queue" entry pr ticket said code why hours since attempts max_attempts
  hours=$(conf_get merge queue_hours)
  [[ "$hours" =~ ^[0-9]+$ ]] || hours=24
  max_attempts=$(conf_get merge queue_max_attempts)
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || max_attempts=30
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  while IFS= read -r entry; do
    if ! jq -e '(.pr | type) == "number" and (.ticket | type) == "string"' "$entry" > /dev/null 2>&1; then
      ledger event --kind merge_refused --detail "an entry of the queue of go-lives ($(basename "$entry")) cannot be read: removed, the go-live is to be asked for again"
      rm -f "$entry"
      continue
    fi
    pr=$(jq -r '.pr' "$entry") ticket=$(jq -r '.ticket' "$entry") said=$(jq -r '.announcement // ""' "$entry")
    code=0
    if [ -n "${ORCH_BROKER_SECRET:-}" ]; then
      # Test fixtures execute the old merge checks with a fixture-only key.
      why=$(ORCH_FROM_QUEUE=1 "$ORCH_HOME/merge-pr.sh" "$pr" "$ticket" ${said:+"$said"} 2>&1 > /dev/null) || code=$?
    elif [ -n "$said" ] && [ ! -r "$said" ]; then
      code=69 why="queued announcement cannot be read: $said"
    else
      why=$(ORCH_FROM_QUEUE=1 "$ORCH_HOME/release-request.mjs" request_release "$ticket" "$pr" < "${said:-/dev/null}" 2>&1 > /dev/null) || code=$?
    fi
    # A process crash can also exit 1. Only this broker marker makes it a
    # definitive refusal; otherwise it uses the bounded retry path.
    if [ "$code" = 1 ] && [[ "$why" != release\ broker\ definitive\ refusal$'\n'* ]]; then code=69; fi
    case "$code" in
      0) rm -f "$entry" "$queue/$pr.announcement.md"; return 0 ;;
      1|6)
        ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "the go-live of #$pr left the queue after a definitive broker refusal: $(tr '\n' ' ' <<<"$why" | cut -c1-400)"
        rm -f "$entry" "$queue/$pr.announcement.md"
        ;;
      *)
        attempts=$(jq -r '.attempts // 0' "$entry")
        [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
        if [ "$code" != 5 ]; then
          attempts=$((attempts + 1))
          jq --argjson attempts "$attempts" '.attempts = $attempts' "$entry" > "$entry.next" && mv "$entry.next" "$entry"
        fi
        # Busy waits are bounded by age; other failures also have an attempt cap.
        since=$(jq -r '.at // ""' "$entry")
        if [ "$attempts" -ge "$max_attempts" ] || ! [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || [[ "$since" < "$(date -u -d "$hours hours ago" +%Y-%m-%dT%H:%M:%SZ)" ]]; then
          ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "the go-live of #$pr left the queue after $attempts failed attempts or $hours hours ($(tr '\n' ' ' <<<"$why" | cut -c1-300)): ask for it again"
          rm -f "$entry" "$queue/$pr.announcement.md"
        fi
        ;;
    esac
  done < <(for entry in "$queue"/*.json; do printf '%s\t%s\n' "$(jq -r '.at // ""' "$entry" 2> /dev/null)" "$entry"; done | sort | cut -f2)
  return 0
}

# github_down: what GitHub says is down among the parts the dispatcher needs,
# as its public status page has it: nothing when all is well. Exit 2 when the
# page cannot be read, which says nothing either way. A slowdown is not an
# outage.
github_down() {
  local page
  page=$(curl -fsS --max-time 8 "${ORCH_GITHUB_STATUS:-https://www.githubstatus.com/api/v2/components.json}" 2> /dev/null) || return 2
  jq -e '.components | type == "array"' <<<"$page" > /dev/null 2>&1 || return 2
  jq -r '[.components[] | select(.name == "Git Operations" or .name == "Pull Requests" or .name == "Actions" or .name == "API Requests")
      | select(.status == "major_outage" or .status == "partial_outage") | .name] | join(", ")' <<<"$page"
}

# talk_open: is a discussion open in the lane of the lead? talk.sh writes
# "opening <time>" in the mark before it opens the terminal (good for five
# minutes: Orca may take two to open one), talk-run.sh puts
# its process there and takes the mark away when the conversation ends. A
# mark whose process is gone, or is no longer a conversation (its number was
# given to something else), or an opening that never came, holds nothing.
talk_open() {
  local mark="$ORCH_STATE_DIR/wake/talk" first second
  [ -r "$mark" ] || return 1
  read -r first second 2> /dev/null < "$mark" || return 1
  if [ "$first" = opening ]; then
    [ $(( $(date +%s) - ${second:-0} )) -lt "${ORCH_TALK_OPENING:-300}" ]
  else
    [[ "$first" =~ ^[0-9]+$ ]] && tr '\0' ' ' < "/proc/$first/cmdline" 2> /dev/null | grep -q "talk-run.sh"
  fi
}

# close_old_terminals <lane> <kept>: closes the terminals of the past
# sessions of a lane, all but the last <kept> (run folders are named by their
# time). What a session said stays in its run folder and in the ledger. A
# terminal is closed once; one that is no longer there is forgotten.
close_old_terminals() {
  local lane=$1 kept=$2 env dir handle
  while IFS= read -r env; do
    dir=$(dirname "$env")
    [ -s "$dir/terminal.handle" ] && [ ! -f "$dir/terminal.closed" ] || continue
    handle=$(sed -n '1p' "$dir/terminal.handle")
    if terminal close "$handle"; then
      now_utc > "$dir/terminal.closed"
    fi
  done < <(grep -l -x -F "ORCH_LANE=$lane" "$ORCH_STATE_DIR"/runs/*/lane.env 2> /dev/null | head -n "-$kept")
  return 0
}

# guard_text <file>: refuses, without showing any value, a text the guard of
# the repository would not let out (private terms, secrets, IBANs, addresses,
# phone numbers). For anything a script sends to an outside service: tracker,
# GitHub.
guard_text() {
  local dir ref tool_ref settings terms_setting allowed_setting guard_key
  dir=$(mktemp -d)
  # 1. Its code is the tool's own (lib/guard/). When the tool is a checkout
  # that follows a branch ([update] base), it is the code of that branch,
  # not the files of the checkout: a copy edited by hand (which
  # self-update.sh then refuses to move) does not run an edited guard. When
  # that cannot be (the branch does not carry the guard yet, the tool is a
  # folder of a larger repository), the files are what runs, and it is said
  # each time. ORCH_GUARD_TOOL_REF= (empty) asks for the files: the tests of
  # a change to the guard itself.
  if [ -n "${ORCH_GUARD_TOOL_REF+set}" ]; then tool_ref=$ORCH_GUARD_TOOL_REF; else tool_ref=$(conf_get update base 2> /dev/null || true) tool_ref=${tool_ref:-origin/main}; fi
  if [ -n "$tool_ref" ] && [ "$(git -C "$ORCH_HOME" rev-parse --show-toplevel 2> /dev/null)" = "$(cd "$ORCH_HOME" && pwd -P)" ] \
    && git -C "$ORCH_HOME" cat-file -e "$tool_ref:lib/guard/codex-guard.mjs" 2> /dev/null; then
    git -C "$ORCH_HOME" show "$tool_ref:lib/guard/codex-guard.mjs" > "$dir/codex-guard.mjs" 2> /dev/null || true
    git -C "$ORCH_HOME" show "$tool_ref:lib/guard/private-terms.mjs" > "$dir/private-terms.mjs" 2> /dev/null || true
  else
    [ -z "$tool_ref" ] || echo "$(basename "$0"): the guard runs from the files of this checkout ($ORCH_HOME does not follow $tool_ref, or that branch does not carry lib/guard/)" >&2
    cp "$ORCH_HOME/lib/guard/codex-guard.mjs" "$ORCH_HOME/lib/guard/private-terms.mjs" "$dir/" 2> /dev/null || true
  fi
  [ -s "$dir/codex-guard.mjs" ] && [ -s "$dir/private-terms.mjs" ] || {
    rm -rf "$dir"
    echo "$(basename "$0"): not sent, the guard of the tool (lib/guard/) could not be read" >&2
    return 1
  }
  # 2. What it must know of the project (the fingerprints of its private
  # terms, the values checked by hand as fictitious) is the project's, and
  # is read from what is committed on the default branch of its remote,
  # never from the files of a checkout (a session runs code there) and
  # never at a place a settings file names. Which files: [guard] terms and
  # allowed, as the project's committed settings say there (.cleared/agents.conf).
  # Each names a file, or says
  # « none »; a key left out or misspelt is a refusal, never « no list ».
  # ORCH_GUARD_REF names another ref: the tests, and a project without a
  # remote.
  ref=${ORCH_GUARD_REF:-$(git -C "$ORCH_REPO" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2> /dev/null || true)}
  ref=${ref:-origin/main}
  if ! git -C "$ORCH_REPO" show "$ref:.cleared/agents.conf" > "$dir/settings.conf" 2> /dev/null; then
    echo "$(basename "$0"): not sent, the committed project configuration (.cleared/agents.conf at $ref) could not be read" >&2
    rm -rf "$dir"
    return 1
  fi
  settings=$dir/settings.conf
  while IFS= read -r guard_key; do
    case "$guard_key" in salt|terms|allowed|token_patterns) ;; *) echo "$(basename "$0"): unknown [guard] key $guard_key in committed project configuration" >&2; rm -rf "$dir"; return 1 ;; esac
  done < <(awk '/^\[/{inside=($0=="[guard]");next} inside && $0 !~ /^[[:space:]]*#/ && index($0,"=") {key=substr($0,1,index($0,"=")-1);gsub(/^[[:space:]]+|[[:space:]]+$/,"",key);print key}' "$settings")
  terms_setting=$(conf_get_from guard terms "$settings" 2> /dev/null || true)
  allowed_setting=$(conf_get_from guard allowed "$settings" 2> /dev/null || true)
  if { [ -z "$terms_setting" ] || [ "$terms_setting" = none ]; } && { [ -z "$allowed_setting" ] || [ "$allowed_setting" = none ]; }; then
    echo '{"disabled":true,"hashes":[]}' > "$dir/private-terms.json"
    echo '{"disabled":true,"hashes":[]}' > "$dir/codex-guard-allow.json"
    mkdir -p "$ORCH_STATE_DIR"
    (
      flock -w 30 9 || exit 1
      ledger init > /dev/null || exit 1
      if [ "$(ledger sql "select count(*) as n from events where kind = 'private_terms_disabled'" | jq -r '.[0].n')" = 0 ]; then
        ledger event --kind private_terms_disabled --detail 'No committed private-term fingerprint lists are configured for this project' || exit 1
      fi
    ) 9> "$ORCH_STATE_DIR/guard-disabled.lock" || { rm -rf "$dir"; return 1; }
  else
    if [ -z "$(conf_get_from guard salt "$settings" 2> /dev/null || true)" ]; then
      printf '%s\n' 'Missing committed [guard] salt: add [guard] salt = <random value> to the project agents.conf and commit it before using these fingerprint lists.' >&2
      rm -rf "$dir"
      return 1
    fi
    guard_list "$dir" "$ref" "$settings" terms private-terms.json "of private terms" \
      && guard_list "$dir" "$ref" "$settings" allowed codex-guard-allow.json "of allowed values" || {
      rm -rf "$dir"
      return 1
    }
  fi
  if ! ORCH_GUARD_REF="$ref" node "$dir/codex-guard.mjs" --strict "$1" >&2; then
    rm -rf "$dir"
    echo "$(basename "$0"): not sent, the guard refuses this text" >&2
    return 1
  fi
  rm -rf "$dir"
}

# guard_list <dir> <ref> <settings> <key> <file> <what>: one list of the
# project put where the guard reads it, as its settings name it.
guard_list() {
  local value
  value=$(conf_get_from guard "$4" "$3" 2> /dev/null || true)
  case "$(tr '[:upper:]' '[:lower:]' <<<"$value")" in
    "")
      echo "$(basename "$0"): not sent, the project names no list $6 ([guard] $4): write the file path or 'none'" >&2
      return 1
      ;;
    none) echo '{"disabled":true,"hashes":[]}' > "$1/$5" ;;
    *)
      git -C "$ORCH_REPO" show "$2:$value" > "$1/$5" 2> /dev/null || {
        echo "$(basename "$0"): not sent, the list $6 of the project ($value on $2) could not be read" >&2
        return 1
      }
      ;;
  esac
}

# lane_deps <worktree>: the dependencies of the project, at hand in that
# worktree. A lane has no network command and may install nothing: the
# dispatcher installs them, once for a given lock file, in the state, and
# every worktree links to them.
# What is installed is what the base asks for, never what the lane wrote: an
# install fetches and runs code with the rights of the dispatcher, outside
# what a lane may do. No script of a package is run either, and nobody
# writes in what is shared but for the scratch folders a build needs. A lane
# whose lock file differs from the one of the base is told (deps_note): what
# it adds is installed once it is on the base. A package that needs its own
# install script to work would fail in the lanes and pass in the checks of
# the pull request, which install it whole: that is where to look first.
# Nothing to do for a project without a lock file.
lane_deps() {
  local worktree=$1 base hash dir new exclude scratch other used
  deps_note=
  base=$(conf_get lanes base)
  git -C "$worktree" cat-file -e "$base:package.json" 2> /dev/null && git -C "$worktree" cat-file -e "$base:package-lock.json" 2> /dev/null || return 0
  hash=$({ git -C "$worktree" show "$base:package.json"; git -C "$worktree" show "$base:package-lock.json"; } | sha256sum | cut -c1-16)
  dir="$ORCH_STATE_DIR/deps/$hash"
  mkdir -p "$ORCH_STATE_DIR/deps"
  (
    flock -w 900 7 || exit 1
    if [ ! -d "$dir/node_modules" ]; then
      new=$(mktemp -d "$ORCH_STATE_DIR/deps/.new.XXXXXX")
      git -C "$worktree" show "$base:package.json" > "$new/package.json"
      git -C "$worktree" show "$base:package-lock.json" > "$new/package-lock.json"
      if (cd "$new" && npm ci --ignore-scripts --no-audit --no-fund > "$new/install.log" 2>&1) && [ -d "$new/node_modules" ]; then
        mv "$new" "$dir"
      else
        echo "$(basename "$0"): the dependencies could not be installed (see $new/install.log)" >&2
        exit 1
      fi
    fi
    # Shared by every lane: read-only, but for where a build writes.
    if [ -w "$dir/node_modules" ]; then
      for scratch in .vite .vite-temp .cache; do mkdir -p "$dir/node_modules/$scratch"; done
      chmod -R a-w "$dir/node_modules"
      for scratch in .vite .vite-temp .cache; do chmod -R u+w "$dir/node_modules/$scratch"; done
    fi
    # Linked while the lock is held: the tidying below, run by another lane
    # being opened, then sees it in use.
    ln -sfn "$dir/node_modules" "$worktree/node_modules"
    # Those of a lock file no worktree uses any more go, once older than an
    # hour: they are only a copy of what can be installed again, and they
    # would pile up.
    used=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r other; do readlink "$other/node_modules" 2> /dev/null || true; done)
    for other in "$ORCH_STATE_DIR/deps"/*/; do
      other=${other%/}
      [[ "$(basename "$other")" =~ ^[0-9a-f]{16}$ ]] && [ "$other" != "$dir" ] || continue
      grep -qxF -- "$other/node_modules" <<<"$used" && continue
      [ -n "$(find "$other" -maxdepth 0 -mmin +60 2> /dev/null)" ] || continue
      chmod -R u+w "$other" 2> /dev/null || true
      rm -rf "$other" 2> /dev/null || true
    done
    # A tidying that fails never keeps a lane from opening.
    true
  ) 7> "$ORCH_STATE_DIR/deps/lock" || return 1
  # The link is not a change of the lane (an ignore rule written for a folder does not hold a link).
  exclude="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  grep -qxF '/node_modules' "$exclude" 2> /dev/null || echo '/node_modules' >> "$exclude"
  if ! git -C "$worktree" show "$base:package.json" | cmp -s - "$worktree/package.json" || ! git -C "$worktree" show "$base:package-lock.json" | cmp -s - "$worktree/package-lock.json"; then
    deps_note=$(node "$ORCH_HOME/lib/i18n.mjs" en dependency_note)
  fi
}

# only_base_merges <commit> <head>: the head holds that commit, and adds on
# top of it nothing but merges of the base that changed nothing by
# themselves. A commit of the lane itself would have been seen by nobody;
# nor would the branch of another lane, which brings commits of its own
# (of one parent, refused below) or a merge that changed something by
# itself (refused too).
only_base_merges() {
  local added parents auto base
  base=$(conf_get lanes base)
  [ "$1" != "$2" ] || return 0
  git -C "$ORCH_REPO" merge-base --is-ancestor "$1" "$2" 2> /dev/null || return 1
  while IFS= read -r added; do
    read -r -a parents < <(git -C "$ORCH_REPO" rev-list --parents -n 1 "$added" | cut -d' ' -f2-)
    [ "${#parents[@]}" = 2 ] || return 1
    auto=$(git -C "$ORCH_REPO" merge-tree --write-tree "${parents[0]}" "${parents[1]}" 2> /dev/null) || return 1
    [ "$auto" = "$(git -C "$ORCH_REPO" rev-parse "$added^{tree}")" ] || return 1
  done < <(git -C "$ORCH_REPO" rev-list "$1..$2" --not "$base")
}

# owner_name: how the agents name the user in what they write (the first
# line of their comments, what the lead is told): [owner] name, for instance.
# The tool carries no name of its own: with no setting, it uses "the user".
# owner_name_first is the same at the
# start of a sentence.
owner_name() {
  local name unnamed="the user"
  name=$(conf_get owner name)
  [ -n "$name" ] || name=$(conf_get tracker owner_name)
  echo "${name:-$unnamed}"
}
owner_name_first() {
  local name
  name=$(owner_name)
  echo "${name^}"
}

# lane_record <ticket>: where what is known of the lane of a ticket is kept
# (its branch, the branch its work is sent to, its pull request, its runs).
# It outlives the worktree: a lane the tidying closed is opened again from it.
lane_record() { echo "$ORCH_STATE_DIR/lanes/$1.json"; }

# teams_of <ticket>: the lanes at work on a ticket, one a line, as
# « <team> <its pull request, or 0> »: the first (1), and the second when
# the user gave the ticket to two teams (<ticket>.2). A lane that is over
# (its record says closed) is no longer one of them.
teams_of() {
  local one team
  for one in "$1" "$1.2"; do
    team=1
    [ "$one" = "$1" ] || team=2
    jq -r --arg team "$team" 'select(type == "object" and (.closed // "") == "") | "\($team) \(.pr // 0)"' "$(lane_record "$one")" 2> /dev/null || true
  done
}

# quoted <file>: a text handed to a model as what somebody wrote, line by
# line under a mark: none of its lines is an order of another kind.
quoted() { sed 's/^/    | /' "$1"; }

# Lanes opened by the dispatcher: branches named <role>/<ticket>.
dispatcher_lanes() {
  local roles
  roles=$(conf_keys roles | paste -sd'|')
  # A worktree named .base-<ticket> is the dispatcher's own, for the time of
  # a merge (flow-lanes.sh): it has the branch of a lane, and is not one.
  git -C "$ORCH_REPO" worktree list --porcelain | awk '/^worktree /{n = split($0, part, "/"); own = part[n] ~ /^\.base-/} /^branch refs\/heads\//{if (!own) print substr($0, 19)}' | grep -E "^($roles)/" || true
}

# Those that take one of the max_lanes places: the roles of [limits]
# counted_roles (every role when it is not set). A lane that only watches or
# reads, like the project lead's, does not hold a place.
counted_lanes() {
  local counted
  counted=$(conf_get limits counted_roles | tr -s ' ' '|')
  if [ -z "$counted" ]; then dispatcher_lanes; else dispatcher_lanes | grep -E "^($counted)/" || true; fi
}

# The line by which the user says what a ticket may cost, as he writes it:
# "Cap 80" or its French equivalent, alone on its line
# (including the spaces a French keyboard puts before ':' and '$').
# A line that continues as a sentence sets nothing. cap_line is the pattern,
# given to jq as $cap; cap_only is the jq test of a comment that says
# nothing else: it sets the cap, and is no word for the lane.
cap_line='^[ \t\x{00A0}\x{202F}]*(?:plafond|cap)[ \t\x{00A0}\x{202F}]*:?[ \t\x{00A0}\x{202F}]*([0-9]+(?:[.,][0-9]+)?)[ \t\x{00A0}\x{202F}]*(?:\$|€|usd|dollars?)?[ \t\x{00A0}\x{202F}]*[.!]?[ \t\x{00A0}\x{202F}]*\r?$'
# Two more lines of his are read by the dispatcher the same way, alone on
# their line: “Teams: both” (or its French equivalent) gives the ticket
# to two teams that work each on its own, and “Team 1” or “Team 2”
# says which of the two results goes live. teams_line and team_line are
# their patterns. cap_only is the jq test of a comment that says nothing but
# such lines: it is read by the dispatcher, and is no word for a lane.
blank='[ \t\x{00A0}\x{202F}]*'
teams_line="^$blank(?:[éÉeE]quipes?$blank:?$blank(?:les$blank)?deux|deux$blank[éÉeE]quipes|teams?$blank:?$blank(?:both|two)|(?:both|two)$blank teams?)$blank[.!]?$blank\\r?\$"
team_line="^$blank(?:[éÉeE]quipe|team)$blank:?$blank([12])$blank[.!]?$blank\\r?\$"
cap_only='(.body | [split("\n")[] | select(test("^\\s*$") | not)] | (length > 0 and all(.[]; test("(?i)" + $cap) or test("(?i)'"${teams_line//\\/\\\\}"'") or test("(?i)'"${team_line//\\/\\\\}"'"))))'

# takes_a_place <role>: whether a lane of that role holds one of them, by the
# same rule: its exact name in counted_roles, or any role when none is set.
takes_a_place() {
  local counted
  counted=$(conf_get limits counted_roles)
  [ -z "$counted" ] || tr -s ' ' '\n' <<<"$counted" | grep -qxF -- "$1"
}

# The forge: which GitHub credential gh and git use here ([forge],
# docs/configuration.md#forge, the code in lib/forge.mjs). With no app
# configured, nothing is changed: gh and git use the ambient credential, as
# they always did, and no node runs for it. With one, every call of gh in
# these scripts goes through the function below, which hands gh the
# installation token for that one call (it never sits in the environment of
# the script, so nothing it starts inherits it), and git finds the token
# through the credential helper lib/forge.mjs names in GIT_CONFIG_* for
# https://github.com (a remote written for SSH included); the account's own
# git configuration file, whose url rewrites could send a push to SSH around
# the app, is not read. The commits the
# dispatcher makes take the app's identity (GIT_AUTHOR_* and
# GIT_COMMITTER_*). Configured and failing (a key missing, a wrong mode, the
# app suspended, no network), gh stops with the reason and the setting to
# look at; it never falls back to the ambient credential.
# forge_wanted: does the project name an app (its keys, or use_tracker_app)?
# [forge] adapter alone names none, and starts no node.
forge_wanted() {
  [ -f "$ORCH_CONF" ] || return 1
  awk '
    /^\[/ { section = $0; next }
    $0 ~ /^[ \t]*#/ { next }
    {
      i = index($0, "="); if (!i) next
      key = substr($0, 1, i - 1); value = substr($0, i + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", key); gsub(/^[ \t]+|[ \t]+$/, "", value)
      if (seen[section, key]++ || value == "") next
      if (section == "[forge]" && key ~ /^(app_id|installation_id|app_private_key_file)$/) forge = 1
      if (section == "[forge]" && key == "use_tracker_app" && value != "no") forge = 1
    }
    END { exit !forge }' "$ORCH_CONF"
}
forge_setup() {
  CLEARED_FORGE_MODE=ambient CLEARED_FORGE_LOGIN= CLEARED_FORGE_ERROR=
  forge_wanted || return 0
  local lines said why
  said=$(mktemp)
  if ! lines=$(node --no-warnings "$ORCH_HOME/lib/forge.mjs" shell 2> "$said"); then
    # Why, from the first line node wrote (it mints nothing here: no token
    # can be in it), kept to characters that are safe inside quotes.
    why=$(sed -n '1p' "$said" | tr -cd '[:alnum:] ._:/()[]=,+-' | cut -c1-200)
    rm -f "$said"
    CLEARED_FORGE_MODE=error CLEARED_FORGE_ERROR="forge credential: [forge] could not be applied, lib/forge.mjs failed${why:+ ($why)}; forge calls stop, the ambient credential is not used"
    unset GH_TOKEN GITHUB_TOKEN
    forge_git_closed "$CLEARED_FORGE_ERROR"
    return 0
  fi
  cat "$said" >&2
  rm -f "$said"
  eval "$lines"
  # An ambient GitHub token of the service has no use left here: gh gets the
  # app's, and nothing started from these scripts may take the other one.
  [ "$CLEARED_FORGE_MODE" = ambient ] || unset GH_TOKEN GITHUB_TOKEN
}
# forge_git_closed <reason>: when lib/forge.mjs cannot even say what to do,
# git gets the same settings it would have given, with a helper and an SSH
# command that only refuse with the reason: git, like gh, stops instead of
# using the ambient credential. (The reason holds no quote nor $.)
forge_git_closed() {
  local count=${GIT_CONFIG_COUNT:-0} index
  local entries=(
    "credential.https://github.com.helper" ""
    "credential.https://github.com.helper" "!f() { echo \"cleared $1\" >&2; echo quit=1; }; f"
    "url.https://github.com/.insteadOf" "git@github.com:"
    "url.https://github.com/.insteadOf" "ssh://git@github.com/"
    "http.https://github.com/.extraHeader" "")
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  for ((index = 0; index < ${#entries[@]}; index += 2)); do
    export "GIT_CONFIG_KEY_$count=${entries[index]}" "GIT_CONFIG_VALUE_$count=${entries[index + 1]}"
    count=$((count + 1))
  done
  export GIT_CONFIG_COUNT=$count GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="f() { echo \"cleared $1\" >&2; exit 1; }; f"
}
gh() {
  case "${CLEARED_FORGE_MODE:-ambient}" in
    ambient) command gh "$@" ;;
    app)
      local forge_token
      forge_token=$(node --no-warnings "$ORCH_HOME/lib/forge.mjs" token) || return 1
      # No debug switch may print the token's header (lib/forge.mjs DEBUG_VARIABLES).
      (
        unset GH_DEBUG DEBUG GIT_TRACE GIT_TRACE_CURL GIT_CURL_VERBOSE GIT_TRACE_REDACT
        GH_TOKEN=$forge_token GITHUB_TOKEN=$forge_token command gh "$@"
      )
      ;;
    *)
      echo "$(basename "$0"): $CLEARED_FORGE_ERROR" >&2
      return 1
      ;;
  esac
}
# forge_secret_paths: what of the forge only the service account may read,
# one path a line: the app's private key ([forge] app_private_key_file, or
# the tracker's when use_tracker_app = yes lends it) and the token cache.
# serve/install.sh probes that the agents' account reaches none of them.
forge_secret_paths() {
  local key
  key=$(conf_get forge app_private_key_file) || key=
  if [ -z "$key" ] && [ "$(conf_get forge use_tracker_app)" = yes ]; then key=$(conf_get tracker app_private_key_file) || key=; fi
  [ -z "$key" ] || printf '%s\n' "$key"
  printf '%s\n' "$ORCH_STATE_DIR/forge" "$ORCH_STATE_DIR/forge/installation-token.json"
}
# forge_harness_unset: the `env -u` arguments (in FORGE_UNSET) a model
# adapter, or a command of a lane, is started with, so that no forge
# credential reaches it: with an app, the GitHub token variables, every
# GIT_CONFIG_* (the credential helper) and the commit identity of the
# dispatcher. None with the ambient credential: nothing changes there.
forge_harness_unset() {
  local name
  FORGE_UNSET=()
  [ "${CLEARED_FORGE_MODE:-ambient}" != ambient ] || return 0
  FORGE_UNSET=(-u GH_TOKEN -u GITHUB_TOKEN -u GIT_CONFIG_PARAMETERS -u GIT_TERMINAL_PROMPT -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM -u GIT_SSH_COMMAND
    -u GH_DEBUG -u DEBUG -u GIT_TRACE -u GIT_TRACE_CURL -u GIT_CURL_VERBOSE -u GIT_TRACE_REDACT
    -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL)
  while IFS= read -r name; do FORGE_UNSET+=(-u "$name"); done < <(compgen -e | grep -E '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$' || true)
}
forge_setup
