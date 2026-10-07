#!/usr/bin/env bash
# Transcribes a decision the user worded during a discussion. The one way a
# discussion writes anything:
#   - the text goes through the guard of the repository;
#   - a comment on the ticket in Linear, marked as written by an agent;
#   - one line in the ledger (kind decision, source discussion);
#   - with --adr, the change the session made to docs/decisions.md in the
#     worktree of the decisions is committed there and leaves as a draft pull
#     request (push-lane.sh: that branch only, never forced, never the base).
#     Nothing else may have changed in that worktree.
#
#   decide.sh <ticket> <file|-> [--adr]       - reads the decision on stdin
#
# It decides nothing and checks no wording: that the decision is the user's
# is the rule of the session that calls it (prompts/talk.md).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage: decide.sh <ticket> <file|-> [--adr]"
ticket=$1 adr=
[[ "$ticket" =~ ^[A-Z]+-[0-9]+$ ]] || die "\"$ticket\" is not a ticket"
[ -z "${3:-}" ] || { [ "$3" = --adr ] || die "usage: decide.sh <ticket> <file|-> [--adr]"; adr=1; }
text=$(mktemp)
trap 'rm -f "$text"' EXIT
if [ "$2" = - ]; then cat > "$text"; else [ -f "$2" ] || die "no such file: $2"; cat "$2" > "$text"; fi
grep -q '[^[:space:]]' "$text" || die "no decision to transcribe"
guard_text "$text" || exit 1

role=$(conf_get talk role)
worktree=${ORCH_DECISIONS_WORKTREE:-$(expand_home "$(conf_get lanes root)")/$role-$(conf_get lead report_on)}
if [ -n "$adr" ]; then
  [ -d "$worktree" ] || die "no worktree of the decisions ($worktree): open a discussion with talk.sh first"
  changed=$(git -C "$worktree" status --porcelain)
  [ "$changed" = " M docs/decisions.md" ] || die "--adr needs a change to docs/decisions.md, and to nothing else, in $worktree (found: ${changed:-nothing}): nothing transcribed"
fi

comment=$(mktemp)
{
  printf '**Décision de Makhtar, transcrite pendant une discussion avec le chef de projet**\n\n'
  cat "$text"
  [ -z "$adr" ] || printf '\n\nÉcrite aussi dans `docs/decisions.md` (pull request en brouillon, à fusionner comme les autres).\n'
} > "$comment"
url=$("$ORCH_HOME/linear.sh" comment "$ticket" "$comment" "${ORCH_FROM:-$(conf_get lead name), en discussion}") || { rm -f "$comment"; die "Linear did not take the comment: nothing transcribed"; }
rm -f "$comment"
ledger event --kind decision --source discussion --ticket "$ticket" ${ORCH_RUN_ID:+--run-id "$ORCH_RUN_ID"} \
  --detail "$(tr '\n' ' ' < "$text" | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-600)"
echo "Décision transcrite : $url"

if [ -n "$adr" ]; then
  git -C "$worktree" add docs/decisions.md
  git -C "$worktree" commit --quiet -m "docs: a decision of the user, transcribed in a discussion ($ticket)"
  "$ORCH_HOME/push-lane.sh" "$worktree" || die "the decision is in Linear and in the ledger, but docs/decisions.md did not leave: its commit stays in $worktree"
fi
