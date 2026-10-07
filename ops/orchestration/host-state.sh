#!/usr/bin/env bash
# What the project lead needs to know before it tells a lane to go ahead:
# whether a CI run is in progress, whether a deployment is settling, whether
# a screen test or a capture is running, and where each open pull request
# stands. Reads only; one JSON object.
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
runs=$(gh run list --limit 20 --json status,headBranch,event --jq '[.[] | select(.status != "completed") | {branch: .headBranch, event}]')
pulls=$(gh pr list --state open --limit 60 --json number,title,headRefName,isDraft,statusCheckRollup --jq '[.[] | {number, title, branch: .headRefName, draft: .isDraft,
  checks: ([.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase] | if any(. == "FAILURE") then "failure" elif any(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING") then "pending" elif any(. == "SUCCESS") then "success" else "none" end)}]')
# Screen tests and captures: the commands that run them and their browser,
# read from the process table (lib/screens.mjs), so that one is seen before
# it has opened a browser, and a command line that only names one is not.
screens=$(node --no-warnings "$ORCH_HOME/lib/screens.mjs" "${ORCH_PROC_DIR:-/proc}")
# A deployment builds its images before any container starts: until ten
# minutes after the last change of the base branch, the host is not free.
merged=$(gh api "repos/{owner}/{repo}/commits/$target" --jq '.commit.committer.date')
since_merge=$(( ($(date +%s) - $(date -d "$merged" +%s)) / 60 ))
jq -n --argjson runs "$runs" --argjson pulls "$pulls" --argjson screens "$screens" --argjson since_merge "$since_merge" \
  --argjson settling "$(docker ps --format '{{.Status}}' | grep -c -E 'Up ([0-9]+ seconds|About a minute|[1-3] minutes)' || true)" \
  '($since_merge < 10 or $settling > 0) as $deploying
  | {ci_runs_in_progress: $runs, minutes_since_the_last_merge: $since_merge, containers_started_in_the_last_minutes: $settling,
     a_deployment_may_be_in_progress: $deploying, screen_tests_or_captures_running: $screens,
     free_for_a_ci_run: (($runs | length) == 0 and ($deploying | not)),
     free_for_a_merge: (($runs | length) == 0 and ($deploying | not) and $screens == 0),
     open_pull_requests: $pulls}'
