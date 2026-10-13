#!/usr/bin/env bash
# Opens a conversation between the user and the project lead: one interactive
# session in the lane of the lead, with the model of the role [talk] role and
# a briefing that holds the state of things, gathered here by scripts before
# the model says a word.
#
#   talk.sh [--dry-run]       --dry-run prints the briefing and opens nothing
#
# With [terminal] adapter = none, the conversation is held in the terminal
# talk.sh is run from, and talk.sh returns when it ends.
#
# The session has no right to act: no lane, no merge, no push, no message to
# a lane. It reads. Its one way to write is decide.sh, which transcribes a
# decision the user worded: to the ledger, to tracker, and, for a lasting
# rule, to docs/decisions.md in a worktree of its own (talk/<report ticket>),
# the only file the session may edit.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

dry_run=
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) die "usage: talk.sh [--dry-run]" ;;
esac

role=$(conf_get talk role)
[ -n "$role" ] || die "[talk] role is not set in $ORCH_CONF"
report_on=$(conf_get lead report_on)
[ -n "$report_on" ] || die "[lead] report_on is not set: the decisions need a ticket to hang their branch on"
routed=$(node "$ORCH_HOME/lib/route.mjs" --role "$role")
root=$(expand_home "$(conf_get lanes root)")
base=$(conf_get lanes base)
lead_role=$(conf_get lead role)
lane="$lead_role/lead"
worktree="$root/$lead_role-lead"
decisions="$root/$role-$report_on"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The state of things, read by scripts. A source that does not answer is said
# in the briefing, and does not stop the conversation.
{
  printf "## State read by scripts on %s\n\n" "$(date '+%Y-%m-%d %H:%M')"
  printf "### Host and open pull requests (host-state.sh)\n\n"
  "$ORCH_HOME/host-state.sh" 2> /dev/null | jq -r '
    "- CI runs in progress: \(.ci_runs_in_progress | length) ; minutes since the last merge: \(.minutes_since_the_last_merge) ; screen tests running: \(.screen_tests_or_captures_running) ; free for a merge: \(.free_for_a_merge)",
    (.open_pull_requests[] | "- PR #\(.number) (\(.title)), branch \(.branch), \(if .draft then "draft" else "ready" end), checks: \(.checks)")' \
    || echo "- (host-state.sh did not respond)"
  printf "\n### Waiting for %s in tracker (In Review tickets)\n\n" "$(owner_name)"
  "$ORCH_HOME/tracker.sh" waiting 2> /dev/null | jq -r '.[] | "- \(.identifier) (\(.title)), since \(.since)"' || echo "- (tracker did not respond)"
  printf "\n### Recent comments on %s\n\n" "$report_on"
  "$ORCH_HOME/tracker.sh" comments "$report_on" 2> /dev/null | jq -r 'sort_by(.createdAt) | .[-6:][] | "- \(.createdAt) : \(.body | gsub("\\s+"; " ") | .[0:700])"' || echo "- (tracker did not respond)"
  printf "\n### Active teams the project lead can contact\n\n"
  { [ -f "$ORCH_STATE_DIR/lanes.json" ] && jq -r 'keys[] | "- \(.)"' "$ORCH_STATE_DIR/lanes.json"; } || echo "- (none known)"
  printf "\n### Latest short sessions of the project lead (end of each report)\n\n"
  found=
  while IFS= read -r report; do
    found=1
    printf -- "- %s :\n" "$(basename "$report" .md)"
    sed -n '/^## \(Report\|Compte rendu\)/,/^## \(Changed files\|Fichiers modifiés\)/p' "$report" | sed '1d;$d' | tail -n 14 | sed 's/^/    /'
  done < <(ls -1 "$ORCH_STATE_DIR/reports/" 2> /dev/null | grep "^lead-" | tail -n 3 | sed "s|^|$ORCH_STATE_DIR/reports/|")
  [ -n "$found" ] || echo "- (none)"
  printf "\n### Decisions already recorded during discussions (ledger)\n\n"
  ledger sql "select at, ticket, detail from events where kind = 'decision' order by at desc limit 10" 2> /dev/null | jq -r 'if length == 0 then "- (none)" else .[] | "- \(.at), \(.ticket // "no ticket") : \(.detail)" end' || echo "- (none)"
} > "$work/state.md"

{
  told=$(prompt_text "$(prompt_file talk)") || exit 1
  told=${told//@DECISIONS@/"$decisions/docs/decisions.md"}
  printf '%s\n' "${told//@REPORT_ON@/"$report_on"}"
  printf '\n---\n'
  cat "$work/state.md"
} > "$work/prompt.md"

if [ -n "$dry_run" ]; then
  cat "$work/prompt.md"
  exit 0
fi

# Never two agents in the same folder: one conversation at a time, and none
# while a short session of the lead is at work in its lane. Checked and
# marked under the lock of the wakes, so that no wake starts in between.
mkdir -p "$ORCH_STATE_DIR/wake"
exec 8> "$ORCH_STATE_DIR/wake/lock"
flock -w 120 8 || die "a wake of the project lead holds its lock for too long: try again in a minute"
! talk_open || die "a discussion is already open in the lane $lane"
current="$ORCH_STATE_DIR/wake/current"
if [ -f "$current" ] && [ ! -f "$(cat "$current")/exit-code" ] && [ $(( ($(date +%s) - $(stat -c %Y "$current")) / 60 )) -lt "$(conf_get lead max_minutes)" ]; then
  die "a short session of the project lead is at work in its lane: try again in a minute or two"
fi

chain=$(available_chain "$(jq -c '.chain' <<<"$routed")")
[ "$(jq length <<<"$chain")" != 0 ] || die "no model of the chain is available for the role $role ($(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed"))"

# The lane of the lead is where the conversation sits; it is created when it
# is not there yet and otherwise left as it is. The decisions have a worktree
# of their own, so that the lane of the lead never holds a changed file.
git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" || echo "$(basename "$0"): fetch failed, using the local $base" >&2
branch_exists() { git -C "$ORCH_REPO" show-ref --verify --quiet "refs/heads/$1"; }
# A branch that exists is taken as it is, never started over: it may hold
# decisions that have not left yet.
add_worktree() { if branch_exists "$1"; then git -C "$ORCH_REPO" worktree add --quiet "$2" "$1"; else git -C "$ORCH_REPO" worktree add --quiet -b "$1" "$2" "$base"; fi; }
# The lane of the lead, when it is made here, is brought to the base like a
# wake does; one that cannot follow is left as it is, and a wake will say so.
[ -d "$worktree" ] || { add_worktree "$lane" "$worktree"; git -C "$worktree" merge --quiet --ff-only "$base" 2> /dev/null || true; }
[ -d "$decisions" ] || add_worktree "$role/$report_on" "$decisions"
# The decisions are written on top of the base as it is now: the base is
# brought into their branch (their last pull request may have been merged,
# as it was or squashed). A branch that cannot take it is said, and left.
if [ -n "$(git -C "$decisions" status --porcelain)" ]; then
  echo "$(basename "$0"): $decisions holds a change that was never confirmed: left as it is" >&2
elif ! git -C "$decisions" merge --quiet --no-edit "$base" 2> /dev/null; then
  git -C "$decisions" merge --abort 2> /dev/null || true
  echo "$(basename "$0"): $decisions cannot take $base in (conflict): its docs/decisions.md is behind, look at it before a lasting rule is written" >&2
fi

run_base="talk-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$ORCH_STATE_DIR/runs/$run_base"
mkdir -p "$run_dir"
cp "$work/prompt.md" "$run_dir/prompt.md"
printf '%s\n' "$chain" > "$run_dir/chain.json"
{
  printf 'ORCH_LANE=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_DECISIONS_WORKTREE=%q\nORCH_REPORT_ON=%q\n' "$(jq -r '.chain[0].alias' <<<"$routed")" "$decisions" "$report_on"
} > "$run_dir/talk.env"

echo "opening $(date +%s)" > "$ORCH_STATE_DIR/wake/talk"
# The mark holds the wakes from here on; their lock is not kept while the terminal opens.
exec 8>&-
# A terminal adapter that shows no terminal ([terminal] adapter = none) has
# nowhere to hold a conversation: it is held here, in the terminal talk.sh
# was started from. Started from none, it is not started at all.
if ! terminal has-screen; then
  if [ -z "${ORCH_TTY:-}" ] && ! [ -t 0 ]; then
    rm -f "$ORCH_STATE_DIR/wake/talk"
    die "[terminal] adapter = none opens no terminal for the discussion, and talk.sh was not started from one: run it by hand in a terminal: cd $worktree && $ORCH_HOME/talk-run.sh $run_dir"
  fi
  code=0
  (cd "$worktree" && exec "$ORCH_HOME/talk-run.sh" "$run_dir") || code=$?
  echo "$run_dir"
  exit "$code"
fi
terminal open "$worktree" "$lane · discussion · $(jq -r '.[0].alias' <<<"$chain")" "$ORCH_HOME/talk-run.sh $run_dir" "$run_dir" > "$run_dir/terminal.handle" \
  || { rm -f "$ORCH_STATE_DIR/wake/talk"; die "the terminal adapter ($terminal_loaded) did not open the terminal of the discussion; run it by hand: cd $worktree && $ORCH_HOME/talk-run.sh $run_dir"; }
user_message talk_opened "lane=$lane" "model=$(jq -r '.[0].alias' <<<"$chain")"
echo "$run_dir"
