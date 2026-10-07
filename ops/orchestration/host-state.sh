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
runs=$(gh run list --limit 20 --json status,headBranch,event --jq '[.[] | select(.status != "completed") | {branch: .headBranch, event}]')
pulls=$(gh pr list --state open --limit 60 --json number,title,headRefName,isDraft,statusCheckRollup --jq '[.[] | {number, title, branch: .headRefName, draft: .isDraft,
  checks: ([.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase] | if any(. == "FAILURE") then "failure" elif any(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING") then "pending" elif any(. == "SUCCESS") then "success" else "none" end)}]')
jq -n --argjson runs "$runs" --argjson pulls "$pulls" \
  --argjson settling "$(docker ps --format '{{.Status}}' | grep -c -E 'Up ([0-9]+ seconds|About a minute|[1-3] minutes)' || true)" \
  --argjson screens "$(pgrep -f 'chromium_headless_shell|headless_shell|run-ui-tests|test:ui|ui-shots|capture-all|playwright' | wc -l)" \
  '{ci_runs_in_progress: $runs, containers_started_in_the_last_minutes: $settling, screen_tests_or_captures_running: $screens,
    free_for_a_ci_run: (($runs | length) == 0 and $settling == 0),
    free_for_a_merge: (($runs | length) == 0 and $settling == 0 and $screens == 0),
    open_pull_requests: $pulls}'
