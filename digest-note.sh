#!/usr/bin/env bash
# Keeps a note for the morning digest of the user: what he must know and
# what is not worth a message of its own (a red night check and its ticket,
# the lanes that were tidied). The digest reads these notes; nothing is sent
# from here. The text passes the guard like anything meant for him.
#
#   digest-note.sh <file|->
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# = 1 ] || die "usage: digest-note.sh <file|->"
text=$(mktemp)
trap 'rm -f "$text"' EXIT
if [ "$1" = - ]; then cat > "$text"; else [ -f "$1" ] || die "no such file: $1"; cat "$1" > "$text"; fi
grep -q '[^[:space:]]' "$text" || die "nothing to note"
guard_text "$text" || die "the note is refused by the guard: nothing kept"
mkdir -p "$ORCH_STATE_DIR"
jq -nc --arg at "$(now_utc)" --arg from "${ORCH_SIGNED:-script}" --rawfile text "$text" '{at: $at, from: $from, text: ($text | sub("\\s+$"; ""))}' >> "$ORCH_STATE_DIR/digest-notes.jsonl"
