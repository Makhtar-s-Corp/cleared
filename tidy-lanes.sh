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
# lets out: otherwise the lane is left as it is, with nothing committed). The
# branch stays on the remote; only the terminals and the worktree go. A
# branch the remote no longer has, its pull request merged or closed, is not
# put back there: what it still holds is kept as a bundle with the archives.
# A lane with a session running in the ledger, or opened less than
# idle_hours ago, is at work.
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
team=$("$ORCH_HOME/tracker.sh" ticket-prefix)
idle_hours=$(conf_get lanes idle_hours)
[[ "$idle_hours" =~ ^[0-9]+$ ]] || idle_hours=24
in_list() { tr ',' '\n' <<<"$2" | sed 's/^ *//; s/ *$//' | grep -qxF -- "$1"; }
busy=$(conf_get lanes busy_states)
waiting_states="$(conf_get tracker validate_state), $(conf_get tracker go_state)"
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
  # A lane with a session running in the ledger is at work, whatever its
  # tickets say: a review is not cut in the middle.
  if [ "$(ledger sql "select count(*) n from runs where lane = '$branch' and outcome = 'running'" | jq -r '.[0].n')" != 0 ]; then
    kept "$lane" "a session is running in it"
    continue
  fi
  # Its tickets: the ones its branch and the titles of its pull requests
  # name, and the first one each description names (a description also
  # cites the tickets of others).
  tickets=$({ echo "$branch"; jq -r '.[] | .title' <<<"$pulls"; jq -r '.[] | .body' <<<"$pulls" | while IFS= read -r line; do grep -oE "\\b$team-[0-9]+" <<<"$line" | sed -n '1p'; done | sed -n '1p'; } | grep -oE "\\b$team-[0-9]+" | sort -u || true)
  blocked= open_ticket= name= waiting=
  for ticket in $tickets; do
    state=$("$ORCH_HOME/tracker.sh" state "$ticket" 2> /dev/null) || state=
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
    # Its last sign of life: its last commit, the last file touched in it,
    # or its opening (a lane opened a moment ago on an old base has no
    # commit of its own yet).
    last=$(git -C "$path" log -1 --format=%ct 2> /dev/null || echo 0)
    opened=$(stat -c %Y "$(git -C "$path" rev-parse --absolute-git-dir 2> /dev/null)/gitdir" 2> /dev/null || echo 0)
    [ "$opened" -le "$last" ] || last=$opened
    touched=$(cd "$path" && git ls-files -z --modified --others --exclude-standard | xargs -0 -r stat -c %Y 2> /dev/null | sort -n | tail -1)
    [ -z "$touched" ] || [ "$touched" -le "$last" ] || last=$touched
    [ "$last" -gt "$(date -d "$idle_hours hours ago" +%s)" ] || why=$(conf_get lanes tidy_reason_idle)
  fi
  [ -n "$why" ] || { kept "$lane" "at work, or attached to an open ticket"; continue; }
  # Its name for the user: the title of its ticket, the one that waits for
  # him first, then one still open, then any.
  named=${waiting:-${open_ticket:-$(sed -n '1p' <<<"$tickets")}}
  [ -z "$named" ] || name=$("$ORCH_HOME/tracker.sh" issue "$named" 2> /dev/null | jq -r '.title // empty') || name=
  [ -n "$name" ] || name=$lane

  if [ -n "$dry" ]; then
    jq -nc --arg lane "$lane" --arg name "$name" --arg why "$why" '{lane: $lane, name: $name, why: $why}' >> "$out/closed.jsonl"
    continue
  fi

  if [ "$(conf_get memory enabled)" = true ] && [ -e "$path/HANDOVER.md" ]; then
    if [[ ! "$tickets" =~ ^[A-Z]+-[0-9]+$ ]]; then
      kept "$lane" "HANDOVER.md is present but its ticket cannot be identified: left for recovery"
      continue
    fi
    if ! node "$ORCH_HOME/lib/memory/cli.mjs" recover "$path" "${branch%%/*}" "$tickets" "$branch"; then
      kept "$lane" "HANDOVER.md could not be recovered: worktree kept"
      continue
    fi
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
  # 2: unsaved work becomes a commit, if the guard lets it out: what it
  # refuses is not committed, and the lane is left as it is. A file the guard
  # cannot read (not text) is nobody's to send: the lane is left too.
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    if (cd "$path" && { git diff --numstat HEAD; git ls-files -z --others --exclude-standard | xargs -0 -r git diff --no-index --numstat /dev/null 2> /dev/null || true; }) | grep -q '^-'; then
      kept "$lane" "it holds unsaved work that is not text, which the guard cannot read: to be looked at"
      continue
    fi
    { git -C "$path" diff --unified=0 HEAD | grep -E '^\+[^+]' | cut -c2-; (cd "$path" && git ls-files -z --others --exclude-standard | xargs -0 -r cat --); } > "$out/unsaved.txt" 2> /dev/null || true
    if [ -s "$out/unsaved.txt" ] && ! guard_text "$out/unsaved.txt" 2> /dev/null; then
      kept "$lane" "the guard does not let its unsaved work out: left as it is, to be looked at"
      continue
    fi
    git -C "$path" add -A
    git -C "$path" -c user.name="${ORCH_GIT_NAME:-tidy-lanes}" -c user.email="${ORCH_GIT_EMAIL:-tidy-lanes@localhost}" commit -q -m "wip: saved before the lane was closed" || { kept "$lane" "its unsaved work could not be committed"; continue; }
  fi
  # 3: what no remote holds goes to its own branch, if the guard lets it
  # out. A branch whose pull request is merged or closed and that the remote
  # no longer has is not put back there: what it still holds is kept as a
  # bundle beside the archives.
  if [ "$(git -C "$path" rev-list --count HEAD --not --remotes)" != 0 ]; then
    if { [ "$(conf_get memory enabled)" = true ] || [ "$(git -C "$path" config --get cleared.memory.everEnabled || true)" = true ]; } \
      && git -C "$path" log --full-history --format= --name-only HEAD --not --remotes -- HANDOVER.md | grep -qxF HANDOVER.md; then
      kept "$lane" "HANDOVER.md is present in an unpushed commit: remove it from branch history before tidying"
      continue
    fi
    if [ "$why" = "$(conf_get lanes tidy_reason_live)" ] && ! git -C "$ORCH_REPO" ls-remote --exit-code --heads origin "$branch" > /dev/null 2>&1; then
      mkdir -p "$archive"
      git -C "$path" bundle create "$archive/unpushed.bundle" "$branch" --not --remotes > /dev/null 2>&1 || { kept "$lane" "what its branch still holds could not be kept"; continue; }
    else
      git -C "$path" log --format='%s%n%b' HEAD --not --remotes > "$out/messages.txt"
      git -C "$path" log -p --format= --unified=0 HEAD --not --remotes | grep -E '^\+[^+]' | cut -c2- > "$out/changes.txt" || true
      if ! guard_text "$out/messages.txt" 2> /dev/null || { [ -s "$out/changes.txt" ] && ! guard_text "$out/changes.txt" 2> /dev/null; }; then
        kept "$lane" "the guard does not let its unpushed work out: left as it is, to be looked at"
        continue
      fi
      git -C "$path" push --quiet origin "HEAD:refs/heads/$branch" 2> /dev/null || { kept "$lane" "its branch could not be pushed"; continue; }
      [ "$(git -C "$path" rev-list --count HEAD --not --remotes)" = 0 ] || { kept "$lane" "the push did not take everything"; continue; }
    fi
  fi
  # 4: its terminals, its worktree.
  terminal close-worktree "$path"
  terminal remove-worktree "$path" 2> /dev/null || true
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
