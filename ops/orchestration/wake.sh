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
#   wake.sh --handover <file>
#       the first wake of a lead that takes over: whatever moved or not, one
#       session rereads the handover in <file> and says, in the ticket of
#       [lead] report_on, what it understood and what it would do first. It
#       takes no ticket. What moved is left for the wakes after it.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

dry_run= handover=
case "${1:-}" in
  --dry-run) dry_run=1 ;;
  --handover)
    handover=${2:-}
    [ -f "$handover" ] || die "usage: wake.sh --handover <file>: no such file \"$handover\""
    [ -n "$(conf_get lead report_on)" ] || die "[lead] report_on names no ticket: the lead would have nowhere to answer"
    ;;
  "") ;;
  *) die "usage: wake.sh [--dry-run | --handover <file>]" ;;
esac
wake_dir="$ORCH_STATE_DIR/wake"
mkdir -p "$wake_dir"
ledger init > /dev/null

# One wake at a time.
# An ordinary wake that finds another one at work, or a session of the lead
# still running, leaves quietly: it comes back in a minute. A handover is
# asked for by someone who must know that nothing started.
busy() {
  [ -z "$handover" ] || die "$1: nothing started"
  exit 0
}
exec 8> "$wake_dir/lock"
flock -n 8 || busy "another wake is at work"

# A session of the lead still at work keeps the next one back: what moved
# meanwhile stays for the wake after it, nothing is lost.
current="$wake_dir/current"
if [ -f "$current" ] && [ ! -f "$(cat "$current")/exit-code" ]; then
  age=$(( ($(date +%s) - $(stat -c %Y "$current")) / 60 ))
  [ "$age" -ge "$(conf_get lead max_minutes)" ] || busy "a session of the project lead is still running"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
state="$wake_dir/state.json"
count=0
if [ -z "$handover" ]; then
  # Taken before anything is read: it becomes the time of this wake.
  read_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  # Linear is asked for what was touched since the last wake, with some overlap;
  # what was already seen is told apart by its identifier.
  # A state file that cannot be read is no state: this wake starts over as a
  # first one (lib/wake.mjs does the same with it).
  last=$(jq -r '.at // empty' "$state" 2> /dev/null || true)
  if [ -n "$last" ] && since=$(date -u -d "$last - 12 minutes" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null); then
    :
  else
    last=
    since=$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ)
    [ ! -f "$state" ] || echo "$(basename "$0"): $state cannot be read: starting over as a first wake" >&2
  fi

  # A source that does not answer: this wake sees nothing and moves nothing.
  "$ORCH_HOME/linear.sh" changes "$since" > "$work/linear.json" || die "Linear did not answer: nothing read, nothing moved"
  (cd "$ORCH_REPO" && gh pr list --state all --limit 60 --json number,title,headRefName,isDraft,state,updatedAt,statusCheckRollup) > "$work/pulls.json" \
    || die "GitHub did not answer: nothing read, nothing moved"
  # What the scripts of the dispatcher posted themselves.
  cat "$ORCH_STATE_DIR/linear-comments.jsonl" "$ORCH_STATE_DIR/linear-issues.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
  node --no-warnings "$ORCH_HOME/lib/wake.mjs" "$state" "$work/linear.json" "$work/pulls.json" "$work/agent-ids.txt" "$read_at" > "$work/changes.json"
  count=$(jq '.events | length' "$work/changes.json")

  if [ -n "$dry_run" ]; then
    jq '.events' "$work/changes.json"
    exit 0
  fi

  if [ "$count" = 0 ]; then
    [ -z "$last" ] || ledger event --kind wake_skipped --detail "nothing moved since $last"
    jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
    exit 0
  fi
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
[ -n "$handover" ] || jq '.events' "$work/changes.json" > "$run_dir/events.json"
live=$(conf_get lead live)
# Until the lead acts through scripts of its own, an ordinary wake only
# observes. The handover wake is the one exception: it answers in one ticket.
[ -n "$handover" ] || [ "$live" != yes ] || die "[lead] live = yes: the acting project lead is not built yet"
if [ -n "$handover" ]; then
  {
    cat "$ORCH_HOME/prompts/handover.md"
    printf '\n---\nLa passation, telle qu'"'"'elle a été écrite et vérifiée :\n\n'
    cat "$handover"
  } > "$run_dir/prompt.md"
  comment_on=$(conf_get lead report_on)
else
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
  # While it observes, its decisions stay in its report: nothing is posted.
  comment_on=none
fi
{
  printf 'ORCH_LANE=%q\nORCH_TICKET=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_RULE_NOTE=%q\nORCH_SPAWN_NOTE=%q\n' "$(jq -r '.chain[0].alias' <<<"$routed")" "règle : $(jq -r '.rule' <<<"$routed")" ""
  printf 'ORCH_COMMENT_ON=%q\nORCH_WRITEUP_ROLE=%q\nORCH_SIGNED=%q\n' "$comment_on" "" "$(conf_get lead name)"
  printf 'ORCH_PR=%q\nORCH_PR_LINES=%q\nORCH_PROJECT=%q\nORCH_LABEL=%q\n' "" "" "" ""
} > "$run_dir/lane.env"

watching=" · observation"
[ -z "$handover" ] || watching=" · passation"
open_terminal "$worktree" "$lane · $(jq -r '.[0].alias' <<<"$chain")$watching" "$ORCH_HOME/lane-run.sh $run_dir" > "$run_dir/terminal.handle" \
  || die "Orca did not open the terminal of the project lead; what moved stays for the next wake"

# The session has the events: they are not handed out again.
echo "$run_dir" > "$current"
if [ -n "$handover" ]; then
  echo "$run_dir"
  exit 0
fi
jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
# How long a comment of the user waited before a session took it.
jq -c '.events[] | select(.kind == "comment")' "$work/changes.json" | while IFS= read -r event; do
  minutes=$(( ($(date +%s) - $(date -d "$(jq -r '.at' <<<"$event")" +%s)) / 60 ))
  ledger event --kind comment_handled --ticket "$(jq -r '.ticket' <<<"$event")" --run-id "$run_base-$role-a1" --value "$minutes" \
    --detail "comment of the user, then the session of the project lead that took it"
done
echo "$run_dir"
