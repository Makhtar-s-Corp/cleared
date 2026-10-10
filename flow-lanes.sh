#!/usr/bin/env bash
# Moves the lanes forward by rule, with no model: from the wake, each minute.
# A ticket the user said « go » on is worked to the point where his
# agreement is asked, without anybody having to remember a step:
#
#   - a ticket he put himself in [linear] todo_state (moved there, or created
#     there, by him, since [lanes] todo_since) gets a lane, oldest first,
#     within the limit of lanes; the others wait where they are;
#   - a lane whose session is over, its work sent, is closed (its branch and
#     what is known of it stay: it is opened again from them); work a
#     session left unsent is sent here, as the session would have;
#   - its pull request is taken out of draft when the host is free for a run
#     of the checks, one at a time;
#   - red checks, a branch that lacks code of the base, a reviewer that asks
#     for corrections, a session that stopped short, a word of the user on
#     the ticket: the lane is opened again, with what was said, quoted;
#   - green checks on a version no reviewer read: the review is asked for.
#
# The status of the ticket says where it is, and is put again at each round
# when something else moved it (a tracker has automations of its own on pull
# requests). The status the user agrees with is never touched: the base
# brought in as it is leaves his card where he put it.
#
# What a lane says at the end of a session stays with the state (its report):
# the user is not written at every session. He is written by the lead, when
# there is something for him: a question of the lane, the request for his
# agreement, a lane the rules cannot move.
#
# What it never does: judge. A review that finds nothing blocking on green
# checks is where it stops; asking the user for his agreement, in product
# language, is the lead's. Each step is done once for a given version
# (kept in the record of the lane), and a lane is not opened again more than
# [lanes] runs_per_day times a day: beyond, it is said (lane_stuck) and left.
#
#   flow-lanes.sh [--dry-run]     prints what it did, one line each
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

dry=
[ "${1:-}" != --dry-run ] || dry=1
ledger init > /dev/null
mkdir -p "$ORCH_STATE_DIR/lanes"
# One at a time: two rounds at once would both open the same lane again.
exec 7> "$ORCH_STATE_DIR/flow.lock"
flock -n 7 || exit 0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base=$(conf_get lanes base)
cap=$(conf_get lanes runs_per_day)
[[ "$cap" =~ ^[0-9]+$ ]] || cap=6
say() { echo "$*"; }
did() { [ "$(jq -r --arg key "$2" '.done[$key] // empty' "$1")" != "" ]; }
mark() { [ -n "$dry" ] || { jq --arg key "$2" --arg at "$(now_utc)" '.done = ((.done // {}) + {($key): $at})' "$1" > "$1.part" && mv "$1.part" "$1"; }; }
# The host is asked once a round, and one pull request a round is taken out
# of draft: the next one waits for the checks of this one.
# Free: no checks running, no deployment settling, no screen test or capture
# at work, and nobody holding the door of the heavy commands (when-free.sh):
# checks that start under a screen test break both.
free_for_a_run() {
  [ ! -f "$work/readied" ] || return 1
  [ -f "$work/host" ] || { "$ORCH_HOME/host-state.sh" 2> /dev/null | jq -r '(.free_for_a_ci_run // false) and ((.screen_tests_or_captures_running // 0) == 0)' > "$work/host" || echo false > "$work/host"; }
  [ "$(cat "$work/host")" = true ] || return 1
  # Checks started in the last two minutes (by a round before this one) may
  # not be listed by the forge yet: not a second pull request on top of them.
  [ -z "$(find "$ORCH_STATE_DIR/checks-starting" -mmin -2 2> /dev/null)" ] || return 1
  ( exec 6>> "$ORCH_STATE_DIR/heavy.lock" && flock -n 6 ) 2> /dev/null
}
session_hours=$(conf_get lanes session_hours)
[[ "$session_hours" =~ ^[0-9]+$ ]] || session_hours=6
states_of_work="$(conf_get linear todo_state), $(conf_get linear progress_state), $(conf_get linear review_state), $(conf_get linear validate_state), $(conf_get linear go_state)"
in_list() { tr ',' '\n' <<<"$2" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$1"; }
end_runs() { ledger sql "select run_id from runs where lane = '$1' and outcome = 'running'" | jq -r '.[].run_id' | while IFS= read -r run_id; do ledger run-end --run-id "$run_id" --outcome killed; done; }

# cost_left <record> <ticket>: sets cost_rest to what the ticket may still
# cost, or to nothing when it has no cap. The cap is [limits] ticket_cost_usd, or for
# one ticket the last line « Plafond : <n> » the user wrote on it (his own
# comments only: a line an agent wrote changes nothing). What it cost: every
# run of the ticket since its lane was first opened, as the ledger has it.
# Sets cost_cap and cost_spent too, for whoever says it. Called as it is,
# never inside $( ): it speaks through those three. Returns 1 when its cap
# or what it cost cannot be read (the tracker or the ledger does not
# answer): cost_rest is then empty, and nothing may be opened on a guess. Without a
# record (a ticket no lane was opened on yet), every run of the ticket counts.
cost_left() {
  local record=$1 ticket=$2 own rate from=1970
  cost_cap=$(conf_get limits ticket_cost_usd) cost_spent= cost_rest=
  [[ "$ticket" =~ ^[A-Z]+-[0-9]+$ ]] || return 1
  # The cap he wrote on the ticket is part of the answer: when his comments
  # cannot be read, the cap is not known either.
  "$ORCH_HOME/linear.sh" comments "$ticket" > "$work/cap-comments.json" 2> /dev/null || return 1
  jq -e 'type == "array"' "$work/cap-comments.json" > /dev/null 2>&1 || return 1
  cat "$ORCH_STATE_DIR/linear-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/cap-agents.txt" || true
  own=$(jq -r --rawfile ids "$work/cap-agents.txt" '($ids | split("\n")) as $agents | [.[] | select(.byOwner == true and (.id as $id | $agents | index($id) | not) and (.body | test("^\\s*(> *(Écrit|Ticket ouvert) par un agent|Chef de projet *:)") | not))] | sort_by(.createdAt) | map(.body | [scan("(?im)^\\s*plafond\\s*:\\s*([0-9]+(?:[.,][0-9]+)?)")] | .[]?[0]) | .[-1] // empty' "$work/cap-comments.json" 2> /dev/null | tr ',' '.') || return 1
  [ -z "$own" ] || cost_cap=$own
  [[ "$cost_cap" =~ ^[0-9]+([.][0-9]+)?$ ]] || { cost_cap=; return 0; }
  rate=$(conf_get currency usd_eur)
  [[ "$rate" =~ ^[0-9]+([.][0-9]+)?$ ]] || rate=1
  [ -z "$record" ] || from=$(jq -r '(.opened_at // "1970")[0:19]' "$record" 2> /dev/null) || from=
  [[ "$from" =~ ^[0-9T:-]+$ ]] || return 1
  cost_spent=$(ledger sql "select coalesce(sum(cost_eur), 0) as spent from runs where ticket = '$ticket' and substr(started_at, 1, 19) >= '$from'" 2> /dev/null | jq -r --argjson rate "$rate" '.[0].spent / $rate | . * 100 | round / 100' 2> /dev/null) || cost_spent=
  [[ "$cost_spent" =~ ^[0-9]+([.][0-9]+)?$ ]] || { cost_spent=; return 1; }
  cost_rest=$(jq -nr --argjson cap "$cost_cap" --argjson spent "$cost_spent" '$cap - $spent | . * 100 | round / 100') || cost_rest=
  [[ "$cost_rest" =~ ^-?[0-9]+([.][0-9]+)?$ ]] || { cost_rest=; return 1; }
}

# at_cost_cap <record> <ticket>: said, and told to the lead once for a given
# cap, when the ticket has reached it.
at_cost_cap() {
  local record=$1 ticket=$2
  did "$record" "cost:$cost_cap" && return 0
  say "$ticket: at its cap ($(printf '%.2f' "$cost_spent") \$ of $cost_cap \$): not opened again"
  [ -n "$dry" ] || ledger event --kind ticket_cost --ticket "$ticket" --value "$cost_spent" --detail "the lane of $ticket has cost $(printf '%.2f' "$cost_spent") \$ at list price, for a cap of $cost_cap \$ on this ticket: it is stopped and not opened again, what it had committed is on its branch. Tell the user what was done and what is left (its last report says), and ask him one closed question: raise the cap of this ticket, yes or no, with your recommendation and an amount; he answers by writing a line « Plafond : <amount> » on the ticket"
  mark "$record" "cost:$cost_cap"
}

# again <record> <ticket> <role> <key> <file that says why> [keep]: one more
# run of the lane, once for that key. With « keep », the ticket stays in the
# status it is in. Returns 0 when the lane was opened (in a rehearsal: would
# be), 1 when it was not: no place now, the subscription at its stop, opened
# for that already, or a loop.
# No loop: for a given kind of reason (its checks, a reviewer, the base, a
# session that stopped, work that would not leave), three runs in a day;
# then it is said, and left. A word of the user or of the lead is not a
# loop. [lanes] runs_per_day is the net under all of it.
again() {
  local record=$1 ticket=$2 role=$3 key=$4 why=$5 keep=${6:-} today same kind code=0 since left
  kind=${key%%:*}
  # Whatever opens the lane again, a card the user put in the status of his
  # agreement stays there: only he, or a version he was not shown, takes it
  # out (merge-pr.sh).
  [ "${state:-}" != "$(conf_get linear go_state)" ] || keep=keep
  if did "$record" "$key"; then
    # Opened again for that already, its session is over, and the reason
    # still holds: the rules cannot move it. Said once, and left.
    if ! did "$record" "still:$key"; then
      say "$ticket: opened again for this already and nothing changed ($key): left as it is"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --detail "the lane of $ticket was opened again ($key), its session ended, and the reason still holds: the rules cannot move it further. Tell the user where the ticket stands"
      mark "$record" "still:$key"
    fi
    return 1
  fi
  since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
  case "$kind" in
    said | told) ;;
    *)
      same=$(jq --arg kind "$kind:" --arg since "$since" '[(.done // {}) | to_entries[] | select((.key | startswith($kind)) and .value >= $since)] | length' "$record")
      if [ "$same" -ge 3 ]; then
        if ! did "$record" "loop:$kind:$(date -u +%F)"; then
          say "$ticket: opened again $same times in a day for the same reason ($kind): left as it is"
          [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --value "$same" --detail "the lane of $ticket was opened again $same times in a day for the same reason ($kind) and it holds again ($key): it is not opened a fourth time. Tell the user which reason, what the lane did about it each time, and ask him whether to go on"
          mark "$record" "loop:$kind:$(date -u +%F)"
        fi
        return 1
      fi
      ;;
  esac
  today=$(jq --arg since "$since" '[.runs[]? | select(.at >= $since)] | length' "$record")
  if [ "$today" -ge "$cap" ]; then
    if ! did "$record" "stuck:$(date -u +%F)"; then
      say "$ticket: opened $today times in a day, not opened again ($key)"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --value "$today" --detail "the lane of $ticket was opened $today times in a day and still needs one more run ($key): it is left as it is. Tell the user where the ticket stands"
      mark "$record" "stuck:$(date -u +%F)"
    fi
    return 1
  fi
  # The cap of the ticket: nothing opens it once reached; else the session
  # is given what is left.
  if ! cost_left "$record" "$ticket"; then
    say "$ticket: its cap or what it has cost cannot be read: not opened again ($key)"
    return 1
  fi
  left=$cost_rest
  if [ -n "$left" ] && [ "$(jq -n --argjson left "$left" '$left <= 0')" = true ]; then
    at_cost_cap "$record" "$ticket"
    return 1
  fi
  if [ -n "$dry" ]; then say "$ticket: opened again ($key)"; return 0; fi
  "$ORCH_HOME/spawn-lane.sh" "$role" "$ticket" --resume --message-file "$why" --comment-on none ${keep:+--keep-status} ${left:+--budget "$left"} > /dev/null 2> "$work/spawn.err" || code=$?
  case "$code" in
    0)
      say "$ticket: opened again ($key)"
      mark "$record" "$key"
      # The cap that session runs under: what a stop by its budget is read against.
      [ -z "$cost_cap" ] || mark "$record" "capof:$cost_cap"
      return 0
      ;;
    3 | 4) return 1 ;; # no place now, or the subscription at its stop: tried again at the next wake
    *)
      say "$ticket: could not be opened again: $(sed -n '$p' "$work/spawn.err")"
      return 1
      ;;
  esac
}

# base_without_model <record> <ticket> <role> <lane> <pr>: the base brought
# into the branch of a lane by the rules, when nothing has to be decided: a
# merge git makes by itself, in a worktree made for it, sent the way a
# session sends its work (push-lane.sh: the guard, never forced). Returns 1,
# with nothing changed, when the merge needs somebody: the lane is opened.
# Tried once for a given state of the branch and of the base: what git or
# the push refused is not asked again at every wake. Whatever fails, the
# branch is left where it was: a merge that did not leave is nobody's work.
base_without_model() {
  local record=$1 ticket=$2 role=$3 lane=$4 pr=$5 spot sent push_branch before tried
  [ -z "$dry" ] || return 1
  # A project may want a session of the lane every time ([lanes]
  # base_without_model = no): its tests run again on what the merge gave.
  [ "$(conf_get lanes base_without_model)" != no ] || return 1
  push_branch=$(jq -r '.push_branch // empty' "$record")
  tried="nobase:$(git -C "$ORCH_REPO" rev-parse --short "origin/${push_branch:-$lane}" 2> /dev/null):$(git -C "$ORCH_REPO" rev-parse --short "$base" 2> /dev/null)"
  ! did "$record" "$tried" || return 1
  spot="$(dirname "$(jq -r '.worktree' "$record")")/.base-$ticket"
  git -C "$ORCH_REPO" worktree remove --force "$spot" > /dev/null 2>&1 || true
  git -C "$ORCH_REPO" worktree add --quiet "$spot" "$lane" 2> /dev/null || return 1
  before=$(git -C "$spot" rev-parse HEAD)
  if git -C "$spot" merge --quiet --ff-only "origin/${push_branch:-$lane}" 2> /dev/null \
    && before=$(git -C "$spot" rev-parse HEAD) && echo "$before" > "$(git -C "$spot" rev-parse --absolute-git-dir)/base-before" \
    && git -C "$spot" -c user.name="$(git -C "$ORCH_REPO" config user.name || echo dispatcher)" -c user.email="$(git -C "$ORCH_REPO" config user.email || echo dispatcher@localhost)" merge --quiet --no-edit "$base" > /dev/null 2>&1 \
    && sent=$(ORCH_TICKET=$ticket ORCH_ROLE=$role ORCH_LANE=$lane ORCH_PUSH_BRANCH=$push_branch "$ORCH_HOME/push-lane.sh" "$spot" 2> /dev/null | sed -n '$p') && [[ "$sent" =~ ^#[0-9]+$ ]]; then
    git -C "$ORCH_REPO" worktree remove --force "$spot" > /dev/null 2>&1 || true
    jq --arg at "$(now_utc)" '. + {pushed_at: $at}' "$record" > "$record.part" && mv "$record.part" "$record"
    return 0
  fi
  git -C "$spot" merge --abort > /dev/null 2>&1 || true
  git -C "$spot" reset --quiet --hard "$before" > /dev/null 2>&1 || true
  git -C "$ORCH_REPO" worktree remove --force "$spot" > /dev/null 2>&1 || true
  mark "$record" "$tried"
  return 1
}

# What a round that died in the middle of that left: its worktree, and at
# most the merge it had made on the tip it wrote down (base-before), that no
# remote has. Both go before anything is counted (one round at a time:
# nothing of this round is in there yet). Any other commit is somebody's
# work, and stays.
base_leftovers() {
  local root spot before
  [ -z "$dry" ] || return 0
  root=$(expand_home "$(conf_get lanes root)")
  for spot in "$root"/.base-*; do
    [ -d "$spot" ] || continue
    git -C "$spot" merge --abort > /dev/null 2>&1 || true
    before=$(cat "$(git -C "$spot" rev-parse --absolute-git-dir 2> /dev/null)/base-before" 2> /dev/null) || before=
    if [ -n "$before" ] && [ "$(git -C "$spot" rev-parse --verify --quiet 'HEAD^1')" = "$before" ] && git -C "$spot" rev-parse --verify --quiet 'HEAD^2' > /dev/null \
      && [ "$(git -C "$spot" rev-list --count HEAD --not --remotes 2> /dev/null)" = 1 ]; then
      git -C "$spot" reset --quiet --hard "$before" > /dev/null 2>&1 || true
    fi
    if ! git -C "$ORCH_REPO" worktree remove --force "$spot" > /dev/null 2>&1; then
      # No longer a worktree git knows: only the directory this script made is taken away.
      if [[ "$(basename "$spot")" =~ ^\.base-[A-Z]+-[0-9]+$ ]] && [ -f "$spot/.git" ]; then rm -rf -- "$spot" 2> /dev/null || true; fi
      git -C "$ORCH_REPO" worktree prune > /dev/null 2>&1 || true
    fi
    if [ -e "$spot" ]; then say "what a round left of a base brought in without a model could not be cleared ($spot)"; else say "what a round left of a base brought in without a model is cleared ($(basename "$spot"))"; fi
  done
}

# 1. The lanes that exist: one step each. What goes wrong with one is said
# and looked at again at the next wake; it does not stop the others.
one_lane() {
  local record=$1 ticket role lane last code worktree state pr pull head branch checks ran verdict reviewed_by run_id asked report candidate ended run pid age own sent shown covered progress_state review_state validate_state go_state kept_from kept_in key
  [ "$(jq -r '.closed // empty' "$record")" = "" ] || return 0
  ticket=$(jq -r '.ticket' "$record") role=$(jq -r '.role' "$record") lane=$(jq -r '.lane' "$record")
  last=$(jq -r '.runs[-1].run // empty' "$record")
  [ -n "$last" ] || return 0
  # A session that is not over: at work, unless it died without a word (its
  # terminal closed, the host restarted), never started (no terminal ever
  # ran it), or runs for longer than a session may. Each is then a session
  # that stopped short.
  if [ ! -f "$ORCH_STATE_DIR/runs/$last/exit-code" ]; then
    pid=$(cat "$ORCH_STATE_DIR/runs/$last/pid" 2> /dev/null) || pid=
    age=$(( ( $(date +%s) - $(date -d "$(jq -r '.runs[-1].at' "$record")" +%s) ) / 60 ))
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      [ "$age" -ge $(( session_hours * 60 )) ] || return 0
      say "$ticket: its session runs for more than $session_hours hours: stopped"
      [ -z "$dry" ] || return 0
      orca terminal close --terminal "$(cat "$ORCH_STATE_DIR/runs/$last/terminal.handle" 2> /dev/null)" > /dev/null 2>&1 || true
      kill "$pid" 2> /dev/null || true
      echo 124 > "$ORCH_STATE_DIR/runs/$last/exit-code"
    elif [ -n "$pid" ]; then
      say "$ticket: its session died without a word"
      [ -z "$dry" ] || return 0
      echo 137 > "$ORCH_STATE_DIR/runs/$last/exit-code"
    elif pgrep -f -- "lane-run.sh $ORCH_STATE_DIR/runs/$last\$" > /dev/null 2>&1; then
      # No word of which process it is, yet it is there: at work.
      return 0
    elif [ "$age" -ge 10 ]; then
      say "$ticket: its session never started"
      [ -z "$dry" ] || return 0
      echo 97 > "$ORCH_STATE_DIR/runs/$last/exit-code"
    else
      return 0
    fi
    end_runs "$lane"
  fi
  code=$(cat "$ORCH_STATE_DIR/runs/$last/exit-code")
  worktree=$(jq -r '.worktree' "$record")

  # A ticket that is done or given up has no lane any more.
  state=$("$ORCH_HOME/linear.sh" state "$ticket" 2> /dev/null) || state=
  [ -n "$state" ] || return 0
  if tr ',' '\n' <<<"$(conf_get lanes closed_states), $(conf_get linear done_state)" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$state"; then
    say "$ticket: its ticket is « $state »: nothing more to do"
    mark "$record" "over"
    [ -n "$dry" ] || { jq --arg at "$(now_utc)" '. + {closed: $at}' "$record" > "$record.part" && mv "$record.part" "$record"; }
    return 0
  fi
  # A ticket the user took out of the work (back to the backlog, or any
  # status that is not one of the work): its lane waits, nothing is opened.
  in_list "$state" "$states_of_work" || return 0

  # A session its budget stopped is over, like any other: what it committed
  # was sent, and the cap is said here, when it is spent or is still the one
  # that session ran under. A cap the user raised since is no stop to tell:
  # his line is a word of his, and opens the lane below with what is left.
  # Any other session that stopped short is run again.
  if [ "$code" = 5 ]; then
    if cost_left "$record" "$ticket" && [ -n "$cost_cap" ]; then
      if [ "$(jq -n --argjson left "$cost_rest" '$left <= 0')" = true ] || did "$record" "capof:$cost_cap"; then at_cost_cap "$record" "$ticket"; fi
    fi
  elif [ "$code" != 0 ]; then
    printf 'Ta session précédente s’est arrêtée sans finir (code %s). Reprends où elle en était : relis `git status` et `git log`, termine, et rends ton compte rendu.\n' "$code" > "$work/why.md"
    again "$record" "$ticket" "$role" "stopped:$last" "$work/why.md"
    return 0
  fi

  # Its session is over: its worktree goes once nothing in it is unsent. The
  # branch and this record stay; it is opened again from them.
  if [ -d "$worktree" ]; then
    own=$(git -C "$worktree" rev-parse HEAD 2> /dev/null) || own=
    if [ -n "$(git -C "$worktree" status --porcelain 2> /dev/null)" ]; then
      # Files left uncommitted: only the lane knows what they are.
      printf 'Ta session précédente a laissé des fichiers non commités dans ton worktree (`git status` les montre). Commite ce qui fait partie de ton travail, retire le reste, et rends ton compte rendu.\n' > "$work/why.md"
      again "$record" "$ticket" "$role" "unsent:$own" "$work/why.md"
      return 0
    elif [ "$(git -C "$worktree" rev-list --count HEAD --not --remotes 2> /dev/null || echo 1)" != 0 ]; then
      # Commits no remote has: what ran the session stopped before its push
      # (or the push was refused). Sent here, the way the session would
      # have; a refusal goes back to the lane, with what was refused.
      did "$record" "push:$own" && return 0
      if [ -n "$dry" ]; then say "$ticket: its session ended without sending its work: it would be sent now"; return 0; fi
      if sent=$( (set -a; . "$ORCH_STATE_DIR/runs/$last/lane.env"; set +a; "$ORCH_HOME/push-lane.sh" "$worktree") 2> "$work/push.err" | sed -n '$p') && [[ "$sent" =~ ^#[0-9]+$ ]]; then
        say "$ticket: its session ended without sending its work: sent now ($sent)"
        jq --argjson pr "${sent#\#}" --arg at "$(now_utc)" '. + {pr: $pr, pushed_at: $at}' "$record" > "$record.part" && mv "$record.part" "$record"
      else
        { echo "Ton travail n'a pas pu être envoyé : le script de push l'a refusé. Ce qu'il a dit :"; sed -n '$p' "$work/push.err"; echo "Corrige ce qui est refusé (sans rien contourner), commite, et rends ton compte rendu."; } > "$work/why.md"
        again "$record" "$ticket" "$role" "push:$own" "$work/why.md"
      fi
      return 0
    elif [ -z "$dry" ]; then
      # What the lane set apart for the user (a capture taken on the
      # demonstration data) exists only in its worktree: kept under its
      # ticket, where the lead finds it, before the worktree goes.
      kept_from=$(conf_get lanes kept_from) kept_in=$(expand_home "$(conf_get lanes kept_in)")
      if [ -n "$kept_from" ] && [ -n "$kept_in" ] && [ -n "$(ls -A "$worktree/$kept_from" 2> /dev/null)" ]; then
        if mkdir -p "$kept_in/$ticket" && cp -a "$worktree/$kept_from/." "$kept_in/$ticket/"; then
          say "$ticket: what its lane set apart for the user is kept in $kept_in/$ticket"
        else
          say "$ticket: what its lane set apart for the user could not be kept: its worktree stays"
          return 0
        fi
      fi
      orca terminal close --worktree "path:$worktree" --all > /dev/null 2>&1 || true
      orca worktree rm --worktree "path:$worktree" --force > /dev/null 2>&1 || git -C "$ORCH_REPO" worktree remove --force "$worktree" 2> /dev/null || true
      [ -d "$worktree" ] || say "$ticket: session over, work sent: its worktree is closed"
    fi
  fi

  # A session that ends on a question for the user: the lead is told, it
  # is the one that speaks to him. His answer on the ticket opens the lane
  # again by itself (below).
  if ! did "$record" "asked:$last"; then
    report="$ORCH_STATE_DIR/reports/$last-$role-a1.md"
    for candidate in "$ORCH_STATE_DIR/reports/$last-$role"-a*.md; do [ ! -f "$candidate" ] || report=$candidate; done
    asked=$(sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$report" 2> /dev/null | awk '{ line = $0 } !inside && tolower(line) ~ /^[#*[:space:]]*questions pour/ { inside = 1; sub(/^[#*[:space:]]*[Qq]uestions pour[^:]*:?[*[:space:]]*/, "", line); if (line != "") print line; next } inside { print line }' | grep -v '^[[:space:]]*$' | grep -viE '^[-*[:space:]]*(aucune|rien|néant|pas de question)\b' | sed '/^## /d' | head -n 20 || true)
    if [ -n "$asked" ]; then
      say "$ticket: its session ends on a question for the user"
      [ -n "$dry" ] || ledger event --kind lane_asks --ticket "$ticket" --detail "$(printf '%s' "$asked" | cut -c1-1500)"
    fi
    mark "$record" "asked:$last"
  fi

  # What the user wrote on the ticket that its last session was not handed
  # (the run keeps which of his words it was given: a word that came while
  # it was being opened, or while it ran, was seen by nobody; a record from
  # before runs kept that goes by the time), and what the lead wrote to the
  # lane (tell-lane.sh <ticket>: its sessions read no terminal). Both go to
  # the lane together, quoted, in one session. Not under the user's
  # agreement: a word after his « go » is read by the lead and does not take
  # it back. When the lane cannot be opened now (no place, the subscription
  # at its stop), the rest of its step goes on: work that is finished is
  # not held back by a word that waits.
  ended=$(jq -r '.runs[-1].at' "$record")
  echo '[]' > "$work/his.json"
  echo '[]' > "$work/told.json"
  if "$ORCH_HOME/linear.sh" comments "$ticket" > "$work/comments.json" 2> /dev/null; then
    cat "$ORCH_STATE_DIR/linear-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
    jq -c --arg since "$ended" --rawfile ids "$work/agent-ids.txt" --argjson seen "$(jq -c '.runs[-1].seen // null' "$record")" '($ids | split("\n")) as $agents | [.[] | select(.byOwner == true and (if $seen then (.id as $id | $seen | index($id) | not) else .createdAt > $since end) and (.id as $id | $agents | index($id) | not) and (.body | test("^\\s*(> *(Écrit|Ticket ouvert) par un agent|Chef de projet *:)") | not))] | sort_by(.createdAt)' "$work/comments.json" > "$work/his.json"
    [ "$(jq length "$work/his.json")" = 0 ] || ! did "$record" "said:$(jq -r '.[-1].id' "$work/his.json")" || echo '[]' > "$work/his.json"
  fi
  if [ -s "$ORCH_STATE_DIR/lanes/$ticket.told.jsonl" ]; then
    jq -c --slurpfile done <(jq -c '.done // {}' "$record") -R 'fromjson? | select($done[0]["told:" + .at] == null)' "$ORCH_STATE_DIR/lanes/$ticket.told.jsonl" | jq -sc 'sort_by(.at)' > "$work/told.json"
  fi
  if [ "$state" != "$(conf_get linear go_state)" ] && [ "$(jq -s 'map(length) | add' "$work/his.json" "$work/told.json")" != 0 ]; then
    {
      if [ "$(jq length "$work/his.json")" != 0 ]; then
        echo "L'utilisateur a écrit sur le ticket depuis ta dernière session :"
        jq -r '.[] | "le \(.createdAt[0:16] | sub("T"; " à ")) : " + .body' "$work/his.json"
      fi
      if [ "$(jq length "$work/told.json")" != 0 ]; then
        echo "Le chef de projet t’a écrit depuis ta dernière session (il relaie ; ce sont des constats à traiter dans ta copie de travail) :"
        jq -r '.[] | "le \(.at[0:16] | sub("T"; " à ")) : " + .text' "$work/told.json"
      fi
    } > "$work/why.md"
    # His word shows the ticket at work. The lead's alone leaves a card
    # that asks the user where it asks him.
    asked=
    if [ "$(jq length "$work/his.json")" != 0 ]; then
      key="said:$(jq -r '.[-1].id' "$work/his.json")"
    else
      key="told:$(jq -r '.[-1].at' "$work/told.json")"
      [ "$state" != "$(conf_get linear validate_state)" ] || asked=keep
    fi
    if again "$record" "$ticket" "$role" "$key" "$work/why.md" "$asked"; then
      # Handed together: none of them opens it again.
      if [ -z "$dry" ]; then
        while IFS= read -r asked; do mark "$record" "told:$asked"; done < <(jq -r '.[].at' "$work/told.json")
      fi
      return 0
    fi
  fi

  pr=$(jq -r '.pr // empty' "$record")
  [ -n "$pr" ] || return 0
  pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json state,isDraft,headRefOid,headRefName,statusCheckRollup 2> /dev/null) || return 0
  case "$(jq -r '.state' <<<"$pull")" in
    MERGED | CLOSED)
      say "$ticket: its pull request #$pr is $(jq -r '.state' <<<"$pull")"
      [ -n "$dry" ] || { jq --arg at "$(now_utc)" '. + {closed: $at}' "$record" > "$record.part" && mv "$record.part" "$record"; }
      return 0
      ;;
  esac
  head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")

  # A branch that lacks code of the base brings it in first.
  git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" "$branch" 2> /dev/null || return 0
  if ! git -C "$ORCH_REPO" merge-base --is-ancestor "$base" "$head" 2> /dev/null; then
    git -C "$ORCH_REPO" diff --name-only --no-renames "$head...$base" | jq -R . | jq -sc . > "$work/lag.json"
    if ! node --no-warnings "$ORCH_HOME/lib/merge.mjs" lag "$work/lag.json"; then
      # Without a model when nothing has to be decided: the review and the
      # agreement given for the version before still hold (only_base_merges).
      if base_without_model "$record" "$ticket" "$role" "$lane" "$pr"; then
        say "$ticket: the base is brought in without a model (#$pr)"
        return 0
      fi
      printf 'La branche principale a avancé sur du code depuis ta dernière session. Réintègre-la dans ta branche (`git merge %s`), résous les conflits s’il y en a en gardant ce que fait chaque côté, relance les tests de ce que tu touches, et commite.\n' "$base" > "$work/why.md"
      # His card stays where it is: the base brought in as it is changes
      # nothing of what he agreed to, or is asked.
      again "$record" "$ticket" "$role" "base:$(git -C "$ORCH_REPO" rev-parse --short "$base")" "$work/why.md" keep
      return 0
    fi
  fi

  # Out of draft: the ticket is where the agents check, and is put there
  # again when something else took it back to the status of the work.
  progress_state=$(conf_get linear progress_state) review_state=$(conf_get linear review_state)
  if [ "$(jq -r '.isDraft' <<<"$pull")" = false ] && [ -n "$review_state" ] && [ "$state" = "$progress_state" ]; then
    [ -n "$dry" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$review_state" > /dev/null 2>&1 || true
    state=$review_state
  fi

  checks=$(jq -c '[.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase]' <<<"$pull")
  ran=$(jq 'map(select(. == "SUCCESS" or . == "FAILURE" or . == "TIMED_OUT" or . == "CANCELLED")) | length' <<<"$checks")
  if [ "$(jq 'map(select(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING" or . == "WAITING")) | length' <<<"$checks")" != 0 ]; then
    return 0
  fi
  if [ "$(jq -r '.isDraft' <<<"$pull")" = true ]; then
    # Out of draft when the host is free for a run of the checks: one at a time.
    # (Also one that was taken out of draft at this version already and is
    # a draft again: something put it back, and nothing else will take it
    # out. To hold a lane, the ticket is taken out of the statuses of the
    # work, not its pull request put in draft.)
    free_for_a_run || return 0
    : > "$work/readied"
    if [ -n "$dry" ]; then say "$ticket: #$pr would be taken out of draft, its checks would start"; return 0; fi
    say "$ticket: #$pr is taken out of draft, its checks start"
    # Said to the door of the heavy commands before the checks start: a
    # screen test must not begin in the seconds GitHub takes to list them.
    : > "$ORCH_STATE_DIR/checks-starting"
    (cd "$ORCH_REPO" && gh pr ready "$pr") > /dev/null 2>&1 || return 0
    mark "$record" "ready:$head"
    [ -z "$review_state" ] || [ "$state" != "$progress_state" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$review_state" > /dev/null 2>&1 || true
    return 0
  fi
  if [ "$ran" = 0 ]; then
    # Out of draft and no check ran (all skipped, or none started): it is
    # given half an hour from when it left draft (from when it was first
    # seen so, for one somebody else took out), then said. Nothing here can
    # start them.
    asked=$(jq -r --arg head "$head" '.done["ready:" + $head] // .done["waits:" + $head] // empty' "$record")
    if [ -z "$asked" ]; then mark "$record" "waits:$head"; return 0; fi
    if [ "$(( $(date +%s) - $(date -d "$asked" +%s) ))" -ge 1800 ] && ! did "$record" "nochecks:$head"; then
      say "$ticket: #$pr is out of draft and none of its checks ran in half an hour"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --value "$pr" --detail "#$pr of $ticket is out of draft for half an hour and none of its checks ran (all skipped, or none started): no review is asked for and nothing can go live. Tell the user where the ticket stands"
      mark "$record" "nochecks:$head"
    fi
    return 0
  fi
  if [ "$(jq 'map(select(. == "FAILURE" or . == "TIMED_OUT")) | length' <<<"$checks")" != 0 ]; then
    {
      echo "Les vérifications automatiques sont rouges sur la version ${head:0:8} de ta branche. Ce qu'elles ont dit (extrait) :"
      run=$(cd "$ORCH_REPO" && gh run list --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId' 2> /dev/null) || run=
      [ -z "$run" ] || (cd "$ORCH_REPO" && gh run view "$run" --log-failed 2> /dev/null) | grep -E '✖|not ok|Error|error:|failing|expected|actual|\.mjs:[0-9]+' | cut -c1-400 | tail -n 80 || true
    } > "$work/why.md"
    again "$record" "$ticket" "$role" "checks:$head" "$work/why.md"
    return 0
  fi
  [ "$(jq 'map(select(. != "SUCCESS" and . != "SKIPPED" and . != "NEUTRAL")) | length' <<<"$checks")" = 0 ] || return 0

  # Green: read by a reviewer, at this version?
  verdict= reviewed_by=
  while IFS= read -r run_id; do
    [ -n "$run_id" ] || continue
    # Read at this version, or at one this version only adds the base to.
    only_base_merges "$(sed -n 's/^commit: //p' "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null | sed -n '1p')" "$head" || continue
    reviewed_by=$run_id
    if node --no-warnings "$ORCH_HOME/lib/merge.mjs" verdict "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null; then verdict=ok; else verdict=corrections; fi
    break
  done < <(ledger sql "select run_id from runs where role = 'review' and source = 'dispatcher' and outcome = 'done' and pr_number = $pr and ticket = '$ticket' order by started_at desc" | jq -r '.[].run_id')
  if [ -z "$reviewed_by" ]; then
    did "$record" "review:$head" && return 0
    say "$ticket: #$pr is green at ${head:0:8}: its review is asked for"
    [ -n "$dry" ] || { "$ORCH_HOME/review-pr.sh" "$pr" "$ticket" > /dev/null 2>&1 && mark "$record" "review:$head"; } || true
    return 0
  fi
  if [ "$verdict" = corrections ]; then
    {
      echo "Un relecteur (un autre modèle que toi) a lu la version ${head:0:8} de ta branche et demande des corrections. Ce qu'il a écrit :"
      sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$ORCH_STATE_DIR/reports/$reviewed_by.md" | sed '1d;$d'
    } > "$work/why.md"
    again "$record" "$ticket" "$role" "verdict:$reviewed_by" "$work/why.md"
    return 0
  fi
  # Reviewed, nothing blocking, green. Was the user asked for this version
  # already (or for one this version only adds the base to)? Then nothing
  # is asked again: his card waits for him, or he has agreed and the
  # go-live takes it from there. A card that left his statuses by another
  # hand than his (an automation of the tracker) goes back where it asks him.
  validate_state=$(conf_get linear validate_state) go_state=$(conf_get linear go_state)
  shown=$(jq -r --argjson pr "$pr" '.pulls[]? | select(.pr == $pr) | .head' "$ORCH_STATE_DIR/validations/$ticket.json" 2> /dev/null | sed -n '1p') || shown=
  covered=
  [ -z "$shown" ] || ! only_base_merges "$shown" "$head" || covered=1
  if [ -n "$covered" ]; then
    if [ "$state" = "$go_state" ]; then
      # He has agreed to it: kept, to tell a card that leaves his status
      # without him from one that only waited.
      did "$record" "agreed:$shown" || mark "$record" "agreed:$shown"
    elif [ "$state" != "$validate_state" ] && ! did "$record" "back:$head:$(jq -r '.runs | length' "$record")"; then
      if did "$record" "agreed:$shown"; then
        say "$ticket: left « $go_state » without him and with nothing new: back in « $validate_state »"
        [ -n "$dry" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$validate_state" > /dev/null 2>&1 || return 0
        [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --value "$pr" --detail "the user had put $ticket in « $go_state » for #$pr; the ticket then left that status by another hand than his, with nothing new in the pull request but the base brought in (an automation of the tracker on pull requests does that). It is back in « $validate_state »: the request made to him stands, nothing is to be asked again. Tell him his card must be put in « $go_state » once more"
      else
        # A lane opened again that had nothing to change (a word of his it
        # answered): the request made to him still holds.
        say "$ticket: asked for this version already: back in « $validate_state »"
        [ -n "$dry" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$validate_state" > /dev/null 2>&1 || return 0
      fi
      mark "$record" "back:$head:$(jq -r '.runs | length' "$record")"
    fi
    return 0
  fi
  # Never asked for this version: the lead asks the user for his agreement.
  did "$record" "ok:$head" || { say "$ticket: #$pr is reviewed and green at ${head:0:8}: the request for the agreement is the lead's"; mark "$record" "ok:$head"; }
}
base_leftovers || say "what a round left of a base brought in without a model could not be looked at"
for record in "$ORCH_STATE_DIR/lanes"/*.json; do
  [ -f "$record" ] || continue
  if ! jq -e 'type == "object" and (.ticket | type) == "string"' "$record" > /dev/null 2>&1; then
    say "$(basename "$record"): what is kept of this lane cannot be read: left aside"
    continue
  fi
  ( one_lane "$record" ) || say "$(jq -r '.ticket' "$record"): its step failed: looked at again at the next wake"
done

# 2. The tickets the user said « go » on, oldest first, within the limit.
todo=$(conf_get linear todo_state)
[ -n "$todo" ] || exit 0
# His « go » is read from the tracker: not from one that cannot tell him from
# an agent (a ticket an agent opened in the status would count as his),
# unless the project says it accepts that, as for a go-live.
if [ "$(conf_get merge separate_identity)" != no ] && [ "$("$ORCH_HOME/linear.sh" identity 2> /dev/null)" != app ]; then
  say "the tracker cannot tell the user from an agent: no lane is opened from « $todo » ([merge] separate_identity)"
  exit 0
fi
since=$(conf_get lanes todo_since)
"$ORCH_HOME/linear.sh" list "$todo" > "$work/todo.json" 2> /dev/null || exit 0
seen="$ORCH_STATE_DIR/lanes/.not-his"
touch "$seen"
while IFS=$'\t' read -r ticket updated; do
  [ -n "$ticket" ] || continue
  record=$(lane_record "$ticket")
  if [ -f "$record" ]; then
    # It has a lane: still his « go » of before, nothing to open. One whose
    # lane is over (its change live, or given up) and that he puts back in
    # the status asks for new work on a branch that already lived: said, not
    # guessed. A new ticket is the way.
    if [ "$(jq -r '.closed // empty' "$record")" != "" ] && ! did "$record" "again:$updated"; then
      say "$ticket: back in « $todo » after its lane was over: a new ticket is needed for new work"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --detail "$ticket was put back in « $todo », but its lane is over (its change went live, or was given up) and its branch has lived: no lane is opened on it again. New work needs a new ticket: tell the user"
      mark "$record" "again:$updated"
    fi
    continue
  fi
  # Who put it there is asked once for a given state of the ticket.
  grep -qxF -- "$ticket $updated" "$seen" && continue
  code=0
  "$ORCH_HOME/linear.sh" moved-by-owner "$ticket" "$todo" ${since:+"$since"} > /dev/null 2>&1 || code=$?
  case "$code" in
    0) ;;
    5 | 6 | 8) [ -n "$dry" ] || echo "$ticket $updated" >> "$seen"; continue ;;
    *) continue ;;
  esac
  if [ -n "$dry" ]; then say "$ticket: put in « $todo » by the user: its lane would be opened, if there is a place"; continue; fi
  code=0
  # Its cap, the one of the project or the one he wrote on this ticket, less
  # what the ticket already cost (a review before any lane).
  if ! cost_left "" "$ticket"; then say "$ticket: put in « $todo » by the user: its cap or what it has cost cannot be read, it waits"; continue; fi
  whole=$cost_rest
  if [ -n "$whole" ] && [ "$(jq -n --argjson left "$whole" '$left <= 0')" = true ]; then say "$ticket: put in « $todo » by the user: at its cap ($cost_spent \$ of $cost_cap \$) before any lane, it waits"; continue; fi
  "$ORCH_HOME/spawn-lane.sh" dev "$ticket" --comment-on none ${whole:+--budget "$whole"} > /dev/null 2> "$work/spawn.err" || code=$?
  case "$code" in
    0)
      say "$ticket: put in « $todo » by the user: its lane is opened"
      [ -z "$cost_cap" ] || [ ! -f "$ORCH_STATE_DIR/lanes/$ticket.json" ] || mark "$ORCH_STATE_DIR/lanes/$ticket.json" "capof:$cost_cap"
      ;;
    3) say "$ticket: put in « $todo » by the user: no place now (the limit of lanes), it waits"; break ;;
    4) say "$ticket: put in « $todo » by the user: the subscription is at its stop ($(sed -n 's/.*at its stop (\([^)]*\)).*/\1/p' "$work/spawn.err" | sed -n '$p')), it waits"; break ;;
    *) say "$ticket: put in « $todo » by the user: its lane could not be opened: $(sed -n '$p' "$work/spawn.err")" ;;
  esac
done < <(jq -r 'sort_by(.updatedAt) | .[] | [.identifier, .updatedAt] | @tsv' "$work/todo.json")
