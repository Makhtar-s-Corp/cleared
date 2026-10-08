#!/usr/bin/env bash
# Asks the user for his agreement to a go-live, the one way it is asked: a
# request on the ticket, in product language (what changes for the user of
# the app, why now, the question; a screenshot named when it is a screen),
# and the ticket put in the status that says "waits for you". He agrees by
# putting it in his own status of agreement; nothing here can do that.
#
#   ask-validation.sh <ticket> <file|-> --pr <pull request>... [--capture <image> [<caption>]]...
#
# - reads the request on stdin. He is asked for pull requests, at the version
# each is at now: the request ends with a line that says which, and
# state/validations/<ticket>.json keeps it. His agreement is to that
# version; merge-pr.sh puts nothing else live on it. Each capture is a
# screenshot a lane set apart to be sent (linear.sh upload says from which
# folder); it is shown under the request, with its caption. A change of
# screen is asked for with its capture, or not asked for.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

usage="usage: ask-validation.sh <ticket> <file|-> --pr <pull request>... [--capture <image> [<caption>]]..."
[ $# -ge 2 ] && [[ "$1" =~ ^[A-Z]+-[0-9]+$ ]] || die "$usage"
ticket=$1 source=$2
shift 2
pulls=() captures=() captions=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || die "$usage"
      pulls+=("$2")
      shift 2
      ;;
    --capture)
      [ -n "${2:-}" ] || die "$usage"
      captures+=("$2")
      shift 2
      if [ $# -gt 0 ] && [ "$1" != --capture ] && [ "$1" != --pr ]; then captions+=("$1"); shift; else captions+=("Capture"); fi
      ;;
    *) die "$usage" ;;
  esac
done
[ "${#pulls[@]}" -gt 0 ] || die "$usage"
text=$(mktemp)
trap 'rm -f "$text"' EXIT
if [ "$source" = - ]; then cat > "$text"; else [ -f "$source" ] || die "no such file: $source"; cat "$source" > "$text"; fi
grep -q '[^[:space:]]' "$text" || die "nothing to ask"
validate=$(conf_get linear validate_state)
# The version of each pull request, now.
shown='[]' versions= asked_pulls=
for pr in "${pulls[@]}"; do
  pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json state,headRefOid) || die "pull request #$pr could not be read"
  [ "$(jq -r '.state' <<<"$pull")" = OPEN ] || die "#$pr is not open: nothing asked"
  head=$(jq -r '.headRefOid' <<<"$pull")
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "the version of #$pr could not be read"
  shown=$(jq -c --argjson pr "$pr" --arg head "$head" '. + [{pr: $pr, head: $head}]' <<<"$shown")
  versions="${versions:+$versions, }PR $pr à ${head:0:8}"
  asked_pulls="${asked_pulls:+$asked_pulls }$pr:$head"
done
# Asked once for a version: a ticket that already waits for him with these
# very versions is not asked again. A version pushed since is a new request.
# What he was shown before of the other pull requests of the ticket stays:
# his agreement to them still stands.
kept="$ORCH_STATE_DIR/validations/$ticket.json"
# This record is also written by a go-live and by the wake: under the same
# lock as them, from its reading to its writing.
mkdir -p "$ORCH_STATE_DIR/validations"
exec 9> "$ORCH_STATE_DIR/merge.lock"
flock -w "${ORCH_LOCK_WAIT:-60}" 9 || die "a go-live is being done: nothing asked, ask again in a minute"
before=$(jq -c '[.pulls[]]' "$kept" 2> /dev/null) || before='[]'
if [ "$("$ORCH_HOME/linear.sh" state "$ticket")" = "$validate" ] && [ "$(jq -c --argjson shown "$shown" '[.[] | {pr, head}] as $kept | $shown - $kept | length' <<<"$before")" = 0 ]; then
  die "$ticket already waits for the user in « $validate » for these versions: nothing asked again"
fi
all=$(jq -c --argjson shown "$shown" '[.[] | select(.pr as $pr | $shown | map(.pr) | index($pr) | not)] + $shown | sort_by(.pr)' <<<"$before")
# A request is made whole: its text on the ticket, the card moved, what was
# shown kept. If the card cannot be moved once the text is written, nothing
# is kept yet, the script says so, and the same request asked again is
# finished without being written to him a second time.
pending="$ORCH_STATE_DIR/validations/$ticket.pending"
request=$({ cat "$text"; echo "$shown"; printf '%s\n' ${captures[@]+"${captures[@]}"}; } | sha256sum | cut -d' ' -f1)
if [ "$(cat "$pending" 2> /dev/null)" != "$request" ]; then
  # The captures first: a request whose capture cannot be sent is not posted without it.
  for index in "${!captures[@]}"; do
    address=$("$ORCH_HOME/linear.sh" upload "${captures[$index]}") || die "the capture ${captures[$index]} could not be sent: nothing asked"
    printf '\n\n**%s**\n\n![%s](%s)\n' "${captions[$index]}" "${captions[$index]}" "$address" >> "$text"
  done
  # A request made again for a pull request says which version the one before
  # was about: the user sees that it is a new one.
  earlier=
  for one in $asked_pulls; do
    was=$(jq -r --argjson pr "${one%%:*}" '.[] | select(.pr == $pr) | .head' <<<"$before" | sed -n '1p')
    [ -z "$was" ] || [ "$was" = "${one#*:}" ] || earlier="${earlier:+$earlier, }${was:0:8}"
  done
  printf '\n\n(Version montrée : %s%s.)\n' "$versions" "${earlier:+ ; la demande précédente portait sur $earlier}" >> "$text"
  "$ORCH_HOME/linear.sh" comment "$ticket" "$text" "${ORCH_SIGNED:-$(conf_get lead name)}" > /dev/null
  printf '%s\n' "$request" > "$pending"
fi
"$ORCH_HOME/linear.sh" move "$ticket" "$validate" \
  || die "the request is written on $ticket, but the card could not be moved to « $validate »: nothing is kept yet. Ask again with the same request: it will be finished without being written to him a second time"
# What else the record holds (a ticket the wake still has to close) is kept.
record=$(jq -c 'if type == "object" then . else {} end' "$kept" 2> /dev/null) || record=
[ -n "$record" ] || record='{}'
jq --arg ticket "$ticket" --arg at "$(now_utc)" --argjson pulls "$all" '. + {ticket: $ticket, at: $at, pulls: $pulls}' <<<"$record" > "$kept.part" && mv "$kept.part" "$kept"
rm -f "$pending"
