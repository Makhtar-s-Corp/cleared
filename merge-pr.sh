#!/usr/bin/env bash
# Puts a pull request live: the one way a merge is done without a person at
# the keyboard. It checks, and judges nothing. Every condition is read from
# GitHub, git, the ledger, tracker and the host, and all of them must hold:
#   1. the pull request is open, not a draft, and its checks are all green;
#   2. its branch holds the base, or lacks only what is not code;
#   3. the version that goes live was reviewed by a model other than its
#      author, for this ticket, and the reviewer concluded what [merge]
#      verdict says: the reviewed commit is the head, or the head only adds
#      merges of the base that changed nothing by themselves;
#   4. the user agreed: he put the ticket in his status of agreement himself
#      (tracker.sh moved-by-owner), for the version he was shown
#      (ask-validation.sh keeps which), or wrote « Fusion : <ticket> » before
#      the statuses existed. Invisible tooling ([merge] tooling_paths) needs
#      neither; what touches the checks of the CI, the deployment, his
#      written rules or this lock itself, with all it runs or reads
#      ([merge] guarded_paths), always needs his own agreement. What the pull
#      request changes is read from git, renames undone: GitHub cuts a long
#      list of files short;
#   5. the host is free for a merge: no CI, no deployment settling, no screen
#      test, GitHub up. One go-live at a time, under one lock from the first
#      read to the merge.
# Then it merges the very commit it checked, and, when the ticket was in the
# status of agreement, says where to see the result and puts it in Done.
#
#   merge-pr.sh <pull request> <ticket> [<announcement file|->] [--dry-run]
#
# The announcement (product language: what changes, where to see it, how to
# check in a minute) is asked for whenever the user's agreement was needed.
# Exit: 0 merged (or, with --dry-run, would be); 3 not merged, kept in the
# queue: it only waits (the host is busy, a check still runs) and the wake
# does it later with these same checks (with --dry-run: would be kept);
# 5 the same, said to the wake that tries the queue; 6 no: something must
# change first, and the script says what.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

# Only the service account's broker may enter the merge implementation.
# The secret lives in service-owned state; a harness cannot read it.
[ -n "${ORCH_BROKER_SECRET:-}" ] && [ -r "$ORCH_STATE_DIR/release-broker.secret" ] \
  && [ "$ORCH_BROKER_SECRET" = "$(cat "$ORCH_STATE_DIR/release-broker.secret")" ] \
  || { echo "merge-pr.sh: only the release broker can execute a merge" >&2; exit 6; }

usage="usage: merge-pr.sh <pull request> <ticket> [<announcement file|->] [--dry-run]"
[ $# -ge 2 ] && [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[A-Z]+-[0-9]+$ ]] || die "$usage"
pr=$1 ticket=$2 announcement= dry_run=
shift 2
for arg in "$@"; do
  case "$arg" in --dry-run) dry_run=1 ;; *) [ -z "$announcement" ] || die "$usage"; announcement=$arg ;; esac
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ "$announcement" = - ]; then cat > "$work/announcement.md"; announcement="$work/announcement.md"; fi
[ -z "$announcement" ] || [ -f "$announcement" ] || die "no such file: $announcement"
ledger init > /dev/null
no() { echo "$(basename "$0"): #$pr is not put live: $1" >&2; exit 6; }
# "Not now" is not "no": a go-live that only waits for the host, for a check
# still running or for tracker's history is kept in a queue the wake tries
# again by itself, with no model, with these same checks each time.
later() {
  if [ -n "$dry_run" ]; then user_message merge_dry_queue "reason=$1"; exit 3; fi
  if [ -n "${ORCH_FROM_QUEUE:-}" ]; then echo "$(basename "$0"): #$pr is not put live now: $1" >&2; exit 5; fi
  mkdir -p "$ORCH_STATE_DIR/merge-queue"
  [ -z "$announcement" ] || cp "$announcement" "$ORCH_STATE_DIR/merge-queue/$pr.announcement.md"
  jq -n --arg pr "$pr" --arg ticket "$ticket" --arg at "$(now_utc)" --arg why "$1" --arg said "$([ -z "$announcement" ] || echo "$ORCH_STATE_DIR/merge-queue/$pr.announcement.md")" \
    '{pr: ($pr | tonumber), ticket: $ticket, at: $at, why: $why, announcement: $said}' > "$ORCH_STATE_DIR/merge-queue/.$pr.part"
  mv "$ORCH_STATE_DIR/merge-queue/.$pr.part" "$ORCH_STATE_DIR/merge-queue/$pr.json"
  user_message merge_queue "pr=$pr" "reason=$1"
  exit 3
}
node_lib() { node --no-warnings "$ORCH_HOME/lib/$1" "${@:2}"; }
# One go-live at a time, from the first read to the merge: the wake that
# tries the queue and a call of the lead would both read a free host, and a
# branch that holds the base, before either had merged.
# A dry run merges nothing: it neither waits for the lock nor holds it.
if [ -z "$dry_run" ]; then
  mkdir -p "$ORCH_STATE_DIR"
  exec 9> "$ORCH_STATE_DIR/merge.lock"
  flock -n 9 || later "another go-live is being done"
fi
# A watched release must finish before another merge can make the cause of a
# health failure ambiguous. The queue is retried by the normal wake.
release_active=0
node --no-warnings "$ORCH_HOME/lib/release.mjs" active || release_active=$?
[ "$release_active" = 0 ] || { [ "$release_active" = 3 ] && later "the previous release is still being monitored"; die "release watch state could not be read"; }
node --no-warnings "$ORCH_HOME/lib/release.mjs" check || no "[release] settings are invalid; fix them before shipping"

down=$(github_down) || down=
[ -z "$down" ] || later "GitHub is down ($down)"

# 1. Open, not a draft, green.
pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json number,state,isDraft,headRefName,headRefOid,baseRefName,createdAt,statusCheckRollup) || die "pull request #$pr could not be read"
[ "$(jq -r '.state' <<<"$pull")" = OPEN ] || no "it is not open"
[ "$(jq -r '.isDraft' <<<"$pull")" = false ] || no "it is a draft"
head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")
base=$(conf_get lanes base)
[ "$(jq -r '.baseRefName' <<<"$pull")" = "${base#origin/}" ] || no "it does not go to ${base#origin/}"
checks=$(jq -c '[.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase]' <<<"$pull")
[ "$(jq 'map(select(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING" or . == "WAITING" or . == "")) | length' <<<"$checks")" = 0 ] || later "its checks still run"
[ "$(jq 'map(select(. != "SUCCESS" and . != "SKIPPED" and . != "NEUTRAL")) | length' <<<"$checks")" = 0 ] || no "a check is not green"
[ "$(jq 'map(select(. == "SUCCESS")) | length' <<<"$checks")" != 0 ] || no "no check ran on it"

# 2. The base is in it, or what it lacks is not code.
git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" "$branch" || die "the branches could not be fetched"
[ "$(git -C "$ORCH_REPO" rev-parse "origin/$branch")" = "$head" ] || later "its branch moved while it was read"
# What it changes, from git: every path, and for a file that moved, where it
# came from as well as where it went.
git -C "$ORCH_REPO" diff --name-only --no-renames "$base...$head" | jq -R . | jq -sc . > "$work/files.json"
if ! git -C "$ORCH_REPO" merge-base --is-ancestor "$base" "$head"; then
  git -C "$ORCH_REPO" diff --name-only --no-renames "$head...$base" | jq -R . | jq -sc . > "$work/lag.json"
  node_lib merge.mjs lag "$work/lag.json" || no "its branch lacks code that is on ${base#origin/}: the lane brings ${base#origin/} in first"
fi

# 3. Reviewed, for this ticket, with the verdict asked for, at this version.
reviewed=
while IFS=$'\t' read -r run_id commit; do
  [ -n "$commit" ] || continue
  node_lib merge.mjs verdict "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null || continue
  if only_base_merges "$commit" "$head"; then reviewed=$commit; break; fi
done < <(ledger sql "select run_id from runs where role = 'review' and source = 'dispatcher' and outcome = 'done' and pr_number = $pr and ticket = '$ticket' order by started_at desc" \
  | jq -r '.[].run_id' | while IFS= read -r run_id; do printf '%s\t%s\n' "$run_id" "$(sed -n 's/^commit: //p' "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null | sed -n '1p')"; done)
[ -n "$reviewed" ] || no "this version (${head:0:8}) has no review for $ticket that concludes « $(conf_get merge verdict) »: have it reviewed (review-pr.sh $pr $ticket)"

# 4. The agreement of the user.
needs=$(node_lib merge.mjs needs "$work/files.json")
go=$(conf_get tracker go_state) validate=$(conf_get tracker validate_state) agreed=
asked="$ORCH_STATE_DIR/validations/$ticket.json"
if [ "$needs" != tooling ]; then
  # His move is read from the tracker, and not from one that cannot tell him
  # from an agent, unless the project says it accepts that ([merge]
  # separate_identity = no).
  if [ "$(conf_get merge separate_identity)" != no ] && [ "$("$ORCH_HOME/tracker.sh" identity)" != app ]; then
    no "the tracker cannot tell the user from an agent (the scripts act under the key of a person): no agreement is read from it ([merge] separate_identity). Give the agents their own application"
  fi
  # His move answers a request: the time of the last one made on this ticket.
  requested=$(jq -r '.at // empty' "$asked" 2> /dev/null) || requested=
  code=0
  "$ORCH_HOME/tracker.sh" moved-by-owner "$ticket" "$go" ${requested:+"$requested"} || code=$?
  case "$code" in
    0)
      # His move is his agreement to what he was shown, and to nothing else:
      # another pull request of the ticket, a commit of the lane, or the
      # base brought in with a conflict the lane resolved, was seen by
      # nobody but a reviewer. The base brought in as it is changes nothing
      # of what the pull request does, and the checks ran again on it: his
      # agreement stands (his rule of 2026-10-08).
      shown=$(jq -r --argjson pr "$pr" '.pulls[]? | select(.pr == $pr) | .head' "$asked" 2> /dev/null | sed -n '1p') || shown=
      [ -n "$shown" ] || no "$ticket is in « $go », but the user was never shown #$pr: ask him for it (ask-validation.sh $ticket - --pr $pr)"
      if ! only_base_merges "$shown" "$head"; then
        [ -n "$dry_run" ] || "$ORCH_HOME/tracker.sh" move "$ticket" "$validate" > /dev/null || true
        [ -n "$dry_run" ] || ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "#$pr: the user agreed to ${shown:0:8} and the branch is now at ${head:0:8}: $ticket is back in « $validate », to be asked again with this version"
        no "this version (${head:0:8}) is not the version he was shown (${shown:0:8}): $ticket is back in « $validate ». Ask him again with this version (ask-validation.sh $ticket - --pr $pr)"
      fi
      agreed=status
      ;;
    7) later "tracker has not written yet who put $ticket in « $go »" ;;
    8)
      # By him, but before the request: an agreement to something else, and
      # a card that somebody else put back where he had left it.
      [ -n "$dry_run" ] || "$ORCH_HOME/tracker.sh" move "$ticket" "$validate" > /dev/null || true
      [ -n "$dry_run" ] || ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "#$pr: the move of the user to « $go » is older than the request made at $requested: it answers another request. $ticket is back in « $validate »"
      no "the move of the user to « $go » is older than the request made at $requested: $ticket is back in « $validate », where the request waits for him"
      ;;
    6)
      # In his status, but not put there by him: never live, and back to the status that asks him.
      [ -n "$dry_run" ] || "$ORCH_HOME/tracker.sh" move "$ticket" "$validate" > /dev/null || true
      [ -n "$dry_run" ] || ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "#$pr: $ticket was put in « $go » by an integration or another account, not by the user: back to « $validate »"
      no "$ticket is in « $go » but the user did not put it there himself: put back in « $validate »"
      ;;
    5)
      # Not in his status: a line he wrote before the statuses existed still counts.
      if "$ORCH_HOME/tracker.sh" legacy-line-allowed; then
        { "$ORCH_HOME/tracker.sh" comments "$ticket"; "$ORCH_HOME/tracker.sh" comments "$(conf_get lead report_on)"; } | jq -sc 'add' > "$work/comments.json"
        cat "$ORCH_STATE_DIR/tracker-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
        opened=$(jq -r '.createdAt // ""' <<<"$pull")
        if [ "$needs" = guarded ]; then node_lib merge.mjs line "$work/comments.json" "$work/agent-ids.txt" "$ticket" "$opened" "$pr" && agreed=line
        else node_lib merge.mjs line "$work/comments.json" "$work/agent-ids.txt" "$ticket" "$opened" && agreed=line; fi
      fi
      ;;
    *) die "tracker could not say who moved $ticket" ;;
  esac
  [ -n "$agreed" ] || no "the user has not agreed: $ticket is not in « $go »$([ "$needs" != guarded ] || echo ' (it touches the checks of the CI, the deployment, his written rules or the tooling of the go-lives: his own agreement is needed, tooling or not)'). Ask him (ask-validation.sh $ticket - --pr $pr)"
  [ -n "$announcement" ] || no "an announcement is needed for what the user agreed to: what changes, where to see it, how to check"
fi

# 4b. A ticket he gave to two teams: one result goes live, the one he named.
# Whatever the kind of change (one that needs no agreement is still one of
# two), the user's line “Team 1” or “Team 2” (or its French equivalent), written after the request
# when there was one, says which: no line, the line of the other team, or
# lines that name both, and this pull request is not put live.
loser=
for one in "$ticket" "$ticket.2"; do
  [ "$(jq -r --argjson pr "$pr" 'select(.pr == $pr) | .not_chosen // false' "$(lane_record "$one")" 2> /dev/null)" != true ] \
    || no "#$pr is the result of the team the user did not choose for $ticket: the other one went live"
done
teams=$(jq -c '.teams // {}' "$asked" 2> /dev/null) || teams='{}'
if [ "$(jq 'length' <<<"$teams")" != 2 ]; then
  teams='{}'
  while read -r team theirs; do
    [ -n "$team" ] || continue
    teams=$(jq -c --arg team "$team" --argjson pr "$theirs" '. + {($team): $pr}' <<<"$teams")
  done < <(teams_of "$ticket")
fi
if [ "$(jq 'length' <<<"$teams")" = 2 ]; then
  mine=$(jq -r --argjson pr "$pr" 'to_entries[] | select(.value == $pr) | .key' <<<"$teams" | sed -n '1p')
  [ -n "$mine" ] || no "$ticket was given to two teams, and #$pr is the pull request of neither"
  "$ORCH_HOME/tracker.sh" comments "$ticket" > "$work/choice.json" || die "the comments of $ticket could not be read: which team he chose is not known"
  cat "$ORCH_STATE_DIR/tracker-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/choice-agents.txt" || true
  # Written after the request; with no request (a change that needs no
  # agreement), after the second team was opened: never a line from before
  # there were two results to choose from.
  since=$(jq -r '.at // ""' "$asked" 2> /dev/null) || since=
  [ -n "$since" ] || since=$(jq -r '.opened_at // ""' "$(lane_record "$ticket.2")" 2> /dev/null) || since=
  chosen=$(jq -r --arg team "$team_line" --arg since "$since" --rawfile ids "$work/choice-agents.txt" '($ids | split("\n")) as $agents | [.[] | select(.byOwner == true and (.id as $id | $agents | index($id) | not) and (.body | test("^\\s*(> *(Écrit|Ticket ouvert) par un agent|> *(Written by an agent|Ticket opened by an agent)|Chef de projet *:|Project lead *:)") | not) and .createdAt > $since)] | map(.body | [scan("(?im)" + $team)] | map(.[0])) | add // [] | unique | join(" ")' "$work/choice.json")
  [ -n "$chosen" ] || no "$ticket was given to two teams and the user has not said which one goes live: a Team 1 or Team 2 line on the ticket, written after the request"
  [[ "$chosen" =~ ^[12]$ ]] || no "$ticket was given to two teams and the user named both since the request (Team 1 and Team 2): which one goes live is not known. Ask them"
  [ "$chosen" = "$mine" ] || no "the user chose the team $chosen (#$(jq -r --arg team "$chosen" '.[$team]' <<<"$teams")): #$pr, of the team $mine, is not put live"
  loser=$(jq -r --arg team "$mine" 'to_entries[] | select(.key != $team) | .value' <<<"$teams" | sed -n '1p')
  other_lane=$ticket
  [ "$mine" != 1 ] || other_lane=$ticket.2
  # Never the second of the two: the other one is not live already.
  [ "$(cd "$ORCH_REPO" && gh pr view "$loser" --json state 2> /dev/null | jq -r '.state // empty' 2> /dev/null)" != MERGED ] || no "#$loser, of the other team of $ticket, is already live: #$pr is not put live on top of it"
fi

# 5. The host.
host=$("$ORCH_HOME/host-state.sh")
[ "$(jq -r '.free_for_a_merge' <<<"$host")" = true ] || later "the host is not free for a merge (a CI, a deployment settling or a screen test)"

if [ -n "$dry_run" ]; then
  jq -n --arg pr "$pr" --arg ticket "$ticket" --arg head "$head" --arg reviewed "$reviewed" --arg needs "$needs" --arg agreed "${agreed:-none needed}" \
    '{would_merge: ($pr | tonumber), ticket: $ticket, head: $head, reviewed_commit: $reviewed, kind: $needs, agreement: $agreed}'
  exit 0
fi

# The very commit that was checked, and nothing that arrived since.
(cd "$ORCH_REPO" && gh pr merge "$pr" --merge --match-head-commit "$head") > /dev/null || die "GitHub did not merge #$pr"
ledger event --kind merged_by_script --ticket "$ticket" --value "$pr" --detail "#$pr at ${head:0:8}, reviewed at ${reviewed:0:8}, $needs, agreement: ${agreed:-none needed}"
if ! node --no-warnings "$ORCH_HOME/lib/release.mjs" start "$ticket" "$pr" 9>&- 2> "$work/release-error"; then
  watch_reason=$(tail -n 1 "$work/release-error")
  ledger event --kind release_watch_failed --ticket "$ticket" --value "$pr" --detail "the merge succeeded but its release watch could not start: $watch_reason"
  user_message release_watch_failed "title=#$pr ($ticket)" "reason=$watch_reason" > "$work/release-watch-failed.md"
  if ! "$ORCH_HOME/tracker.sh" comment "$ticket" "$work/release-watch-failed.md" Cleared > /dev/null 2>&1; then
    mkdir -p "$ORCH_STATE_DIR/tracker-outbox"
    cp "$work/release-watch-failed.md" "$ORCH_STATE_DIR/tracker-outbox/$ticket--release-watch-$pr.md"
  fi
  echo "merge-pr.sh: #$pr merged, but release monitoring failed: $watch_reason. Retry with node $ORCH_HOME/lib/release.mjs start $ticket $pr" >&2
fi
echo "merged: #$pr ($ticket) at ${head:0:8}"

# The result of the other team, which he did not choose: its lane is over,
# and its pull request is closed, so that the ticket closes on what is
# live. A pull request GitHub does not close now is kept with what he was
# shown, and closed by the wake (close_tickets_left_open), told once.
if [ -n "${other_lane:-}" ]; then
  # (With or without a pull request yet: a lane that is over opens none.)
  kept=$(lane_record "$other_lane")
  [ ! -f "$kept" ] || { jq --arg at "$(now_utc)" '. + {closed: (.closed // $at), not_chosen: true}' "$kept" > "$kept.part" && mv "$kept.part" "$kept"; }
fi
if [ -n "$loser" ] && [ "$loser" != 0 ]; then
  if (cd "$ORCH_REPO" && gh pr close "$loser") > /dev/null 2>&1; then
    echo "closed: #$loser, the result of the team he did not choose"
  else
    [ ! -f "$asked" ] || { jq --argjson loser "$loser" '. + {closing: true, close: $loser}' "$asked" > "$asked.next" && mv "$asked.next" "$asked"; }
    ledger event --kind ticket_left_open --ticket "$ticket" --value "$pr" --detail "#$pr is live, and #$loser, the result of the team the user did not choose, could not be closed now: the wake tries again, and $ticket is closed once it is"
    echo "$(basename "$0"): #$pr is live, but #$loser, of the team he did not choose, could not be closed: the wake tries again" >&2
  fi
fi
# What the user agreed to is told to him where he agreed, and closed. A
# comment the hourly limit holds back leaves with the grouped ones.
if [ -n "$announcement" ]; then
  code=0
  "$ORCH_HOME/tracker.sh" comment "$ticket" "$announcement" "${ORCH_SIGNED:-$(conf_get lead name)}" > /dev/null || code=$?
  if [ "$code" != 0 ]; then
    mkdir -p "$ORCH_STATE_DIR/tracker-outbox"
    cp "$announcement" "$ORCH_STATE_DIR/tracker-outbox/.$pr.part" && mv "$ORCH_STATE_DIR/tracker-outbox/.$pr.part" "$ORCH_STATE_DIR/tracker-outbox/$ticket--mise-en-ligne-$pr.md"
  fi
fi
# The ticket is closed once everything he was shown on it is live. A pull
# request he was shown and that GitHub says closed or merged since no longer
# counts; one GitHub cannot be asked about still does: the ticket is not
# closed on a guess, the ledger keeps it, and the wake asks again.
if [ "$agreed" = status ]; then
  jq --argjson pr "$pr" --arg at "$(now_utc)" '(.pulls[] | select(.pr == $pr)) |= . + {merged_at: $at}' "$asked" > "$asked.next" && mv "$asked.next" "$asked"
  read -r still_open unknown <<<"$(shown_left "$asked")"
  if [ "$unknown" != 0 ]; then
    jq '. + {closing: true}' "$asked" > "$asked.next" && mv "$asked.next" "$asked"
    ledger event --kind ticket_left_open --ticket "$ticket" --value "$pr" --detail "#$pr is live, and $ticket stays in « $go »: GitHub did not say what became of $(jq -r '[.pulls[] | select(.merged_at == null) | "#\(.pr)"] | join(", ")' "$asked"), shown on the same ticket. Nothing to do: the wake asks GitHub again by itself, and closes the ticket once every other pull request shown is live or closed, if the ticket still is where the user put it"
  elif [ "$still_open" = 0 ]; then
    if "$ORCH_HOME/tracker.sh" move "$ticket" "$(conf_get tracker done_state)" > /dev/null; then
      jq 'del(.closing)' "$asked" > "$asked.next" && mv "$asked.next" "$asked"
    else
      echo "$(basename "$0"): #$pr is live, but $ticket could not be put in « $(conf_get tracker done_state) »" >&2
    fi
  fi
fi
