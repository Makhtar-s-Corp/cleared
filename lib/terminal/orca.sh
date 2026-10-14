# The terminal adapter for Orca: each session of a lane runs in a terminal of
# Orca, under the worktree it works in, where a person can watch it and type
# in it. Sourced by lib/common.sh (terminal), never executed. Every word said
# to Orca is here, and nowhere else.
#
# The contract, the same for every terminal adapter:
#   terminal_open <worktree> <title> <command> <run dir> [<ticket>]
#       runs the command in the worktree, prints a handle; never waits for its end
#   terminal_show <handle>          "<connected> <worktree path>", nothing when gone
#   terminal_close <handle>         0 once it is closed, or no longer there
#   terminal_stop <handle>          stops a session that runs for too long; 0 as close
#   terminal_close_worktree <path>  closes every terminal in that worktree; fails
#                                   when a session there may still run
#   terminal_remove_worktree <path> removes the worktree
#   terminal_name_worktree <path> <name> <ticket> <comment>   a name a person reads
#   terminal_send <handle> <text>   types the text in the terminal, and Enter
#   terminal_has_screen             0 when a person sees the terminals and types in them

# Orca only knows a new worktree a few seconds after git does, sometimes much
# later: the attempt is repeated for ORCH_ORCA_WAIT seconds (120), then made
# once more. A wait longer than ORCH_ORCA_SLOW seconds (30), and a failure,
# are written to the ledger.
terminal_open() {
  local worktree=$1 title=$2 command=$3 ticket=${5:-} wait=${ORCH_ORCA_WAIT:-120} step=${ORCH_ORCA_STEP:-5} slow=${ORCH_ORCA_SLOW:-30}
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

# Orca that does not answer, or answers without a list, is said and stops the
# script.
terminal_show() {
  local listed
  listed=$(orca terminal list --json 2> /dev/null) || die "Orca did not answer (orca terminal list): nothing done"
  jq -e '(.result.terminals // .result) | type == "array"' <<<"$listed" > /dev/null 2>&1 || die "Orca gave no list of terminals: nothing done"
  jq -r --arg handle "$1" '(.result.terminals // .result)[] | select(.handle == $handle) | "\(.connected) \(.worktreePath)"' <<<"$listed" | sed -n '1p'
}

# Closed with its tab; one that Orca no longer shows is closed already. Orca
# that does not answer closes nothing: the caller tries again later.
terminal_close() {
  local listed
  orca terminal close --terminal "$1" --tab > /dev/null 2>&1 && return 0
  listed=$(orca terminal list --json 2> /dev/null) \
    && jq -e --arg handle "$1" '(.result.terminals // .result) | type == "array" and (any(.handle == $handle) | not)' <<<"$listed" > /dev/null 2>&1
}

# The terminal alone, not its tab: a session stopped before its end. 0 once
# it is closed or no longer there, as for terminal_close: Orca that does not
# answer stops nothing, and the caller tries again later. (What runs in the
# terminal gets its hangup; under [security] agent_user, sudo passes it on
# to the harness, and bubblewrap's sandbox dies with it. Orca names no
# process group: the acting lead, which runs without bubblewrap, is only
# reached by that hangup.)
terminal_stop() {
  local listed
  orca terminal close --terminal "$1" > /dev/null 2>&1 && return 0
  listed=$(orca terminal list --json 2> /dev/null) \
    && jq -e --arg handle "$1" '(.result.terminals // .result) | type == "array" and (any(.handle == $handle) | not)' <<<"$listed" > /dev/null 2>&1
}

terminal_close_worktree() {
  orca terminal close --worktree "path:$1" --all > /dev/null 2>&1 || true
}

# Orca forgets the worktree with it; git removes it when Orca cannot.
terminal_remove_worktree() {
  orca worktree rm --worktree "path:$1" --force > /dev/null 2>&1 || git -C "$ORCH_REPO" worktree remove --force "$1"
}

# The name Orca shows for the worktree, and the ticket it is linked to when
# the tracker is one whose issues Orca links.
terminal_name_worktree() {
  local linked=()
  case "$(conf_get tracker adapter)" in linear) linked=(--linear-issue "$3") ;; esac
  orca worktree set --worktree "path:$1" --display-name "$2" "${linked[@]}" --comment "$4"
}

terminal_send() {
  orca terminal send --terminal "$1" --text "$2" --enter > /dev/null
}

terminal_has_screen() { return 0; }
