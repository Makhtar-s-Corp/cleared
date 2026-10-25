#!/usr/bin/env bash
# What a go-live needs to know of the host (merge-pr.sh, check 5): whether a
# CI run is in progress, whether a deployment is settling, and where each
# open pull request stands. Reads only; one JSON object.
#
#   host-state.sh
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

cd "$ORCH_REPO"
# GitHub down: nothing can be sent, checked or merged, and it may not even
# answer what follows. Said as such, the host is free for nothing.
down=$(github_down) || down=
if [ -n "$down" ]; then
  jq -n --arg down "$down" '{github_is_down: $down, ci_runs_in_progress: [], free_for_a_ci_run: false, free_for_a_merge: false, open_pull_requests: []}'
  exit 0
fi
base=$(conf_get lanes base)
target=${base#origin/}
# Each with its event, branch and commit: merge-pr.sh decides which of them holds a merge on the fast lane.
runs=$(gh run list --limit 20 --json status,headBranch,event,headSha --jq '[.[] | select(.status != "completed") | {branch: .headBranch, event, sha: .headSha}]')
pulls=$(gh pr list --state open --limit 60 --json number,title,headRefName,isDraft,statusCheckRollup --jq '[.[] | {number, title, branch: .headRefName, draft: .isDraft,
  checks: ([.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase] | if any(. == "FAILURE") then "failure" elif any(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING") then "pending" elif any(. == "SUCCESS") then "success" else "none" end)}]')
# A deployment builds its images before any container starts: until ten
# minutes after the last change of the base branch, the host is not free.
merged=$(gh api "repos/{owner}/{repo}/commits/$target" --jq '.commit.committer.date')
since_merge=$(( ($(date +%s) - $(date -d "$merged" +%s)) / 60 ))
jq -n --argjson runs "$runs" --argjson pulls "$pulls" --argjson since_merge "$since_merge" \
  --argjson settling "$(docker ps --format '{{.Status}}' | grep -c -E 'Up ([0-9]+ seconds|About a minute|[1-3] minutes)' || true)" \
  '($since_merge < 10 or $settling > 0) as $deploying
  | {ci_runs_in_progress: $runs, minutes_since_the_last_merge: $since_merge, containers_started_in_the_last_minutes: $settling,
     a_deployment_may_be_in_progress: $deploying,
     free_for_a_ci_run: (($runs | length) == 0 and ($deploying | not)),
     free_for_a_merge: (($runs | length) == 0 and ($deploying | not)),
     open_pull_requests: $pulls}'
