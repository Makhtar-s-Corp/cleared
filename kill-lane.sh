#!/usr/bin/env bash
# Closes a lane opened by the dispatcher: its terminals, its worktree and its
# branch. Only branches named <role>/<ticket> can be closed from here.
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
grep -qxF -- "$lane" <<<"$lanes" || die "\"$lane\" is not a lane opened by the dispatcher (open: $(paste -sd' ' <<<"$lanes"))"
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
echo "closed: $lane"
