#!/usr/bin/env bash
# Opens the review of a pull request by a model other than the one that wrote
# it: the one way the project lead opens a lane. It decides nothing by
# judgment:
#   - the ticket is given by whoever asks (a pull request may name none, or
#     several: tried, guessing picks the wrong one);
#   - a commit already reviewed is not reviewed again; when an earlier commit
#     of the pull request was, only what changed since is read (--since);
#   - the author is the model of the session of the worktree on that branch
#     (or, for a lane of the dispatcher, the one the ledger has): no known
#     author, no review;
#   - one review at a time for a ticket (the one before, once finished, is
#     closed here), and no more than [review] per_hour an hour. A review
#     lane only reads: it does not wait for the host to be free.
# What the reviewer says comes back to the lead at its next wake (the event
# review_done); nothing is posted to Linear.
#
#   review-pr.sh <pull request number> <ticket> [--author-model <alias>] [--dry-run]
#
# --author-model: for a branch no worktree holds any more (nothing to read
# the author from), the model its lane says it ran on.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

usage="usage: review-pr.sh <pull request number> <ticket> [--author-model <alias>] [--dry-run]"
[ $# -ge 2 ] && [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[A-Z]+-[0-9]+$ ]] || die "$usage"
pr=$1 ticket=$2 dry_run= said_author=
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=--dry-run; shift ;;
    --author-model) said_author=${2:-}; [ -n "$said_author" ] || die "$usage"; shift 2 ;;
    *) die "$usage" ;;
  esac
done
ledger init > /dev/null

# A review lane only reads (no install, no test): it is not one of the heavy
# operations of the host and may open while a CI runs (docs/regles-lanes.md,
# rule of the user of 2026-10-07). Not while GitHub is down.
down=$(github_down) || down=
[ -z "$down" ] || die "GitHub is down ($down): the pull request cannot be fetched, ask again at a later wake"

pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json number,state,title,body,headRefName,headRefOid) || die "pull request #$pr could not be read"
[ "$(jq -r '.state' <<<"$pull")" = OPEN ] || die "pull request #$pr is not open"
head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")

# Already read at this commit: nothing to do. An earlier commit read: only what changed since.
reviewed=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" heads "$pr")
if jq -e --arg head "$head" 'index($head) != null' <<<"$reviewed" > /dev/null; then
  die "pull request #$pr was already reviewed at this commit (${head:0:8}): no second review of the same thing"
fi
git -C "$ORCH_REPO" fetch --quiet origin "$branch" || die "the branch $branch could not be fetched"
since=
while IFS= read -r commit; do
  [ -n "$commit" ] && git -C "$ORCH_REPO" merge-base --is-ancestor "$commit" "origin/$branch" 2> /dev/null && since=$commit
done < <(jq -r '.[]' <<<"$reviewed")

# Who wrote it: the session of the worktree on that branch.
author=
worktree=$(git -C "$ORCH_REPO" worktree list --porcelain | awk -v b="branch refs/heads/$branch" '/^worktree /{w = substr($0, 10)} $0 == b {print w}')
[ -z "$worktree" ] || author=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" author "$worktree")
# What can be read wins over what is said.
[ -n "$author" ] || author=$said_author

# Tried twice without coming to an end (its model failed, or its safeguard
# refused): no third try of the same commit, the user is told instead.
tries=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" tries "$pr" "$head")
[ "$tries" -lt 2 ] || die "$tries reviews of this commit (${head:0:8}) did not come to an end: no other try, say it to the user"

# One review at a time for a ticket, and a few an hour. Checked before the
# lane of the review before is closed: a refusal closes nothing.
lane="review/$ticket"
previous=
if dispatcher_lanes | grep -qxF -- "$lane"; then
  if [ "$(ledger sql "select count(*) n from runs where lane = '$lane' and outcome = 'running'" | jq -r '.[0].n')" != 0 ]; then
    die "a review of $ticket is still running: one at a time"
  fi
  previous=1
fi
limit=$(conf_get review per_hour)
[[ "$limit" =~ ^[0-9]+$ ]] || limit=4
recent=$(ledger sql "select count(*) n from runs where role = 'review' and source = 'dispatcher' and started_at >= '$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)'" | jq -r '.[0].n')
[ "$recent" -lt "$limit" ] || die "$recent reviews were already opened in the last hour (limit: $limit): none opened"
# A finished review holds nothing to keep (the reviewer writes no file of
# the repository, and its report is in the state): closed whatever it left.
if [ -n "$previous" ] && [ -z "$dry_run" ]; then
  "$ORCH_HOME/kill-lane.sh" "$lane" --force > /dev/null \
    || die "the lane of the review before ($lane) could not be closed: no new review of $ticket until it is"
fi

args=(review "$ticket" --pr "$pr" --comment-on none)
[ -z "$since" ] || args+=(--since "$since")
[ -z "$author" ] || args+=(--author-model "$author")
[ -z "$dry_run" ] || args+=(--dry-run)
opened=$("$ORCH_HOME/spawn-lane.sh" "${args[@]}")
printf '%s\n' "$opened"
# The commit this review reads, kept with its run: it counts as reviewed even if the report is lost.
[ -n "$dry_run" ] || printf '%s\n' "$head" > "$(jq -r '.run_dir' <<<"$opened")/reviewed-head" \
  || echo "$(basename "$0"): the commit of this review could not be written down with its run: it only counts once its report exists" >&2
