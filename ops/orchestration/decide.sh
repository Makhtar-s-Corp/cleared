#!/usr/bin/env bash
# Proposes the transcription of a decision the user worded during a
# discussion. The one thing a discussion may write, and it sends nothing:
# the text is checked by the guard of the repository and kept, waiting, in
# state/decisions/. It leaves only when the user confirms it himself, with
# confirm-decision.sh, which the session is not allowed to run.
#
#   decide.sh <ticket> - [--adr]       reads the decision on stdin
#
# --adr: the decision is a lasting rule, and the session has written it in
# docs/decisions.md of the worktree of the decisions (that file and nothing
# else must have changed there); it will leave as a draft pull request.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# -ge 2 ] && [ $# -le 3 ] && [ "$2" = - ] || die "usage: decide.sh <ticket> - [--adr]   (the decision on stdin, never a file)"
ticket=$1 adr=
[[ "$ticket" =~ ^[A-Z]+-[0-9]+$ ]] || die "\"$ticket\" is not a ticket"
[ -z "${3:-}" ] || { [ "$3" = --adr ] || die "usage: decide.sh <ticket> - [--adr]"; adr=yes; }
text=$(mktemp)
trap 'rm -f "$text"' EXIT
cat > "$text"
grep -q '[^[:space:]]' "$text" || die "no decision to transcribe"
guard_text "$text" || exit 1

pending="$ORCH_STATE_DIR/decisions/pending"
mkdir -p "$pending"
# One decision at a time: the next one is prepared once the user has
# confirmed or dropped this one (a confirmation sends the whole change made
# to docs/decisions.md, which must be the one he was shown).
[ -z "$(ls -A "$pending")" ] || die "a decision already waits for the user ($(ls "$pending" | paste -sd' ')): he confirms or drops it first (confirm-decision.sh, or --drop)"

if [ -n "$adr" ]; then
  worktree=$(decisions_worktree)
  [ -d "$worktree" ] || die "no worktree of the decisions ($worktree): open a discussion with talk.sh first"
  changed=$(git -C "$worktree" status --porcelain)
  [ "$changed" = " M docs/decisions.md" ] || die "--adr needs a change to docs/decisions.md, and to nothing else, in $worktree (found: ${changed:-nothing}): nothing kept"
fi

id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$pending/$id"
cp "$text" "$pending/$id/text.md"
# What will leave with it, as it is now: the user confirms this, and nothing
# written to the file afterwards.
[ -z "$adr" ] || git -C "$worktree" diff -- docs/decisions.md > "$pending/$id/adr.diff"
jq -n --arg ticket "$ticket" --arg adr "$adr" --arg run "${ORCH_RUN_ID:-}" --arg at "$(now_utc)" '{ticket: $ticket, adr: ($adr == "yes"), run: $run, at: $at}' > "$pending/$id/decision.json"
echo "Décision gardée, rien n'est encore parti. Makhtar la confirme lui-même, en tapant dans cette conversation :"
echo "  ! ops/orchestration/confirm-decision.sh"
echo "(ou, depuis un autre terminal : $ORCH_HOME/confirm-decision.sh $id ; pour l'abandonner : confirm-decision.sh --drop $id)"
