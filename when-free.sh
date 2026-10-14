#!/usr/bin/env bash
# The one door by which a lane runs a heavy command (screen tests, captures):
# when the host is free for it, one at a time. A lane cannot see what the
# host is doing, and a screen test started while the checks of somebody run
# breaks both.
#
#   when-free.sh <command> [<argument>...]
#
# Only the commands [lanes] heavy_commands names go through (the command and
# its first arguments, as written there): this is not a way around what a
# lane may run. It waits up to [lanes] heavy_wait_minutes for the host to be
# free and for the door to be free, then runs the command in the lane.
# Exit: the one of the command; 5 the host was not free within the wait, or
# the door cannot be used (its file cannot be opened, the host status is
# missing or stale): nothing was run; 1 the command is not one of the heavy
# ones.
#
# The door is a file held with flock (lib/common.sh, heavy_lock_path), opened
# read-only: under [security] agent_user the team's account may read it and
# nothing more. Such a team cannot ask the host either (GitHub, the state):
# it reads the host status the service writes next to the door at every wake
# (host_status_write), and an old or missing one counts as « not free ».
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# -ge 1 ] || die "usage: when-free.sh <command> [<argument>...]"
asked="$*"
allowed=
while IFS= read -r named; do
  [ -n "$named" ] || continue
  # A command named by its place (the task script of an adapter): ~ is the home.
  named=$(expand_home "$named")
  case "$asked " in "$named "*) allowed=1 ;; esac
done < <(conf_get lanes heavy_commands | tr ',' '\n' | sed 's/^ *//; s/ *$//')
[ -n "$allowed" ] || die "\"$asked\" is not one of the heavy commands of the project ([lanes] heavy_commands): not run"
# A host Codex session already holds this lock for its whole run. Its heavy
# commands may use this script without waiting on the lock they already hold.
# The command is the lane's: it gets no forge credential (lib/common.sh).
forge_harness_unset
lock=$(heavy_lock_path) || exit 5
if [ "${CLEARED_HEAVY_SLOT:-}" = "$lock" ]; then
  exec env "${FORGE_UNSET[@]}" "$@"
fi
wait_minutes=$(conf_get lanes heavy_wait_minutes)
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || wait_minutes=30
deadline=$(( $(date +%s) + wait_minutes * 60 ))
me=$(basename "$0")
not_run="\"$asked\" was not run. Say so in your report: the checks of your pull request run the screen tests, and a capture for the user is still to be taken"
agent_user=$(conf_get security agent_user)
status=
if [ -n "$agent_user" ]; then
  if heavy_lock_in_state "$lock"; then
    echo "$me: the door of the heavy commands is in Cleared's state ($lock), which this installation's agents' account cannot open: [lanes] heavy_lock must name a file outside it (docs/configuration.md). $not_run" >&2
    exit 5
  fi
  status=$(host_status_path) || exit 5
  if [ ! -r "$status" ]; then
    echo "$me: the host status the service writes for the teams ($status) is missing or unreadable, so whether the host is free is unknown (the wake writes it every minute). $not_run" >&2
    exit 5
  fi
else
  mkdir -p "$ORCH_STATE_DIR"
fi
heavy_lock_open "$lock" 2> /dev/null || {
  echo "$me: the door of the heavy commands ($lock) cannot be opened for reading. $not_run" >&2
  exit 5
}
# host_free: 0 free, 1 busy, 2 the status is too old or cannot be read.
host_free() {
  local written
  if [ -n "$status" ]; then
    written=$(jq -r '.written_epoch // empty' "$status" 2> /dev/null) || return 2
    [[ "$written" =~ ^[0-9]+$ ]] || return 2
    # (A time ahead of this clock by more than a minute is not trusted either.)
    [ $(( $(date +%s) - written )) -le $(( HOST_STATUS_STALE_MINUTES * 60 )) ] && [ $(( written - $(date +%s) )) -le 60 ] || return 2
    [ "$(jq -r '.free == true' "$status" 2> /dev/null)" = true ] || return 1
    return 0
  fi
  # Checks the rules have just started (flow-lanes.sh) are not listed by
  # GitHub for some seconds: for two minutes after it, the host is not free.
  [ -z "$(find "$ORCH_STATE_DIR/checks-starting" -mmin -2 2> /dev/null)" ] || return 1
  [ "$("$ORCH_HOME/host-state.sh" 2> /dev/null | jq -r '.free_for_a_ci_run // false')" = true ] || return 1
}
while :; do
  free=1
  if flock -n "$HEAVY_FD"; then
    host_free && break || free=$?
  fi
  flock -u "$HEAVY_FD" || true
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$free" = 2 ]; then
      echo "$me: the host status the service writes for the teams ($status) is older than $HOST_STATUS_STALE_MINUTES minutes or unreadable, so whether the host is free is unknown (the wake writes it every minute), and the wait of $wait_minutes minutes is over: $not_run" >&2
    else
      echo "$me: the host is not free for a heavy command (checks, a deployment or another screen test are running), and the wait of $wait_minutes minutes is over: $not_run" >&2
    fi
    exit 5
  fi
  sleep 20
done
# The door stays held while the command runs (the lock is inherited).
exec env "${FORGE_UNSET[@]}" "$@"
