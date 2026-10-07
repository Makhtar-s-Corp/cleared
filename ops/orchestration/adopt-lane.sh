#!/usr/bin/env bash
# Writes down the terminal of a lane already at work, so that the project
# lead can answer it (tell-lane.sh). Run by whoever hands lanes over to the
# lead, never by the lead itself: a terminal is only written down when Orca
# shows it connected, in the worktree of that name.
#
#   adopt-lane.sh <worktree name> <terminal handle>
#   adopt-lane.sh --forget <worktree name>
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

known="$ORCH_STATE_DIR/lanes.json"
if [ "${1:-}" = --forget ]; then
  [ -n "${2:-}" ] || die "usage: adopt-lane.sh --forget <worktree name>"
  [ -f "$known" ] || exit 0
  jq --arg lane "$2" 'del(.[$lane])' "$known" > "$known.next" && mv "$known.next" "$known"
  exit 0
fi
[ $# -eq 2 ] || die "usage: adopt-lane.sh <worktree name> <terminal handle> | --forget <worktree name>"
lane=$1 handle=$2
found=$(orca terminal list --json 2> /dev/null | jq -r --arg handle "$handle" '(.result.terminals // .result)[] | select(.handle == $handle) | "\(.connected) \(.worktreePath)"' | sed -n '1p')
case "$found" in
  "true "*"/$lane") ;;
  "") die "Orca shows no terminal $handle: nothing written" ;;
  *) die "the terminal $handle is not connected, or is not in the worktree \"$lane\": nothing written" ;;
esac
mkdir -p "$ORCH_STATE_DIR"
[ -f "$known" ] || echo '{}' > "$known"
jq --arg lane "$lane" --arg handle "$handle" '.[$lane] = $handle' "$known" > "$known.next" && mv "$known.next" "$known"
echo "adopted: $lane"
