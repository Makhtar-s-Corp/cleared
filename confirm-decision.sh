#!/usr/bin/env bash
# Run by the user, never by a model: confirms a decision a discussion
# proposed with decide.sh, and only then lets it out.
#   - with --adr, the change to docs/decisions.md is committed in the
#     worktree of the decisions and leaves as a draft pull request
#     (push-lane.sh: that branch only, never forced, never the base);
#   - a comment on the ticket in tracker, marked as written by an agent;
#   - one line in the ledger (kind decision, source discussion).
# In that order: what cannot leave stops everything before anything is said
# to be decided, and running it again takes up where it stopped.
#
#   confirm-decision.sh [<id>]        the one waiting, or the one named
#   confirm-decision.sh --list
#   confirm-decision.sh --drop <id>
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

pending="$ORCH_STATE_DIR/decisions/pending"
mkdir -p "$pending" "$ORCH_STATE_DIR/decisions/done"
waiting() { ls -1 "$pending" 2> /dev/null || true; }
show() {
  local record="$pending/$1/decision.json" adr_suffix=
  [ "$(jq -r '.adr' "$record")" != true ] || adr_suffix=$(user_message decision_adr_suffix)
  user_message decision_listing "ticket=$(jq -r '.ticket' "$record")" "adr=$adr_suffix" "at=$(jq -r '.at' "$record")"
}
case "${1:-}" in
  --list)
    for id in $(waiting); do
      echo "$id : $(show "$id")"
      sed 's/^/    /' "$pending/$id/text.md"
      [ ! -s "$pending/$id/adr.diff" ] || sed -n '/^@@/,$p' "$pending/$id/adr.diff" | sed 's/^/    | /'
    done
    exit 0
    ;;
  --drop)
    [ -n "${2:-}" ] && [ -d "$pending/$2" ] || die "usage: confirm-decision.sh --drop <id> (waiting: $(waiting | paste -sd' '))"
    mv "$pending/$2" "$ORCH_STATE_DIR/decisions/done/$2-dropped"
    user_message decision_dropped "id=$2"
    exit 0
    ;;
esac
id=${1:-}
if [ -z "$id" ]; then
  [ "$(waiting | grep -c .)" = 1 ] || die "$(waiting | grep -c .) decisions are waiting: name one (confirm-decision.sh --list)"
  id=$(waiting)
fi
[ -d "$pending/$id" ] || die "no decision \"$id\" is waiting (confirm-decision.sh --list)"
ticket=$(jq -r '.ticket' "$pending/$id/decision.json")
adr=$(jq -r '.adr' "$pending/$id/decision.json")
run=$(jq -r '.run' "$pending/$id/decision.json")
text="$pending/$id/text.md"
user_message decision_confirmed "ticket=$ticket"
sed 's/^/    /' "$text"

if [ "$adr" = true ] && [ ! -f "$pending/$id/adr.sent" ]; then
  worktree=$(decisions_worktree)
  changed=$(git -C "$worktree" status --porcelain)
  if [ "$changed" = " M docs/decisions.md" ]; then
    # What leaves is what was proposed: a file touched again since then is
    # not what the user is confirming.
    git -C "$worktree" diff -- docs/decisions.md | cmp -s - "$pending/$id/adr.diff" \
      || die "docs/decisions.md changed since this decision was proposed: nothing left. Drop it (--drop $id) and have it proposed again"
    # The user sees the whole change, what it removes included, before
    # anything is committed: the first run shows it, the second one sends.
    if [ ! -f "$pending/$id/adr.shown" ]; then
      user_message decision_diff
      sed -n '/^@@/,$p' "$pending/$id/adr.diff" | sed 's/^/    /'
      now_utc > "$pending/$id/adr.shown"
      user_message decision_preview "id=$id"
      exit 0
    fi
    git -C "$worktree" add docs/decisions.md
    git -C "$worktree" commit --quiet -m "docs: a decision of the user, transcribed in a discussion ($ticket)"
  elif [ -n "$changed" ]; then
    die "$worktree holds something else than a change to docs/decisions.md ($changed): nothing left, the decision still waits"
  fi
  # A commit made by an earlier try that could not leave, or left without
  # its pull request, is sent now: the push script does what is still to do.
  "$ORCH_HOME/push-lane.sh" "$worktree" || die "docs/decisions.md did not leave (its commit stays in $worktree): nothing is transcribed yet, run this again once it can leave"
  now_utc > "$pending/$id/adr.sent"
fi

if [ ! -f "$pending/$id/comment.url" ]; then
  comment=$(mktemp)
  {
    user_message decision_comment "owner=$(owner_name)"
    cat "$text"
    [ "$adr" != true ] || user_message decision_adr_note
  } > "$comment"
  url=$("$ORCH_HOME/tracker.sh" comment "$ticket" "$comment" "$(conf_get lead name), en discussion") || { rm -f "$comment"; die "tracker did not take the comment (see above): the decision still waits, run this again"; }
  rm -f "$comment"
  echo "$url" > "$pending/$id/comment.url"
fi
ledger event --kind decision --source discussion --ticket "$ticket" ${run:+--run-id "$run"} \
  --detail "$(tr '\n' ' ' < "$text" | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-600)"
mv "$pending/$id" "$ORCH_STATE_DIR/decisions/done/$id"
user_message decision_transcribed "url=$(cat "$ORCH_STATE_DIR/decisions/done/$id/comment.url")"
