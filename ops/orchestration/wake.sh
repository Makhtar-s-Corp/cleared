#!/usr/bin/env bash
# The wake of the project lead. Run every minute by a timer; no model unless
# something moved.
#
#   1. Reads Linear and GitHub (scripts only) and compares with what the last
#      wake saw: lib/wake.mjs.
#   2. Nothing moved: writes "wake skipped" to the ledger and stops there.
#      Zero token.
#   3. Something moved: starts one short session of the lead's role, in its
#      one stable lane (release/lead, which Orca shows), with the model the
#      routing table gives that role, and hands it the list of what moved.
#
#   wake.sh [--dry-run]     --dry-run prints what moved and starts nothing
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

dry_run=${1:-}
wake_dir="$ORCH_STATE_DIR/wake"
mkdir -p "$wake_dir"
ledger init > /dev/null

# One wake at a time.
exec 8> "$wake_dir/lock"
flock -n 8 || exit 0

# A session of the lead still at work keeps the next one back: what moved
# meanwhile stays for the wake after it, nothing is lost.
current="$wake_dir/current"
if [ -f "$current" ] && [ ! -f "$(cat "$current")/exit-code" ]; then
  age=$(( ($(date +%s) - $(stat -c %Y "$current")) / 60 ))
  [ "$age" -ge "$(conf_get lead max_minutes)" ] || exit 0
fi

state="$wake_dir/state.json"
# Taken before anything is read: it becomes the time of this wake.
read_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# Linear is asked for what was touched since the last wake, with some overlap;
# what was already seen is told apart by its identifier.
if [ -f "$state" ]; then since=$(date -u -d "$(jq -r '.at' "$state") - 12 minutes" +%Y-%m-%dT%H:%M:%SZ); else since=$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ); fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A source that does not answer: this wake sees nothing and moves nothing.
"$ORCH_HOME/linear.sh" changes "$since" > "$work/linear.json" || die "Linear did not answer: nothing read, nothing moved"
(cd "$ORCH_REPO" && gh pr list --state all --limit 60 --json number,title,headRefName,isDraft,state,updatedAt,statusCheckRollup) > "$work/pulls.json" \
  || die "GitHub did not answer: nothing read, nothing moved"
# What the scripts of the dispatcher posted themselves.
cat "$ORCH_STATE_DIR/linear-comments.jsonl" "$ORCH_STATE_DIR/linear-issues.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
node --no-warnings "$ORCH_HOME/lib/wake.mjs" "$state" "$work/linear.json" "$work/pulls.json" "$work/agent-ids.txt" "$read_at" > "$work/changes.json"
count=$(jq '.events | length' "$work/changes.json")

if [ "$dry_run" = --dry-run ]; then
  jq '.events' "$work/changes.json"
  exit 0
fi

if [ "$count" = 0 ]; then
  [ ! -f "$state" ] || ledger event --kind wake_skipped --detail "nothing moved since $(jq -r '.at' "$state")"
  jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
  exit 0
fi

# Something moved: one short session, with the model of the lead's role.
role=$(conf_get lead role)
routed=$(node "$ORCH_HOME/lib/route.mjs" --role "$role")
chain=$(available_chain "$(jq -c '.chain' <<<"$routed")")
if [ "$(jq length <<<"$chain")" = 0 ]; then
  ledger event --kind model_fallback_failed --detail "project lead: no model of the chain is available ($(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed"))"
  die "no model of the chain is available for the project lead"
fi

# Its one lane, kept from wake to wake and brought to the head of the base.
lane="$role/lead"
worktree="$(expand_home "$(conf_get lanes root)")/$role-lead"
base=$(conf_get lanes base)
git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" || echo "$(basename "$0"): fetch failed, using the local $base" >&2
if [ ! -d "$worktree" ]; then
  git -C "$ORCH_REPO" worktree add --quiet -B "$lane" "$worktree" "$base"
elif [ -n "$(git -C "$worktree" status --porcelain --untracked-files=no)" ] \
  || [ "$(git -C "$worktree" rev-list --count "$base..HEAD")" != 0 ] \
  || ! git -C "$worktree" merge --quiet --ff-only "$base" 2> /dev/null; then
  # Nothing is ever thrown away here: someone, or a session, left work in it
  # (a changed file, a commit of its own). Written to the ledger once, not at
  # every wake; what moved stays for the wake after the lane is looked at.
  if [ ! -f "$wake_dir/blocked" ]; then
    ledger event --kind lead_lane_blocked --detail "the lane of the project lead ($worktree) has changes or commits of its own"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$wake_dir/blocked"
  fi
  die "the lane of the project lead ($worktree) has changes or commits of its own: left untouched, no session started"
fi
rm -f "$wake_dir/blocked"

run_base="lead-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$ORCH_STATE_DIR/runs/$run_base"
mkdir -p "$run_dir"
printf '%s\n' "$chain" > "$run_dir/chain.json"
jq '.events' "$work/changes.json" > "$run_dir/events.json"
live=$(conf_get lead live)
# Until the lead acts through scripts of its own, only observation exists.
[ "$live" != yes ] || die "[lead] live = yes: the acting project lead is not built yet"
{
  cat "$ORCH_HOME/prompts/$role.md"
  printf '\n---\nCe qui a bougé depuis le dernier réveil (%s événement(s)) :\n\n' "$count"
  jq -r '.events[] |
    if .kind == "comment" then "- \(.ticket) (\(.title)) — commentaire de Makhtar, \(.at) : « \(.text) »"
    elif .kind == "ticket_new" then "- \(.ticket) (\(.title)) — nouveau ticket, \(.at), projet \(.project // "aucun") : « \(.text) »"
    elif .kind == "pr_checks" then "- PR #\(.pr) (\(.title), branche \(.branch)) — vérifications : \(.checks)"
    elif .kind == "pr_ready" then "- PR #\(.pr) (\(.title), branche \(.branch)) — prête pour revue, vérifications : \(.checks)"
    elif .kind == "pr_opened" then "- PR #\(.pr) (\(.title), branche \(.branch)) — ouverte en brouillon"
    else "- PR #\(.pr) (\(.title), branche \(.branch)) — \(.kind | sub("pr_"; ""))" end' "$work/changes.json"
} > "$run_dir/prompt.md"
{
  printf 'ORCH_LANE=%q\nORCH_TICKET=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_RULE_NOTE=%q\nORCH_SPAWN_NOTE=%q\n' "$(jq -r '.chain[0].alias' <<<"$routed")" "règle : $(jq -r '.rule' <<<"$routed")" ""
  # While it observes, its decisions stay in its report: nothing is posted.
  printf 'ORCH_COMMENT_ON=%q\nORCH_WRITEUP_ROLE=%q\n' none ""
  printf 'ORCH_PR=%q\nORCH_PR_LINES=%q\nORCH_PROJECT=%q\nORCH_LABEL=%q\n' "" "" "" ""
} > "$run_dir/lane.env"

watching=
[ "$live" = yes ] || watching=" · observation"
open_terminal "$worktree" "$lane · $(jq -r '.[0].alias' <<<"$chain")$watching" "$ORCH_HOME/lane-run.sh $run_dir" > "$run_dir/terminal.handle" \
  || die "Orca did not open the terminal of the project lead; what moved stays for the next wake"

# The session has the events: they are not handed out again.
echo "$run_dir" > "$current"
jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
# How long a comment of the user waited before a session took it.
jq -c '.events[] | select(.kind == "comment")' "$work/changes.json" | while IFS= read -r event; do
  minutes=$(( ($(date +%s) - $(date -d "$(jq -r '.at' <<<"$event")" +%s)) / 60 ))
  ledger event --kind comment_handled --ticket "$(jq -r '.ticket' <<<"$event")" --run-id "$run_base-$role-a1" --value "$minutes" \
    --detail "comment of the user, then the session of the project lead that took it"
done
echo "$run_dir"
