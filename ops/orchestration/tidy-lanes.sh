#!/usr/bin/env bash
# Tidies the lanes, by rule and with no model: once a day from the wake, or
# by hand. A lane is a worktree under [lanes] root, on a branch of its own.
# It is closed when one of these holds (rule of the user, 2026-10-08):
#   - the pull request of its branch is merged or closed, and none is open;
#   - nothing happened in it for [lanes] idle_hours and no open ticket is
#     attached to it;
#   - it is a trial: its branch starts with one of [lanes] trial_prefixes;
#   - it only waits for his agreement: a ticket attached to it is in the
#     status that asks him, or in the one of his agreement. Its branch is on
#     the remote, and a lane is opened again only if a review asks for a
#     correction.
# Never when a ticket attached to it is at work ([lanes] busy_states). The
# tickets of a lane are the ones its branch and its pull requests name.
# Nothing is lost: what exists only in the worktree is archived, unsaved
# work is committed as « wip », what the remote lacks is pushed to the
# lane's own branch (never forced, never the base, and only what the guard
# lets out: otherwise the lane is left as it is). The branch stays on the
# remote; only the terminals and the worktree go.
#
#   tidy-lanes.sh [--dry-run]
#       prints {closed: [{lane, name, why}], kept: [{lane, why}], left, sessions}
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

dry=
[ "${1:-}" != --dry-run ] || dry=1
[ $# -le 1 ] && { [ $# = 0 ] || [ -n "$dry" ]; } || die "usage: tidy-lanes.sh [--dry-run]"
root=$(realpath -m "$(expand_home "$(conf_get lanes root)")")
base=$(conf_get lanes base)
team=$(conf_get linear team)
idle_hours=$(conf_get lanes idle_hours)
[[ "$idle_hours" =~ ^[0-9]+$ ]] || idle_hours=24
in_list() { tr ',' '\n' <<<"$2" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$1"; }
busy=$(conf_get lanes busy_states)
waiting_states="$(conf_get linear validate_state), $(conf_get linear go_state)"
closed_states=$(conf_get lanes closed_states)
lead_lane="$(conf_get lead role)/lead"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
: > "$out/closed.jsonl"
: > "$out/kept.jsonl"
kept() { jq -nc --arg lane "$1" --arg why "$2" '{lane: $lane, why: $why}' >> "$out/kept.jsonl"; }
ledger init > /dev/null

while IFS=$'\t' read -r path branch; do
  [ -n "$branch" ] || continue
  case "$path" in "$root"/*) ;; *) continue ;; esac
  lane=$(basename "$path")
  [ "$branch" != "$lead_lane" ] && [ "$branch" != "${base#origin/}" ] || continue
  if tr ' ,' '\n\n' <<<"$(conf_get lead not_lanes)" | grep -qxF -- "$lane"; then continue; fi

  # Its pull requests, and the tickets it names.
  pulls=$(cd "$ORCH_REPO" && gh pr list --head "$branch" --state all --limit 20 --json number,state,title,body 2> /dev/null) || { kept "$lane" "its pull requests could not be read"; continue; }
  tickets=$({ echo "$branch"; jq -r '.[] | .title, .body' <<<"$pulls"; } | grep -oE "\\b$team-[0-9]+" | sort -u || true)
  blocked= open_ticket= name= waiting=
  for ticket in $tickets; do
    state=$("$ORCH_HOME/linear.sh" state "$ticket" 2> /dev/null) || state=
    # A ticket whose state cannot be read counts as open and at work: no guess.
    [ -n "$state" ] || { blocked="$ticket (state unknown)"; break; }
    if in_list "$state" "$busy"; then blocked="$ticket ($state)"; break; fi
    in_list "$state" "$closed_states" || open_ticket=$ticket
    ! in_list "$state" "$waiting_states" || waiting=$ticket
  done
  [ -z "$blocked" ] || { kept "$lane" "a ticket attached to it is at work: $blocked"; continue; }

  # Which rule closes it, if any.
  why=
  if [ "$(jq '[.[] | select(.state == "OPEN")] | length' <<<"$pulls")" = 0 ] && [ "$(jq '[.[] | select(.state == "MERGED" or .state == "CLOSED")] | length' <<<"$pulls")" != 0 ]; then
    why=$(conf_get lanes tidy_reason_live)
  fi
  if [ -z "$why" ]; then
    while IFS= read -r prefix; do
      [ -n "$prefix" ] || continue
      case "$branch" in "$prefix"*) why=$(conf_get lanes tidy_reason_trial) ;; esac
    done < <(conf_get lanes trial_prefixes | tr ',' '\n' | sed 's/^ *//; s/ *$//')
  fi
  [ -n "$why" ] || [ -z "$waiting" ] || why=$(conf_get lanes tidy_reason_waiting)
  if [ -z "$why" ] && [ -z "$open_ticket" ]; then
    # Its last sign of life: its last commit, or the last file touched in it.
    last=$(git -C "$path" log -1 --format=%ct 2> /dev/null || echo 0)
    touched=$(cd "$path" && git ls-files -z --modified --others --exclude-standard | xargs -0 -r stat -c %Y 2> /dev/null | sort -n | tail -1)
    [ -z "$touched" ] || [ "$touched" -le "$last" ] || last=$touched
    [ "$last" -gt "$(date -d "$idle_hours hours ago" +%s)" ] || why=$(conf_get lanes tidy_reason_idle)
  fi
  [ -n "$why" ] || { kept "$lane" "at work, or attached to an open ticket"; continue; }
  # Its name for the user: the title of its ticket, the one that waits for
  # him first, then one still open, then any.
  named=${waiting:-${open_ticket:-$(sed -n '1p' <<<"$tickets")}}
  [ -z "$named" ] || name=$("$ORCH_HOME/linear.sh" issue "$named" 2> /dev/null | jq -r '.title // empty') || name=
  [ -n "$name" ] || name=$lane

  if [ -n "$dry" ]; then
    jq -nc --arg lane "$lane" --arg name "$name" --arg why "$why" '{lane: $lane, name: $name, why: $why}' >> "$out/closed.jsonl"
    continue
  fi

  # Nothing lost. 1: what exists only here, build outputs and dependencies aside.
  archive="$ORCH_REPO/$(conf_get lanes archives)/$lane/menage-$(date +%F)"
  git -C "$path" -c core.quotePath=false ls-files -z --others --ignored --exclude-standard \
    | grep -z -v -E '(^|/)(node_modules|dist|dist-site|coverage|playwright-report|test-results)(/|$)' > "$out/only-here" || true
  count=$(tr -cd '\0' < "$out/only-here" | wc -c)
  if [ "$count" != 0 ]; then
    mkdir -p "$archive"
    (cd "$path" && cpio -0 -pdm --quiet "$archive" < "$out/only-here") 2> /dev/null || true
    [ "$(find "$archive" -type f | wc -l)" -ge "$count" ] || { kept "$lane" "what exists only in it could not be archived"; continue; }
  fi
  # 2: unsaved work becomes a commit.
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    git -C "$path" add -A
    git -C "$path" -c user.name="${ORCH_GIT_NAME:-tidy-lanes}" -c user.email="${ORCH_GIT_EMAIL:-tidy-lanes@localhost}" commit -q -m "wip: saved before the lane was closed" || { kept "$lane" "its unsaved work could not be committed"; continue; }
  fi
  # 3: what no remote holds goes to its own branch, if the guard lets it out.
  if [ "$(git -C "$path" rev-list --count HEAD --not --remotes)" != 0 ]; then
    git -C "$path" log --format='%s%n%b' HEAD --not --remotes > "$out/messages.txt"
    git -C "$path" log -p --format= --unified=0 HEAD --not --remotes | grep -E '^\+[^+]' | cut -c2- > "$out/changes.txt" || true
    if ! guard_text "$out/messages.txt" 2> /dev/null || { [ -s "$out/changes.txt" ] && ! guard_text "$out/changes.txt" 2> /dev/null; }; then
      kept "$lane" "the guard does not let its unpushed work out: left as it is, to be looked at"
      continue
    fi
    git -C "$path" push --quiet origin "HEAD:refs/heads/$branch" 2> /dev/null || { kept "$lane" "its branch could not be pushed"; continue; }
    [ "$(git -C "$path" rev-list --count HEAD --not --remotes)" = 0 ] || { kept "$lane" "the push did not take everything"; continue; }
  fi
  # 4: its terminals, the sessions the ledger still holds running, its worktree.
  ledger sql "select run_id from runs where lane = '$branch' and outcome = 'running'" | jq -r '.[].run_id' | while IFS= read -r run_id; do ledger run-end --run-id "$run_id" --outcome killed; done
  orca terminal close --worktree "path:$path" --all > /dev/null 2>&1 || true
  orca worktree rm --worktree "path:$path" --force > /dev/null 2>&1 || git -C "$ORCH_REPO" worktree remove --force "$path" 2> /dev/null || true
  [ ! -d "$path" ] || { kept "$lane" "its worktree could not be removed"; continue; }
  jq -nc --arg lane "$lane" --arg name "$name" --arg why "$why" '{lane: $lane, name: $name, why: $why}' >> "$out/closed.jsonl"
done < <(git -C "$ORCH_REPO" worktree list --porcelain | awk '/^worktree /{path = substr($0, 10)} /^branch /{print path "\t" substr($2, 12)}')
git -C "$ORCH_REPO" worktree prune 2> /dev/null || true

# The sessions of the models still alive on the host, whatever they work on.
sessions=0
while IFS= read -r adapter; do
  process=$(conf_get "$adapter" process)
  [ -z "$process" ] || sessions=$((sessions + $(pgrep -cx -- "$process" || true)))
done < <(grep -oE '^\[adapter\.[^]]+\]' "$ORCH_CONF" | tr -d '[]')
left=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | grep -c "^$root/" || true)
[ -z "$dry" ] || left=$((left - $(wc -l < "$out/closed.jsonl")))
result=$(jq -n --slurpfile closed "$out/closed.jsonl" --slurpfile kept "$out/kept.jsonl" --argjson sessions "$sessions" --argjson left "$left" '{closed: $closed, kept: $kept, left: $left, sessions: $sessions}')
if [ -z "$dry" ] && [ "$(jq '.closed | length' <<<"$result")" != 0 ]; then
  ledger event --kind lanes_tidied --value "$(jq '.closed | length' <<<"$result")" --detail "$(jq -r '[.closed[] | "\(.lane): \(.why)"] | join("; ")' <<<"$result" | cut -c1-900)"
  { jq -r '.closed[] | "« \(.name) » : \(.why)"' <<<"$result"; printf "$(conf_get lanes tidy_summary)\n" "$(jq '.left' <<<"$result")" "$sessions"; } \
    | ORCH_SIGNED="${ORCH_SIGNED:-tidy-lanes}" "$ORCH_HOME/digest-note.sh" - || true
fi
printf '%s\n' "$result"
