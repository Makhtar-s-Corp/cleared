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
# Exit: the one of the command; 5 the host was not free within the wait;
# 1 the command is not one of the heavy ones.
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
if [ "${CLEARED_HEAVY_SLOT:-}" = "$ORCH_STATE_DIR/heavy.lock" ]; then
  exec "$@"
fi
wait_minutes=$(conf_get lanes heavy_wait_minutes)
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || wait_minutes=30
deadline=$(( $(date +%s) + wait_minutes * 60 ))
mkdir -p "$ORCH_STATE_DIR"
exec 8> "$ORCH_STATE_DIR/heavy.lock"
while :; do
  # Checks the rules have just started (flow-lanes.sh) are not listed by
  # GitHub for some seconds: for two minutes after it, the host is not free.
  if flock -n 8 && [ -z "$(find "$ORCH_STATE_DIR/checks-starting" -mmin -2 2> /dev/null)" ] && [ "$("$ORCH_HOME/host-state.sh" 2> /dev/null | jq -r '.free_for_a_ci_run // false')" = true ]; then break; fi
  flock -u 8 || true
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "$(basename "$0"): the host is not free for a heavy command (checks, a deployment or another screen test are running), and the wait of $wait_minutes minutes is over: \"$asked\" was not run. Say so in your report: the checks of your pull request run the screen tests, and a capture for the user is still to be taken" >&2
    exit 5
  fi
  sleep 20
done
# The door stays held while the command runs (the lock is inherited).
exec "$@"
