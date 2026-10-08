#!/usr/bin/env bash
# Puts a pull request live: the one way a merge is done without a person at
# the keyboard. It checks, and judges nothing. Every condition is read from
# GitHub, git, the ledger, Linear and the host, and all of them must hold:
#   1. the pull request is open, not a draft, and its checks are all green;
#   2. its branch holds the base, or lacks only what is not code;
#   3. the version that goes live was reviewed by a model other than its
#      author, for this ticket, and the reviewer concluded what [merge]
#      verdict says: the reviewed commit is the head, or the head only adds
#      merges of the base that changed nothing by themselves;
#   4. the user agreed: he put the ticket in his status of agreement himself
#      (linear.sh moved-by-owner), or wrote « Fusion : <ticket> » before the
#      statuses existed. Invisible tooling ([merge] tooling_paths) needs
#      neither; what touches the checks of the CI or the deployment
#      ([merge] guarded_paths) always needs his own agreement;
#   5. the host is free for a merge: no CI, no deployment settling, no screen
#      test, GitHub up.
# Then it merges the very commit it checked, and, when the ticket was in the
# status of agreement, says where to see the result and puts it in Done.
#
#   merge-pr.sh <pull request> <ticket> [<announcement file|->] [--dry-run]
#
# The announcement (product language: what changes, where to see it, how to
# check in a minute) is asked for whenever the user's agreement was needed.
# Exit: 0 merged (or, with --dry-run, would be); 5 not now, it may hold
# later with nobody doing anything (the host is busy, a check still runs);
# 6 no: something must change first, and the script says what.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

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
# still running or for Linear's history is kept in a queue the wake tries
# again by itself, with no model, with these same checks each time.
later() {
  if [ -n "$dry_run" ]; then echo "Elle attendrait dans la file : $1"; exit 0; fi
  if [ -n "${ORCH_FROM_QUEUE:-}" ]; then echo "$(basename "$0"): #$pr is not put live now: $1" >&2; exit 5; fi
  mkdir -p "$ORCH_STATE_DIR/merge-queue"
  [ -z "$announcement" ] || cp "$announcement" "$ORCH_STATE_DIR/merge-queue/$pr.announcement.md"
  jq -n --arg pr "$pr" --arg ticket "$ticket" --arg at "$(now_utc)" --arg why "$1" --arg said "$([ -z "$announcement" ] || echo "$ORCH_STATE_DIR/merge-queue/$pr.announcement.md")" \
    '{pr: ($pr | tonumber), ticket: $ticket, at: $at, why: $why, announcement: $said}' > "$ORCH_STATE_DIR/merge-queue/.$pr.part"
  mv "$ORCH_STATE_DIR/merge-queue/.$pr.part" "$ORCH_STATE_DIR/merge-queue/$pr.json"
  echo "Mise en ligne de la PR #$pr mise en file ($1). Elle partira d'elle-même dès que possible, avec les mêmes contrôles ; rien à relancer."
  exit 0
}
node_lib() { node --no-warnings "$ORCH_HOME/lib/$1" "${@:2}"; }

down=$(github_down) || down=
[ -z "$down" ] || later "GitHub is down ($down)"

# 1. Open, not a draft, green.
pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json number,state,isDraft,headRefName,headRefOid,baseRefName,statusCheckRollup,files) || die "pull request #$pr could not be read"
[ "$(jq -r '.state' <<<"$pull")" = OPEN ] || no "it is not open"
[ "$(jq -r '.isDraft' <<<"$pull")" = false ] || no "it is a draft"
head=$(jq -r '.headRefOid' <<<"$pull") branch=$(jq -r '.headRefName' <<<"$pull")
base=$(conf_get lanes base)
[ "$(jq -r '.baseRefName' <<<"$pull")" = "${base#origin/}" ] || no "it does not go to ${base#origin/}"
checks=$(jq -c '[.statusCheckRollup[] | (.conclusion // .status // "") | ascii_upcase]' <<<"$pull")
[ "$(jq 'map(select(. == "IN_PROGRESS" or . == "QUEUED" or . == "PENDING" or . == "WAITING" or . == "")) | length' <<<"$checks")" = 0 ] || later "its checks still run"
[ "$(jq 'map(select(. != "SUCCESS" and . != "SKIPPED" and . != "NEUTRAL")) | length' <<<"$checks")" = 0 ] || no "a check is not green"
[ "$(jq 'map(select(. == "SUCCESS")) | length' <<<"$checks")" != 0 ] || no "no check ran on it"
jq -c '[.files[].path]' <<<"$pull" > "$work/files.json"

# 2. The base is in it, or what it lacks is not code.
git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" "$branch" || die "the branches could not be fetched"
[ "$(git -C "$ORCH_REPO" rev-parse "origin/$branch")" = "$head" ] || later "its branch moved while it was read"
if ! git -C "$ORCH_REPO" merge-base --is-ancestor "$base" "$head"; then
  git -C "$ORCH_REPO" diff --name-only "$head...$base" | jq -R . | jq -sc . > "$work/lag.json"
  node_lib merge.mjs lag "$work/lag.json" || no "its branch lacks code that is on ${base#origin/}: the lane brings ${base#origin/} in first"
fi

# 3. Reviewed, for this ticket, with the verdict asked for, at this version.
reviewed=
while IFS=$'\t' read -r run_id commit; do
  [ -n "$commit" ] || continue
  node_lib merge.mjs verdict "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null || continue
  if [ "$commit" = "$head" ]; then reviewed=$commit; break; fi
  # A later commit of the lane itself would not have been read: only merges
  # of the base that changed nothing by themselves may sit on top.
  git -C "$ORCH_REPO" merge-base --is-ancestor "$commit" "$head" 2> /dev/null || continue
  clean=1
  while IFS= read -r added; do
    read -r -a parents < <(git -C "$ORCH_REPO" rev-list --parents -n 1 "$added" | cut -d' ' -f2-)
    [ "${#parents[@]}" = 2 ] || { clean=; break; }
    auto=$(git -C "$ORCH_REPO" merge-tree --write-tree "${parents[0]}" "${parents[1]}" 2> /dev/null) || { clean=; break; }
    [ "$auto" = "$(git -C "$ORCH_REPO" rev-parse "$added^{tree}")" ] || { clean=; break; }
  done < <(git -C "$ORCH_REPO" rev-list "$commit..$head" --not "$base")
  [ -z "$clean" ] || { reviewed=$commit; break; }
done < <(ledger sql "select run_id from runs where role = 'review' and source = 'dispatcher' and outcome = 'done' and pr_number = $pr and ticket = '$ticket' order by started_at desc" \
  | jq -r '.[].run_id' | while IFS= read -r run_id; do printf '%s\t%s\n' "$run_id" "$(sed -n 's/^commit: //p' "$ORCH_STATE_DIR/reports/$run_id.md" 2> /dev/null | sed -n '1p')"; done)
[ -n "$reviewed" ] || no "this version (${head:0:8}) has no review for $ticket that concludes « $(conf_get merge verdict) »: have it reviewed (review-pr.sh $pr $ticket)"

# 4. The agreement of the user.
needs=$(node_lib merge.mjs needs "$work/files.json")
go=$(conf_get linear go_state) agreed=
if [ "$needs" != tooling ]; then
  code=0
  "$ORCH_HOME/linear.sh" moved-by-owner "$ticket" "$go" || code=$?
  case "$code" in
    0) agreed=status ;;
    7) later "Linear has not written yet who put $ticket in « $go »" ;;
    6)
      # In his status, but not put there by him: never live, and back to the status that asks him.
      [ -n "$dry_run" ] || "$ORCH_HOME/linear.sh" move "$ticket" "$(conf_get linear validate_state)" > /dev/null || true
      ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "#$pr: $ticket was put in « $go » by an integration or another account, not by the user: back to « $(conf_get linear validate_state) »"
      no "$ticket is in « $go » but the user did not put it there himself: put back in « $(conf_get linear validate_state) »"
      ;;
    5)
      # Not in his status: a line he wrote before the statuses existed still counts.
      { "$ORCH_HOME/linear.sh" comments "$ticket"; "$ORCH_HOME/linear.sh" comments "$(conf_get lead report_on)"; } | jq -sc 'add' > "$work/comments.json"
      cat "$ORCH_STATE_DIR/linear-comments.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
      if [ "$needs" = guarded ]; then node_lib merge.mjs line "$work/comments.json" "$work/agent-ids.txt" "$ticket" "$pr" && agreed=line
      else node_lib merge.mjs line "$work/comments.json" "$work/agent-ids.txt" "$ticket" && agreed=line; fi
      ;;
    *) die "Linear could not say who moved $ticket" ;;
  esac
  [ -n "$agreed" ] || no "the user has not agreed: $ticket is not in « $go »$([ "$needs" != guarded ] || echo ' (it touches the checks of the CI or the deployment: his own agreement is needed, tooling or not)'). Ask him (ask-validation.sh $ticket)"
  [ -n "$announcement" ] || no "an announcement is needed for what the user agreed to: what changes, where to see it, how to check"
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
echo "merged: #$pr ($ticket) at ${head:0:8}"

# What the user agreed to is told to him where he agreed, and closed. A
# comment the hourly limit holds back leaves with the grouped ones.
if [ -n "$announcement" ]; then
  code=0
  "$ORCH_HOME/linear.sh" comment "$ticket" "$announcement" "${ORCH_SIGNED:-$(conf_get lead name)}" > /dev/null || code=$?
  if [ "$code" != 0 ]; then
    mkdir -p "$ORCH_STATE_DIR/linear-outbox"
    cp "$announcement" "$ORCH_STATE_DIR/linear-outbox/.$pr.part" && mv "$ORCH_STATE_DIR/linear-outbox/.$pr.part" "$ORCH_STATE_DIR/linear-outbox/$ticket--mise-en-ligne-$pr.md"
  fi
fi
[ "$agreed" != status ] || "$ORCH_HOME/linear.sh" move "$ticket" "$(conf_get linear done_state)" > /dev/null \
  || echo "$(basename "$0"): #$pr is live, but $ticket could not be put in « $(conf_get linear done_state) »" >&2
