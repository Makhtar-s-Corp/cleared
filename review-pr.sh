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
#     lane only reads: it does not wait for the host to be free;
#   - a review that cannot open now is not refused and forgotten: it waits
#     in state/reviews-queue/ and the wake opens it as soon as it may.
# What the reviewer says comes back to the lead at its next wake (the event
# review_done); nothing is posted to tracker.
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

# "Not now" is not "no": a review that cannot open yet (the limit of the hour,
# one still running for that ticket, GitHub down) is kept in a queue that the
# wake opens by itself, with no model, as soon as it may. Called from that
# queue, it only says so (exit 5).
author=
# "Never": this review will not open however long it waits (exit 6). Any
# other failure may be a passing one.
never() {
  echo "$(basename "$0"): $1" >&2
  exit 6
}
later() {
  if [ -n "$dry_run" ]; then
    echo "It would wait in the queue: $1"
    exit 0
  fi
  if [ -n "${ORCH_FROM_QUEUE:-}" ]; then
    echo "$(basename "$0"): $1" >&2
    exit 5
  fi
  mkdir -p "$ORCH_STATE_DIR/reviews-queue"
  # Written under another name, then renamed: a wake never reads half an entry.
  jq -n --arg pr "$pr" --arg ticket "$ticket" --arg author "${author:-$said_author}" --arg at "$(now_utc)" --arg why "$1" \
    '{pr: ($pr | tonumber), ticket: $ticket, author: $author, at: $at, why: $why}' > "$ORCH_STATE_DIR/reviews-queue/.$pr.part"
  mv "$ORCH_STATE_DIR/reviews-queue/.$pr.part" "$ORCH_STATE_DIR/reviews-queue/$pr.json"
  user_message review_queued "pr=$pr" "reason=$1"
  exit 0
}

# A review lane only reads (no install, no test): it is not one of the heavy
# operations of the host and may open while a CI runs (docs/regles-lanes.md,
# rule of the user of 2026-10-07). Not while GitHub is down.
down=$(github_down) || down=
[ -z "$down" ] || later "GitHub is unavailable: $down"

pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json number,state,title,body,headRefName,headRefOid) || die "pull request #$pr could not be read"
[ "$(jq -r '.state' <<<"$pull")" = OPEN ] || never "pull request #$pr is not open"
head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")

# Already read at this commit: nothing to do. An earlier commit read: only what changed since.
reviewed=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" heads "$pr")
if jq -e --arg head "$head" 'index($head) != null' <<<"$reviewed" > /dev/null; then
  never "pull request #$pr was already reviewed at this commit (${head:0:8}): no second review of the same thing"
fi
git -C "$ORCH_REPO" fetch --quiet origin "$branch" || die "the branch $branch could not be fetched"
since=
while IFS= read -r commit; do
  [ -n "$commit" ] && git -C "$ORCH_REPO" merge-base --is-ancestor "$commit" "origin/$branch" 2> /dev/null && since=$commit
done < <(jq -r '.[]' <<<"$reviewed")

# In split-account mode, only the service-owned run ledger may identify the
# author. An agent cannot supply this evidence through the lead bridge.
if [ -n "$(conf_get security agent_user)" ]; then
  author=$(ledger sql "select model from runs where pr_number = $pr and role != 'review' and outcome = 'done' and model is not null order by started_at desc limit 1" | jq -r '.[0].model // empty')
  if [ -n "${SUDO_UID:-}" ] && [ -n "$said_author" ]; then never "an agent cannot claim the author model"; fi
fi
# In single-account mode, use the session of the worktree on that branch.
worktree=$(git -C "$ORCH_REPO" worktree list --porcelain | awk -v b="branch refs/heads/$branch" '/^worktree /{w = substr($0, 10)} $0 == b {print w}')
[ -n "$(conf_get security agent_user)" ] || [ -z "$worktree" ] || author=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" author "$worktree")
# What can be read wins over what is said.
[ -n "$author" ] || author=$said_author

# Tried twice without coming to an end (its model failed, or its safeguard
# refused): no third try of the same commit, the user is told instead.
tries=$(node --no-warnings "$ORCH_HOME/lib/reviews.mjs" tries "$pr" "$head")
[ "$tries" -lt 2 ] || never "$tries reviews of this commit (${head:0:8}) did not come to an end: no other try, say it to the user"

# One review at a time for a ticket, and a few an hour. Checked before the
# lane of the review before is closed: a refusal closes nothing.
lane="review/$ticket"
previous=
if dispatcher_lanes | grep -qxF -- "$lane"; then
  if [ "$(ledger sql "select count(*) n from runs where lane = '$lane' and outcome = 'running'" | jq -r '.[0].n')" != 0 ]; then
    later "$(user_message review_ticket_busy "ticket=$ticket")"
  fi
  previous=1
fi
limit=$(conf_get review per_hour)
[[ "$limit" =~ ^[0-9]+$ ]] || limit=4
recent=$(ledger sql "select count(*) n from runs where role = 'review' and source = 'dispatcher' and started_at >= '$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)'" | jq -r '.[0].n')
[ "$recent" -lt "$limit" ] || later "$(user_message review_hour_limit "count=$recent" "limit=$limit")"
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
code=0
opened=$("$ORCH_HOME/spawn-lane.sh" "${args[@]}") || code=$?
# The subscription at its stop: the review waits like one that found no place.
[ "$code" != 4 ] || later "the subscription the reviewer runs on is at its stop"
[ "$code" = 0 ] || exit "$code"
printf '%s\n' "$opened"
# The commit this review reads, kept with its run: it counts as reviewed even if the report is lost.
[ -n "$dry_run" ] || printf '%s\n' "$head" > "$(jq -r '.run_dir' <<<"$opened")/reviewed-head" \
  || echo "$(basename "$0"): the commit of this review could not be written down with its run: it counts as reviewed only once its report exists, and not at all as a try if it fails" >&2
