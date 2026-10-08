#!/usr/bin/env bash
# Asks the user for his agreement to a go-live, the one way it is asked: a
# request on the ticket, in product language (what changes for the user of
# the app, why now, the question; a screenshot named when it is a screen),
# and the ticket put in the status that says "waits for you". He agrees by
# putting it in his own status of agreement; nothing here can do that.
#
#   ask-validation.sh <ticket> <file|-> [--capture <image> [<caption>]]...
#
# - reads the request on stdin. Each capture is a screenshot kept by a lane
# (linear.sh upload says which folders and which files may leave); it is
# shown under the request, with its caption. A change of screen is asked
# for with its capture, or not asked for.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

usage="usage: ask-validation.sh <ticket> <file|-> [--capture <image> [<caption>]]..."
[ $# -ge 2 ] && [[ "$1" =~ ^[A-Z]+-[0-9]+$ ]] || die "$usage"
ticket=$1 source=$2
shift 2
captures=() captions=()
while [ $# -gt 0 ]; do
  [ "$1" = --capture ] && [ -n "${2:-}" ] || die "$usage"
  captures+=("$2")
  shift 2
  if [ $# -gt 0 ] && [ "$1" != --capture ]; then captions+=("$1"); shift; else captions+=("Capture"); fi
done
text=$(mktemp)
trap 'rm -f "$text"' EXIT
if [ "$source" = - ]; then cat > "$text"; else [ -f "$source" ] || die "no such file: $source"; cat "$source" > "$text"; fi
grep -q '[^[:space:]]' "$text" || die "nothing to ask"
validate=$(conf_get linear validate_state)
# Asked once: a ticket that already waits for him is not asked again.
[ "$("$ORCH_HOME/linear.sh" state "$ticket")" != "$validate" ] || die "$ticket already waits for the user in « $validate »: nothing asked again"
# The captures first: a request whose capture cannot be sent is not posted without it.
for index in "${!captures[@]}"; do
  address=$("$ORCH_HOME/linear.sh" upload "${captures[$index]}") || die "the capture ${captures[$index]} could not be sent: nothing asked"
  printf '\n\n**%s**\n\n![%s](%s)\n' "${captions[$index]}" "${captions[$index]}" "$address" >> "$text"
done
"$ORCH_HOME/linear.sh" comment "$ticket" "$text" "${ORCH_SIGNED:-$(conf_get lead name)}" > /dev/null
"$ORCH_HOME/linear.sh" move "$ticket" "$validate"
