#!/usr/bin/env bash
# Closes a lane opened by the dispatcher: its terminals, its worktree and its
# branch. Only branches named <role>/<ticket> (or <role>/<ticket>.2, the
# second team of a ticket) can be closed from here. What the rules keep of
# the lane says it is over: they do not open it again, and a ticket two
# teams worked on goes on with the one that is left. A lane that only waits
# (its worktree was closed after its session) is closed the same way.
#
#   kill-lane.sh <role>/<ticket> [--force]
#
# Without --force, a lane with uncommitted changes, or with commits that the
# remote does not hold, is left alone.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

lane=${1:?usage: kill-lane.sh <role>/<ticket> [--force]}
force=${2:-}
lanes=$(dispatcher_lanes)
kept=$(lane_record "${lane#*/}")
[ "$(jq -r '.lane // empty' "$kept" 2> /dev/null)" = "$lane" ] || kept=
over() {
  [ -z "$kept" ] || { jq --arg at "$(now_utc)" '. + {closed: (.closed // $at), given_up: true}' "$kept" > "$kept.part" && mv "$kept.part" "$kept"; }
}
if ! grep -qxF -- "$lane" <<<"$lanes"; then
  # No worktree: a lane that waits between two sessions, known by what is kept of it.
  [ -n "$kept" ] || die "\"$lane\" is not a lane opened by the dispatcher (open: $(paste -sd' ' <<<"$lanes"))"
  ledger init > /dev/null
  [ "$(ledger sql "select count(*) n from runs where lane = '$lane' and outcome = 'running'" | jq -r '.[0].n')" = 0 ] || die "a session of $lane is running with no worktree to be found: looked at by hand"
  over
  echo "closed: $lane (it was waiting; its branch on the remote and its pull request are left as they are)"
  exit 0
fi
worktree=$(git -C "$ORCH_REPO" worktree list --porcelain | awk -v b="branch refs/heads/$lane" '/^worktree /{w = substr($0, 10)} $0 == b {print w}')
[ -d "$worktree" ] || die "no worktree for $lane"

if [ "$force" != --force ]; then
  [ -z "$(git -C "$worktree" status --porcelain)" ] || die "$lane has uncommitted changes (use --force to drop them)"
  # Work that would be lost: a commit of the lane that the remote does not
  # hold. Another local branch is not a backup: it can be deleted too.
  own=$(git -C "$worktree" rev-list --count HEAD --not --remotes)
  [ "$own" = 0 ] || die "$lane has $own commit(s) that the remote does not hold (use --force to drop them)"
fi

ledger init > /dev/null
ledger sql "select run_id from runs where lane = '$lane' and outcome = 'running'" | jq -r '.[].run_id' | while IFS= read -r run_id; do
  ledger run-end --run-id "$run_id" --outcome killed
done

orca terminal close --worktree "path:$worktree" --all > /dev/null 2>&1 || true
if ! orca worktree rm --worktree "path:$worktree" --force > /dev/null 2>&1; then
  git -C "$ORCH_REPO" worktree remove --force "$worktree"
fi
git -C "$ORCH_REPO" worktree prune
if git -C "$ORCH_REPO" rev-parse --verify --quiet "refs/heads/$lane" > /dev/null; then
  git -C "$ORCH_REPO" branch -D "$lane" > /dev/null
fi
over
echo "closed: $lane"
