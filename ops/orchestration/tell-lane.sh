#!/usr/bin/env bash
# Says something to a lane already at work, in its own Orca terminal: the one
# way the project lead answers a lane. The lane is named by its worktree, and
# its terminal is the one written in state/lanes.json; nothing is sent to a
# terminal that is not known for that lane, nor to one that has gone.
#
#   tell-lane.sh <worktree name> <file|->       - reads the message on stdin
#   tell-lane.sh --list                         the lanes that can be told something
#
# Every message is kept in state/lane-messages.jsonl.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

known="$ORCH_STATE_DIR/lanes.json"
[ -f "$known" ] || die "no lane is known yet: $known is missing"
if [ "${1:-}" = --list ]; then
  jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$known"
  exit 0
fi
[ $# -eq 2 ] || die "usage: tell-lane.sh <worktree name> <file|-> | --list"
lane=$1
handle=$(jq -r --arg lane "$lane" '.[$lane] // empty' "$known")
[ -n "$handle" ] || die "\"$lane\" is not a lane that can be told something (known: $(jq -r 'keys | join(" ")' "$known"))"
if [ "$2" = - ]; then text=$(cat); else [ -f "$2" ] || die "no such file: $2"; text=$(cat "$2"); fi
# One paragraph: a line break would send the message before its end.
text=$(printf '%s' "$text" | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')
[ -n "$text" ] || die "nothing to say"

# The terminal must still be there, and be the one of that worktree.
found=$(orca terminal list --json 2> /dev/null | jq -r --arg handle "$handle" '(.result.terminals // .result)[] | select(.handle == $handle) | "\(.connected) \(.worktreePath)"' | sed -n '1p')
[ -n "$found" ] || die "the terminal of \"$lane\" is gone: nothing sent"
case "$found" in "true "*"/$lane") ;; *) die "the terminal written for \"$lane\" is not connected, or is not in its worktree: nothing sent" ;; esac

message="Pour la lane $lane, de la part du $(conf_get lead name) (session courte, il ne lit pas ce terminal en continu) : $text Réponds par un rapport en dernier message de ce terminal, en commençant par « Pour le chef de projet »."
orca terminal send --terminal "$handle" --text "$message" --enter > /dev/null || die "Orca did not take the message for \"$lane\""
mkdir -p "$ORCH_STATE_DIR"
jq -nc --arg lane "$lane" --arg at "$(now_utc)" --arg text "$text" --arg run "${ORCH_RUN_ID:-}" '{lane: $lane, at: $at, run: $run, text: $text}' >> "$ORCH_STATE_DIR/lane-messages.jsonl"
echo "told: $lane"
