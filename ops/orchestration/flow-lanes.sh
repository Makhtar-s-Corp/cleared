#!/usr/bin/env bash
# Moves the lanes forward by rule, with no model: from the wake, each minute.
# A ticket the user said « go » on is worked to the point where his
# agreement is asked, without anybody having to remember a step:
#
#   - a ticket he put himself in [linear] todo_state (moved there, or created
#     there, by him, since [lanes] todo_since) gets a lane, oldest first,
#     within the limit of lanes; the others wait where they are;
#   - a lane whose session is over, its work sent, is closed (its branch and
#     what is known of it stay: it is opened again from them);
#   - its pull request is taken out of draft when the host is free for a run
#     of the checks, one at a time;
#   - red checks, a branch that lacks code of the base, a reviewer that asks
#     for corrections, a session that stopped short, a word of the user on
#     the ticket: the lane is opened again, with what was said, quoted;
#   - green checks on a version no reviewer read: the review is asked for.
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
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base=$(conf_get lanes base)
cap=$(conf_get lanes runs_per_day)
[[ "$cap" =~ ^[0-9]+$ ]] || cap=6
say() { echo "$*"; }
did() { [ "$(jq -r --arg key "$2" '.done[$key] // empty' "$1")" != "" ]; }
mark() { [ -n "$dry" ] || { jq --arg key "$2" --arg at "$(now_utc)" '.done = ((.done // {}) + {($key): $at})' "$1" > "$1.part" && mv "$1.part" "$1"; }; }
host_free=
free_for_a_run() {
  [ -n "$host_free" ] || host_free=$("$ORCH_HOME/host-state.sh" 2> /dev/null | jq -r '.free_for_a_ci_run // false') || host_free=false
  [ "$host_free" = true ]
}

# again <record> <ticket> <role> <key> <file that says why>: one more run of
# the lane, once for that key, within the runs of the day.
again() {
  local record=$1 ticket=$2 role=$3 key=$4 why=$5 today code=0
  if did "$record" "$key"; then
    # Opened again for that already, its session is over, and the reason
    # still holds: the rules cannot move it. Said once, and left.
    if ! did "$record" "still:$key"; then
      say "$ticket: opened again for this already and nothing changed ($key): left as it is"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --detail "the lane of $ticket was opened again ($key), its session ended, and the reason still holds: the rules cannot move it further. Tell the user where the ticket stands"
      mark "$record" "still:$key"
    fi
    return 0
  fi
  today=$(jq --arg since "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" '[.runs[]? | select(.at >= $since)] | length' "$record")
  if [ "$today" -ge "$cap" ]; then
    if ! did "$record" "stuck:$(date -u +%F)"; then
      say "$ticket: opened $today times in a day, not opened again ($key)"
      [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --value "$today" --detail "the lane of $ticket was opened $today times in a day and still needs one more run ($key): it is left as it is. Tell the user where the ticket stands"
      mark "$record" "stuck:$(date -u +%F)"
    fi
    return 0
  fi
  say "$ticket: opened again ($key)"
  [ -z "$dry" ] || return 0
  "$ORCH_HOME/spawn-lane.sh" "$role" "$ticket" --resume --message-file "$why" > /dev/null 2> "$work/spawn.err" || code=$?
  case "$code" in
    0) mark "$record" "$key" ;;
    3) : ;; # no place now: tried again at the next wake
    *) say "$ticket: could not be opened again: $(sed -n '$p' "$work/spawn.err")" ;;
  esac
}

# 1. The lanes that exist.
for record in "$ORCH_STATE_DIR/lanes"/*.json; do
  [ -f "$record" ] || continue
  [ "$(jq -r '.closed // empty' "$record")" = "" ] || continue
  ticket=$(jq -r '.ticket' "$record") role=$(jq -r '.role' "$record") lane=$(jq -r '.lane' "$record")
  last=$(jq -r '.runs[-1].run // empty' "$record")
  # A session not over yet (or not started yet): nothing to do before it is.
  [ -n "$last" ] && [ -f "$ORCH_STATE_DIR/runs/$last/exit-code" ] || continue
  code=$(cat "$ORCH_STATE_DIR/runs/$last/exit-code")
  worktree=$(jq -r '.worktree' "$record")

  # A ticket that is done or given up has no lane any more.
  state=$("$ORCH_HOME/linear.sh" state "$ticket" 2> /dev/null) || state=
  [ -n "$state" ] || continue
  if tr ',' '\n' <<<"$(conf_get lanes closed_states), $(conf_get linear done_state)" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$state"; then
    say "$ticket: its ticket is « $state »: nothing more to do"
    mark "$record" "over"
    [ -n "$dry" ] || { jq --arg at "$(now_utc)" '. + {closed: $at}' "$record" > "$record.part" && mv "$record.part" "$record"; }
    continue
  fi

  # A session that stopped short is run again.
  if [ "$code" != 0 ]; then
    printf 'Ta session précédente s’est arrêtée sans finir (code %s). Reprends où elle en était : relis `git status` et `git log`, termine, et rends ton compte rendu.\n' "$code" > "$work/why.md"
    again "$record" "$ticket" "$role" "stopped:$last" "$work/why.md"
    continue
  fi

  # Its session is over: its worktree goes once nothing in it is unsent. The
  # branch and this record stay; it is opened again from them.
  if [ -d "$worktree" ]; then
    if [ -n "$(git -C "$worktree" status --porcelain 2> /dev/null)" ] || [ "$(git -C "$worktree" rev-list --count HEAD --not --remotes 2> /dev/null || echo 1)" != 0 ]; then
      if ! did "$record" "unsent:$last"; then
        say "$ticket: its session is over but its work is not all sent: left open, to be looked at"
        [ -n "$dry" ] || ledger event --kind lane_stuck --ticket "$ticket" --detail "the session of the lane of $ticket is over, but its work is not all on the remote (uncommitted files, or a push the guard refused): its worktree is kept, to be looked at"
        mark "$record" "unsent:$last"
      fi
    elif [ -z "$dry" ]; then
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
    asked=$(sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$report" 2> /dev/null | awk 'tolower($0) ~ /questions pour/ {inside = 1; next} inside' | grep -v '^[[:space:]]*$' | grep -viE '^[-*[:space:]]*(aucune|rien|néant|pas de question)\b' | sed '/^## /d' | head -n 20 || true)
    if [ -n "$asked" ]; then
      say "$ticket: its session ends on a question for the user"
      [ -n "$dry" ] || ledger event --kind lane_asks --ticket "$ticket" --detail "$(printf '%s' "$asked" | cut -c1-1500)"
    fi
    mark "$record" "asked:$last"
  fi

  # What the user wrote on the ticket since its last session was opened
  # (that session was handed what he had written before; a word of his that
  # came while it ran was seen by nobody): his word goes to the lane, once.
  ended=$(jq -r '.runs[-1].at' "$record")
  if "$ORCH_HOME/linear.sh" comments "$ticket" > "$work/comments.json" 2> /dev/null; then
    cat "$ORCH_STATE_DIR/linear-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
    jq -c --arg since "$ended" --rawfile ids "$work/agent-ids.txt" '($ids | split("\n")) as $agents | [.[] | select(.byOwner == true and .createdAt > $since and (.id as $id | $agents | index($id) | not) and (.body | test("^\\s*(> *(Écrit|Ticket ouvert) par un agent|Chef de projet *:)") | not))] | sort_by(.createdAt)' "$work/comments.json" > "$work/his.json"
    if [ "$(jq length "$work/his.json")" != 0 ]; then
      { echo "L'utilisateur a écrit sur le ticket depuis ta dernière session :"; jq -r '.[] | "le \(.createdAt[0:16] | sub("T"; " à ")) : " + .body' "$work/his.json"; } > "$work/why.md"
      if ! did "$record" "said:$(jq -r '.[-1].id' "$work/his.json")"; then
        again "$record" "$ticket" "$role" "said:$(jq -r '.[-1].id' "$work/his.json")" "$work/why.md"
        continue
      fi
    fi
  fi

  pr=$(jq -r '.pr // empty' "$record")
  [ -n "$pr" ] || continue
  pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json state,isDraft,headRefOid,headRefName,statusCheckRollup 2> /dev/null) || continue
  case "$(jq -r '.state' <<<"$pull")" in
    MERGED | CLOSED)
      say "$ticket: its pull request #$pr is $(jq -r '.state' <<<"$pull")"
      [ -n "$dry" ] || { jq --arg at "$(now_utc)" '. + {closed: $at}' "$record" > "$record.part" && mv "$record.part" "$record"; }
      continue
      ;;
  esac
  head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")

  # A branch that lacks code of the base brings it in first.
  git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" "$branch" 2> /dev/null || continue
  if ! git -C "$ORCH_REPO" merge-base --is-ancestor "$base" "$head" 2> /dev/null; then
    git -C "$ORCH_REPO" diff --name-only --no-renames "$head...$base" | jq -R . | jq -sc . > "$work/lag.json"
    if ! node --no-warnings "$ORCH_HOME/lib/merge.mjs" lag "$work/lag.json"; then
      printf 'La branche principale a avancé sur du code depuis ta dernière session. Réintègre-la dans ta branche (`git merge %s`), résous les conflits s’il y en a en gardant ce que fait chaque côté, relance les tests de ce que tu touches, et commite.\n' "$base" > "$work/why.md"
      again "$record" "$ticket" "$role" "base:$(git -C "$ORCH_REPO" rev-parse --short "$base")" "$work/why.md"
      continue
    fi
  fi

  checks=$(jq -c '[.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase]' <<<"$pull")
  ran=$(jq 'map(select(. == "SUCCESS" or . == "FAILURE" or . == "TIMED_OUT" or . == "CANCELLED")) | length' <<<"$checks")
  if [ "$(jq 'map(select(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING" or . == "WAITING")) | length' <<<"$checks")" != 0 ]; then
    continue
  fi
  if [ "$(jq -r '.isDraft' <<<"$pull")" = true ]; then
    # Out of draft when the host is free for a run of the checks: one at a time.
    did "$record" "ready:$head" && continue
    free_for_a_run || continue
    say "$ticket: #$pr is taken out of draft, its checks start"
    if [ -z "$dry" ]; then
      (cd "$ORCH_REPO" && gh pr ready "$pr") > /dev/null 2>&1 || continue
      mark "$record" "ready:$head"
      review_state=$(conf_get linear review_state)
      [ -z "$review_state" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$review_state" > /dev/null 2>&1 || true
    fi
    host_free=false
    continue
  fi
  [ "$ran" != 0 ] || continue
  if [ "$(jq 'map(select(. == "FAILURE" or . == "TIMED_OUT")) | length' <<<"$checks")" != 0 ]; then
    {
      echo "Les vérifications automatiques sont rouges sur la version ${head:0:8} de ta branche. Ce qu'elles ont dit (extrait) :"
      run=$(cd "$ORCH_REPO" && gh run list --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId' 2> /dev/null) || run=
      [ -z "$run" ] || (cd "$ORCH_REPO" && gh run view "$run" --log-failed 2> /dev/null) | grep -E '✖|not ok|Error|error:|failing|expected|actual|\.mjs:[0-9]+' | cut -c1-400 | tail -n 80 || true
    } > "$work/why.md"
    again "$record" "$ticket" "$role" "checks:$head" "$work/why.md"
    continue
  fi
  [ "$(jq 'map(select(. != "SUCCESS" and . != "SKIPPED" and . != "NEUTRAL")) | length' <<<"$checks")" = 0 ] || continue

  # Green: read by a reviewer, at this version?
  verdict= reviewed_by=
  while IFS= read -r run_id; do
    [ -n "$run_id" ] || continue
    [ "$(sed -n 's/^commit: //p' "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null | sed -n '1p')" = "$head" ] || continue
    reviewed_by=$run_id
    if node --no-warnings "$ORCH_HOME/lib/merge.mjs" verdict "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null; then verdict=ok; else verdict=corrections; fi
    break
  done < <(ledger sql "select run_id from runs where role = 'review' and source = 'dispatcher' and outcome = 'done' and pr_number = $pr and ticket = '$ticket' order by started_at desc" | jq -r '.[].run_id')
  if [ -z "$reviewed_by" ]; then
    did "$record" "review:$head" && continue
    say "$ticket: #$pr is green at ${head:0:8}: its review is asked for"
    [ -n "$dry" ] || { "$ORCH_HOME/review-pr.sh" "$pr" "$ticket" > /dev/null 2>&1 && mark "$record" "review:$head"; } || true
    continue
  fi
  if [ "$verdict" = corrections ]; then
    {
      echo "Un relecteur (un autre modèle que toi) a lu la version ${head:0:8} de ta branche et demande des corrections. Ce qu'il a écrit :"
      sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$ORCH_STATE_DIR/reports/$reviewed_by.md" | sed '1d;$d'
    } > "$work/why.md"
    again "$record" "$ticket" "$role" "verdict:$reviewed_by" "$work/why.md"
    continue
  fi
  # Reviewed, nothing blocking, green: the lead asks the user for his agreement.
  did "$record" "ok:$head" || { say "$ticket: #$pr is reviewed and green at ${head:0:8}: the request for the agreement is the lead's"; mark "$record" "ok:$head"; }
done

# 2. The tickets the user said « go » on, oldest first, within the limit.
todo=$(conf_get linear todo_state)
[ -n "$todo" ] || exit 0
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
  say "$ticket: put in « $todo » by the user: its lane is opened"
  [ -z "$dry" ] || continue
  code=0
  "$ORCH_HOME/spawn-lane.sh" dev "$ticket" > /dev/null 2> "$work/spawn.err" || code=$?
  case "$code" in
    0) ;;
    3) say "$ticket: no place now (the limit of lanes): it waits"; break ;;
    *) say "$ticket: its lane could not be opened: $(sed -n '$p' "$work/spawn.err")" ;;
  esac
done < <(jq -r 'sort_by(.updatedAt) | .[] | [.identifier, .updatedAt] | @tsv' "$work/todo.json")
