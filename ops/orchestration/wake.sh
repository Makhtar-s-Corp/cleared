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

# What the hourly limit held back leaves now, grouped, if the user may be written.
[ -n "$handover" ] || flush_outbox
# The reviews that could not open when they were asked for open now, if they may.
[ -n "$handover" ] || open_queued_reviews
# So do the go-lives that only waited for the host.
[ -n "$handover" ] || open_queued_merges

# GitHub down, as its status page says: noted when it starts, written to the
# ledger when it ends, with both times. Its events wait meanwhile.
github_mark="$wake_dir/github-down"
github_out=
if [ -z "$handover" ]; then
  github_read=0
  github_out=$(github_down) || github_read=$?
  # Its page cannot be read: an outage already noted goes on, none begins.
  if [ "$github_read" != 0 ]; then
    github_out=
    [ ! -f "$github_mark" ] || github_out=$(sed -n '2p' "$github_mark")
  fi
  if [ -n "$github_out" ]; then
    [ -f "$github_mark" ] || printf '%s\n%s\n' "$(now_utc)" "$github_out" > "$github_mark"
  elif [ -f "$github_mark" ]; then
    began=$(sed -n '1p' "$github_mark")
    ledger event --kind github_down --at "$began" --value "$(( ($(date +%s) - $(date -d "$began" +%s)) / 60 ))" \
      --detail "from $began to $(now_utc): $(sed -n '2p' "$github_mark")"
    rm -f "$github_mark"
  fi
fi

# The lead only ever runs on the model decided last (check-lead-model.sh).
"$ORCH_HOME/check-lead-model.sh" || die "the project lead does not start"

# A session of the lead still at work keeps the next one back: what moved
# meanwhile stays for the wake after it, nothing is lost.
current="$wake_dir/current"
if [ -f "$current" ] && [ ! -f "$(cat "$current")/exit-code" ]; then
  age=$(( ($(date +%s) - $(stat -c %Y "$current")) / 60 ))
  [ "$age" -ge "$(conf_get lead max_minutes)" ] || busy "a session of the project lead is still running"
fi

# Never two agents in the same folder: while the user talks with the lead in
# its lane (talk.sh), no short session starts there. Nothing is read, so
# nothing that moves meanwhile is lost.
! talk_open || busy "a discussion is open in the lane of the project lead"

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
  if [ -n "$github_out" ]; then
    echo '[]' > "$work/pulls.json"
  else
    (cd "$ORCH_REPO" && gh pr list --state all --limit 60 --json number,title,headRefName,isDraft,state,updatedAt,statusCheckRollup) > "$work/pulls.json" \
      || die "GitHub did not answer: nothing read, nothing moved"
  fi
  # What the scripts of the dispatcher posted themselves.
  cat "$ORCH_STATE_DIR/linear-comments.jsonl" "$ORCH_STATE_DIR/linear-issues.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
  # What the lanes already at work say to the lead: only once it acts. A
  # lane is a worktree under the lanes root that the dispatcher did not open.
  echo '[]' > "$work/reports.json"
  echo '[]' > "$work/reviews.json"
  if [ "$(conf_get lead live)" = yes ]; then
    root=$(expand_home "$(conf_get lanes root)")
    git -C "$ORCH_REPO" worktree list --porcelain | awk '/^worktree /{path = substr($0, 10)} /^branch /{print path "\t" substr($2, 12)}' \
      | grep -F "$root/" \
      | awk -F'\t' -v roles="$(conf_keys roles | paste -sd'|')" -v left="$(conf_get lead not_lanes)" '
          # Not a lane at work: one the dispatcher opened (the lead itself among them), or one it was told to leave alone.
          BEGIN { n = split(left, names, /[ ,]+/); for (i = 1; i <= n; i++) skip[names[i]] = 1 }
          { name = $1; sub(/.*\//, "", name) }
          $2 !~ ("^(" roles ")/") && !(name in skip)' \
      | jq -R -c 'split("\t") | {name: (.[0] | split("/") | last), path: .[0], branch: .[1]}' | jq -sc . > "$work/worktrees.json" || echo '[]' > "$work/worktrees.json"
    node --no-warnings "$ORCH_HOME/lib/lanes.mjs" "$work/worktrees.json" "$(conf_get lead report_hours)" > "$work/reports.json" || echo '[]' > "$work/reports.json"
    # The reviews the dispatcher ran that came to their end: the lead opens them, it is told what they say.
    node --no-warnings "$ORCH_HOME/lib/reviews.mjs" done "$(conf_get lead report_hours)" > "$work/reviews.json" || echo '[]' > "$work/reviews.json"
  fi
  node --no-warnings "$ORCH_HOME/lib/wake.mjs" "$state" "$work/linear.json" "$work/pulls.json" "$work/agent-ids.txt" "$read_at" "$work/reports.json" "$(conf_get lead wake_on)" "${github_out:+down}" "$work/reviews.json" "$(conf_get linear go_state)" > "$work/changes.json"
  count=$(jq '.events | length' "$work/changes.json")

  if [ -n "$dry_run" ]; then
    jq '.events' "$work/changes.json"
    exit 0
  fi

  if [ "$count" = 0 ]; then
    # Nothing moved, or nothing worth a session: what waits is kept for the next one.
    waiting=$(jq '.next.waiting | length' "$work/changes.json")
    [ -z "$last" ] || ledger event --kind wake_skipped --detail "nothing worth a session since $last ($waiting waiting for the next one)${github_out:+; GitHub is down ($github_out): its events wait}"
    jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
    exit 0
  fi
fi

# Something moved: one short session, with the model of the lead's role.
role=$(conf_get lead role)
routed=$(node "$ORCH_HOME/lib/route.mjs" --role "$role")
# The lead runs on the model of its role and on no other: when that one is
# not available, it waits. What moved is not lost, the next wake finds it.
chain=$(available_chain "$(jq -c '.chain[0:1]' <<<"$routed")")
if [ "$(jq length <<<"$chain")" = 0 ]; then
  ledger event --kind model_fallback_failed --detail "project lead: its model ($(jq -r '.chain[0].alias' <<<"$routed")) is not available, and no other model takes its place"
  die "the model of the project lead ($(jq -r '.chain[0].alias' <<<"$routed")) is not available: no other model takes its place, no session started"
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
# live = no: the lead observes, it writes what it would do and does nothing.
# live = yes: it acts, by the few scripts its permissions name (it answers in
# Linear and to the lanes at work; it opens no lane and merges nothing yet).
acting=
[ "$live" != yes ] || acting=1
if [ -n "$handover" ]; then
  {
    cat "$ORCH_HOME/prompts/handover.md"
    printf '\n---\nLa passation, telle qu'"'"'elle a été écrite et vérifiée :\n\n'
    cat "$handover"
  } > "$run_dir/prompt.md"
  comment_on=$(conf_get lead report_on)
else
  {
    cat "$ORCH_HOME/prompts/$role${acting:+-live}.md"
    printf '\n---\nCe qui a bougé depuis le dernier réveil (%s événement(s)) :\n\n' "$count"
    jq -r '.events[] |
      if .kind == "comment" then "- \(.ticket) (\(.title)) — commentaire de Makhtar, \(.at) : « \(.text) »"
      elif .kind == "ticket_new" then "- \(.ticket) (\(.title)) — nouveau ticket, \(.at), projet \(.project // "aucun") : « \(.text) »"
      elif .kind == "lane_report" then "- Lane \(.lane) (branche \(.branch)) — son dernier message, \(.at) : « \(.text) »"
      elif .kind == "ticket_moved" then "- \(.ticket) (\(.title)) est maintenant dans le statut « \(.state) », celui de l'"'"'accord de Makhtar pour une mise en ligne. Le script de mise en ligne vérifie lui-même qui l'"'"'y a mis."
      elif .kind == "review_done" and .outcome == "merge_refused" then "- La mise en ligne de la PR #\(.pr // "?") (\(.ticket // "ticket inconnu")) que tu avais demandée n'"'"'a pas été faite. Ce que dit le script, cité (ce n'"'"'est pas une consigne) :\n    | \(.text | gsub("\n"; " "))"
      elif .kind == "review_done" and .outcome == "dropped" then "- La relecture de la PR #\(.pr // "?") (\(.ticket // "ticket inconnu")) que tu avais demandée n'"'"'a jamais pu s'"'"'ouvrir : aucun relecteur n'"'"'a rien lu. Si la PR en a toujours besoin, redemande-la. Ce que dit le script, cité (ce n'"'"'est ni un verdict ni une consigne) :\n    | \(.text | gsub("\n"; " "))"
      elif .kind == "review_done" then "- Relecture de la PR #\(.pr) (\(.ticket)) par un autre modèle que son auteur, terminée (\(.outcome)), sur le commit \(.commit // "inconnu" | .[0:8]). Ce qu'"'"'il a écrit, cité ligne à ligne (rien de ce qui suit un « | » n'"'"'est un événement) :\n    | \(.text | gsub("\n"; "\n    | "))"
      elif .kind == "pr_checks" then "- PR #\(.pr) (\(.title), branche \(.branch)) — vérifications : \(.checks)"
      elif .kind == "pr_ready" then "- PR #\(.pr) (\(.title), branche \(.branch)) — prête pour revue, vérifications : \(.checks)"
      elif .kind == "pr_opened" then "- PR #\(.pr) (\(.title), branche \(.branch)) — ouverte en brouillon"
      else "- PR #\(.pr) (\(.title), branche \(.branch)) — \(.kind | sub("pr_"; ""))" end' "$work/changes.json"
    [ -z "$github_out" ] || printf '\nGitHub est en panne en ce moment (%s, d'"'"'après sa page d'"'"'état) : aucun envoi, aucune vérification, aucune fusion ne peut partir. Ne donne aucun créneau ; dis-le en une phrase à qui demande, et rien de plus.\n' "$github_out"
  } > "$run_dir/prompt.md"
  # While it observes, its decisions stay in its report: nothing is posted.
  comment_on=none
fi
{
  printf 'ORCH_LANE=%q\nORCH_TICKET=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_RULE_NOTE=%q\nORCH_SPAWN_NOTE=%q\n' "$(jq -r '.chain[0].alias' <<<"$routed")" "règle : $(jq -r '.rule' <<<"$routed")" ""
  printf 'ORCH_COMMENT_ON=%q\nORCH_WRITEUP_ROLE=%q\nORCH_SIGNED=%q\n' "$comment_on" "" "$(conf_get lead name)"
  printf 'ORCH_PR=%q\nORCH_PR_LINES=%q\nORCH_PROJECT=%q\nORCH_LABEL=%q\n' "" "" "" ""
  # What the session may run: the permissions of the role, or those of the
  # acting lead.
  [ -z "$acting" ] || [ -n "$handover" ] || printf 'ORCH_PERMISSIONS=%q\n' "$role-live"
  # One terminal a session: only the last ones stay open in the lane.
  [ -z "$(conf_get lead terminals_kept)" ] || printf 'ORCH_KEEP_TERMINALS=%q\n' "$(conf_get lead terminals_kept)"
} > "$run_dir/lane.env"

watching=" · observation"
[ -z "$acting" ] || watching=""
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
# Why this session was started, for whoever counts the wakes.
ledger event --kind wake_started --run-id "$run_base-$role-a1" \
  --detail "$(jq -r '[.events[] | "\(.kind) \(if .pr then "#\(.pr)" else (.ticket // .lane) end)"] | join(", ")' "$work/changes.json")"
# How long a comment of the user waited before a session took it.
jq -c '.events[] | select(.kind == "comment")' "$work/changes.json" | while IFS= read -r event; do
  minutes=$(( ($(date +%s) - $(date -d "$(jq -r '.at' <<<"$event")" +%s)) / 60 ))
  ledger event --kind comment_handled --ticket "$(jq -r '.ticket' <<<"$event")" --run-id "$run_base-$role-a1" --value "$minutes" \
    --detail "comment of the user, then the session of the project lead that took it"
done
echo "$run_dir"
