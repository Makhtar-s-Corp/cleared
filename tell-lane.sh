#!/usr/bin/env bash
# Says something to a lane already at work, in its own Orca terminal: the one
# way the project lead answers a lane. The lane is named by its worktree, and
# its terminal is the one adopt-lane.sh wrote in state/lanes.json; nothing is
# sent to a terminal that is not known for that lane, nor to one that has
# gone. A lane is never told to merge or to force anything, and no more than
# a few messages an hour go to one lane.
#
#   tell-lane.sh <worktree name> <file|->       - reads the message on stdin
#   tell-lane.sh <ticket> <file|->              a lane the dispatcher opened on that ticket: kept, and
#                                               handed to it at a session the rules open for that
#   tell-lane.sh --list                         the lanes that can be told something
#
# Every message is kept in state/lane-messages.jsonl.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

known="$ORCH_STATE_DIR/lanes.json"
# The lanes the dispatcher opened on a ticket, and that are not over.
of_tickets() {
  local record
  for record in "$ORCH_STATE_DIR/lanes"/*.json; do
    [ -f "$record" ] || continue
    jq -r 'select(type == "object" and (.ticket | type) == "string" and (.closed // "") == "") | .ticket' "$record" 2> /dev/null || true
  done
}
if [ "${1:-}" = --list ]; then
  [ ! -f "$known" ] || jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$known"
  of_tickets | sort -u | sed 's/$/\tlane of the dispatcher: handed at its next session/'
  exit 0
fi
[ $# -eq 2 ] || die "usage: tell-lane.sh <worktree name | ticket> <file|-> | --list"
lane=$1
ticket= team=
! of_tickets | grep -qxF -- "$lane" || ticket=$lane
# One of the two teams of a ticket given to two: <ticket>.1 or <ticket>.2.
# The ticket alone speaks to both.
if [ -z "$ticket" ] && [[ "$lane" =~ ^(.+)\.([12])$ ]] && of_tickets | grep -qxF -- "${BASH_REMATCH[1]}"; then
  ticket=${BASH_REMATCH[1]} team=${BASH_REMATCH[2]}
fi
handle=
if [ -z "$ticket" ]; then
  [ -f "$known" ] || die "\"$lane\" is not a lane that can be told something: no lane is known yet"
  handle=$(jq -r --arg lane "$lane" '.[$lane] // empty' "$known")
  [ -n "$handle" ] || die "\"$lane\" is not a lane that can be told something (known: $(jq -r 'keys | join(" ")' "$known") $(of_tickets | tr '\n' ' '))"
fi
if [ "$2" = - ]; then text=$(cat); else [ -f "$2" ] || die "no such file: $2"; text=$(cat "$2"); fi
# One paragraph: a line break would send the message before its end.
text=$(printf '%s' "$text" | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')
[ -n "$text" ] || die "nothing to say"
# What a lane may never be told through here, whatever the lead judged: to
# merge, or to force anything. Merging is not the lane's, and not the lead's
# to hand out. A net (lib/lane-message.mjs), not the control.
if ! refused=$(node --no-warnings "$ORCH_HOME/lib/lane-message.mjs" <<<"$text"); then
  die "a lane is never told to merge or to force anything (« $refused »): nothing sent. To bring main into a branch, say « réintègre main »; otherwise say who merges (« je fusionnerai ») or that the lane does not (« ne fusionne pas »)"
fi
# A lead and a lane answering each other in a loop would start a model at
# every turn: no more than a few messages an hour to one lane.
limit=$(conf_get lead messages_per_lane_per_hour)
recent=$(jq -R -r --arg lane "$lane" --arg since "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" 'fromjson? | select(.lane == $lane and .at > $since) | .at' "$ORCH_STATE_DIR/lane-messages.jsonl" 2> /dev/null | grep -c . || true)
[ "$recent" -lt "${limit:-6}" ] || die "\"$lane\" was already told $recent times in the last hour: nothing sent, say it to the user instead"

# A lane of the dispatcher runs sessions that read no terminal, and is closed
# between them: what it is told is kept, and handed to it, quoted, at a
# session the rules open for that once the one at work is over
# (flow-lanes.sh). One line, appended: nothing else writes this file.
if [ -n "$ticket" ]; then
  at=$(now_utc)
  jq -nc --arg at "$at" --arg text "$text" --arg run "${ORCH_RUN_ID:-}" --arg team "$team" '{at: $at, run: $run, text: $text} + (if $team != "" then {team: $team} else {} end)' >> "$ORCH_STATE_DIR/lanes/$ticket.told.jsonl"
  jq -nc --arg lane "$lane" --arg at "$at" --arg text "$text" --arg run "${ORCH_RUN_ID:-}" '{lane: $lane, at: $at, run: $run, text: $text}' >> "$ORCH_STATE_DIR/lane-messages.jsonl"
  echo "kept for the lane of $ticket${team:+ (team $team)}: handed to it at its next session, which the rules open once the one at work is over"
  exit 0
fi

# The terminal must still be there, and be the one of that worktree: the
# whole path git gives, not a folder of the same name somewhere else.
worktree=$(lane_worktree "$lane") || die "git knows no worktree named \"$lane\" (or several): nothing sent"
found=$(orca_terminal "$handle")
[ -n "$found" ] || die "the terminal of \"$lane\" is gone: nothing sent"
[ "$found" = "true $worktree" ] || die "the terminal written for \"$lane\" is not connected, or is not in its worktree: nothing sent"

message="Pour la lane $lane, de la part du $(conf_get lead name) (session courte, il ne lit pas ce terminal en continu) : $text Si tu as quelque chose à lui demander ou à lui rendre, écris-le en dernier message de ce terminal, en commençant par « Pour le chef de projet ». Un simple accusé de réception n'est pas nécessaire."
orca terminal send --terminal "$handle" --text "$message" --enter > /dev/null || die "Orca did not take the message for \"$lane\""
mkdir -p "$ORCH_STATE_DIR"
jq -nc --arg lane "$lane" --arg at "$(now_utc)" --arg text "$text" --arg run "${ORCH_RUN_ID:-}" '{lane: $lane, at: $at, run: $run, text: $text}' >> "$ORCH_STATE_DIR/lane-messages.jsonl"
echo "told: $lane"
