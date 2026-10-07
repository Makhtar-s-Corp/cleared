#!/usr/bin/env bash
# Opens a lane for one role on one ticket: a git worktree on the branch
# <role>/<ticket> (Orca shows it as a lane of that name) and a terminal in it
# that runs the model picked by agents.conf.
#
#   spawn-lane.sh <role> <ticket> [--model <alias>] [--prompt-file <file>]
#                 [--comment-on <ticket>|none] [--pr <number>] [--author-model <alias>]
#                 [--since <commit>] [--from <ref>]
#                 [--path <touched path>]... [--pr-lines <n>] [--wait] [--dry-run]
#
# With --pr, the lane starts from the head of that pull request, and its size
# and touched paths take part in the choice of the model. --since narrows the
# work to what changed after a commit (a review of what was not read yet);
# --from starts the lane from that ref instead (a local branch not pushed yet).
#
# This script knows the contract of the adapters and nothing else: no model
# and no provider is named here.
#
# Exit codes: 0 spawned, 3 lane limit reached, 1 anything else (among which:
# no model of the chain is available).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
[ $# -ge 2 ] || usage
role=$1 ticket=$2
shift 2
forced= prompt_file= comment_on=$ticket author= pr= pr_lines= since= from= wait_for_exit= dry_run=
paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model) forced=$2; shift 2 ;;
    --prompt-file) prompt_file=$2; shift 2 ;;
    --comment-on) comment_on=$2; shift 2 ;;
    --author-model) author=$2; shift 2 ;;
    --pr) pr=$2; shift 2 ;;
    --since) since=$2; shift 2 ;;
    --from) from=$2; shift 2 ;;
    --path) paths+=(--path "$2"); shift 2 ;;
    --pr-lines) pr_lines=$2; shift 2 ;;
    --wait) wait_for_exit=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    *) usage ;;
  esac
done
[[ "$ticket" =~ ^[A-Z]+-[0-9]+$ ]] || die "\"$ticket\" is not a ticket identifier"
[ -n "$(conf_get roles "$role")" ] || die "unknown role \"$role\" (roles of agents.conf: $(conf_keys roles | paste -sd' '))"

lane="$role/$ticket"
ledger init > /dev/null

# 1. The ticket decides the model: project and label from Linear.
issue=$("$ORCH_HOME/linear.sh" issue "$ticket")
route_args=(--role "$role" --project "$(jq -r '.project // ""' <<<"$issue")")
while IFS= read -r label; do [ -n "$label" ] && route_args+=(--label "$label"); done < <(jq -r '.labels[]' <<<"$issue")
# A pull request brings its head, its size and its paths. Read by gh, here.
pr_head=
if [ -n "$pr" ]; then
  [[ "$pr" =~ ^[0-9]+$ ]] || die "\"$pr\" is not a pull request number"
  pull=$(cd "$ORCH_REPO" && gh pr view "$pr" --json headRefName,additions,deletions,files) || die "pull request #$pr could not be read"
  pr_head=$(jq -r '.headRefName' <<<"$pull")
  pr_lines=${pr_lines:-$(jq -r '.additions + .deletions' <<<"$pull")}
  while IFS= read -r touched; do [ -n "$touched" ] && paths+=(--path "$touched"); done < <(jq -r '.files[].path' <<<"$pull")
  # Who wrote it, when nobody says: the last finished run of the author role
  # on this ticket, from the ledger.
  author_role=$(conf_get review author_role)
  if [ -z "$author" ] && [[ "$author_role" =~ ^[a-z-]+$ ]]; then
    author=$(ledger sql "select model from runs where ticket = '$ticket' and role = '$author_role' and outcome = 'done' and source = 'dispatcher' order by started_at desc limit 1" | jq -r '.[0].model // empty')
  fi
fi
[ -n "$forced" ] && route_args+=(--model "$forced")
[ -n "$author" ] && route_args+=(--author-model "$author")
[ -n "$pr_lines" ] && route_args+=(--pr-lines "$pr_lines")
routed=$(node "$ORCH_HOME/lib/route.mjs" "${route_args[@]}" "${paths[@]}")
requested=$(jq -r '.chain[0].alias' <<<"$routed")
rule=$(jq -r '.rule' <<<"$routed")
route_notes=$(jq -r '.notes | join(" ")' <<<"$routed")

# 2. Availability, asked to each adapter. An unavailable model is replaced by
# its declared fallback, loudly; a chain with no available model is an error.
available=$(mktemp)
available_chain "$(jq -c '.chain' <<<"$routed")" > "$available"
spawn_note=
if [ "$(jq length "$available")" = 0 ]; then
  [ -n "$dry_run" ] || ledger event --kind model_fallback_failed --ticket "$ticket" --detail "$lane: no model of the chain is available ($(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed"))"
  die "no model of the chain is available for $lane: $(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed")"
fi
chosen=$(jq -r '.[0].alias' "$available")
if [ "$chosen" != "$requested" ]; then
  spawn_note="$requested indisponible au lancement. Repli déclaré pris : $chosen."
  [ -n "$dry_run" ] || ledger event --kind model_fallback --ticket "$ticket" --detail "$lane: $requested unavailable at spawn, fallback $chosen"
  echo "$(basename "$0"): fallback, $requested -> $chosen" >&2
fi

if [ -n "$dry_run" ]; then
  jq -n --arg lane "$lane" --arg rule "$rule" --arg requested "$requested" --slurpfile chain "$available" --argjson notes "$(jq -c '.notes' <<<"$routed")" --arg author "$author" --arg lines "$pr_lines" \
    '{lane: $lane, rule: $rule, requested: $requested, would_run: $chain[0][0], fallbacks: $chain[0][1:], notes: $notes, author: $author, pr_lines: $lines}'
  rm -f "$available"
  exit 0
fi

prompt_file=${prompt_file:-$ORCH_HOME/prompts/$role.md}
[ -f "$prompt_file" ] || die "no prompt for the role \"$role\": $prompt_file"

# 3. The limit on lanes running at once is applied here, not left to a rule.
# One spawn at a time counts and creates: two at once would both fit under
# the limit. The lock is dropped as soon as the worktree exists.
mkdir -p "$ORCH_STATE_DIR"
exec 9> "$ORCH_STATE_DIR/spawn.lock"
flock -w 120 9 || die "another spawn holds the lock"
max=$(conf_get limits max_lanes)
lanes=$(dispatcher_lanes)
open=$(counted_lanes | grep -c . || true)
if grep -qxF -- "$lane" <<<"$lanes"; then die "the lane $lane is already open"; fi
if [ "$open" -ge "$max" ]; then
  ledger event --kind lane_limit_reached --ticket "$ticket" --detail "$lane refused: $open lanes open for a limit of $max" --value "$open"
  echo "$(basename "$0"): lane limit reached ($open open, limit $max): $lane not opened" >&2
  exit 3
fi

# 4. The worktree. Orca lists any git worktree of the repository by itself.
root=$(expand_home "$(conf_get lanes root)")
base=$(conf_get lanes base)
[ -n "$pr_head" ] && base="origin/$pr_head"
worktree="$root/$role-$ticket"
[ -e "$worktree" ] && die "$worktree already exists"
if [ -n "$from" ]; then
  base=$from
else
  git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" || echo "$(basename "$0"): fetch failed, using the local $base" >&2
fi
git -C "$ORCH_REPO" rev-parse --verify --quiet "$base^{commit}" > /dev/null || die "no such ref to start from: $base"
if [ -n "$since" ]; then
  since=$(git -C "$ORCH_REPO" rev-parse --verify --quiet "$since^{commit}") || die "no such commit: --since"
  git -C "$ORCH_REPO" merge-base --is-ancestor "$since" "$base" || die "--since is not an ancestor of $base"
fi
git -C "$ORCH_REPO" worktree add --quiet -b "$lane" "$worktree" "$base"
# The lane exists and counts from now on: the next spawn may go.
exec 9>&-

# 5. What the terminal of the lane will run.
run_base="$ticket-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$ORCH_STATE_DIR/runs/$run_base"
mkdir -p "$run_dir"
mv "$available" "$run_dir/chain.json"
{
  cat "$prompt_file"
  printf '\n---\nTicket %s : %s\n%s\nLane : %s (branche du même nom).\n' "$ticket" "$(jq -r '.title' <<<"$issue")" "$(jq -r '.url' <<<"$issue")" "$lane"
  [ -z "$pr" ] || printf 'PR #%s, branche %s, comparée à %s.\n' "$pr" "$pr_head" "$(conf_get lanes base)"
  [ -z "$since" ] || printf 'Périmètre limité : seulement ce qui a changé depuis le commit %s, déjà traité (`git diff %s..HEAD`, `git log %s..HEAD`). Le reste sert de contexte.\n' "$since" "$since" "$since"
} > "$run_dir/prompt.md"
writeup_role=$(conf_get linear writeup_role)
if [ -n "$writeup_role" ] && [ "$comment_on" != none ] && grep -qw -- "$role" <<<"$(conf_get linear writeup_for)"; then
  written=$(node "$ORCH_HOME/lib/route.mjs" --role "$writeup_role")
  available_chain "$(jq -c '.chain' <<<"$written")" > "$run_dir/writeup-chain.json"
  [ "$(jq length "$run_dir/writeup-chain.json")" = 0 ] && rm -f "$run_dir/writeup-chain.json"
fi
{
  printf 'ORCH_LANE=%q\nORCH_TICKET=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "$ticket" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_RULE_NOTE=%q\nORCH_SPAWN_NOTE=%q\n' "$requested" "règle : $rule${route_notes:+ ; $route_notes}" "$spawn_note"
  printf 'ORCH_COMMENT_ON=%q\nORCH_WRITEUP_ROLE=%q\n' "$comment_on" "$writeup_role"
  printf 'ORCH_PR=%q\nORCH_PR_LINES=%q\n' "$pr" "$pr_lines"
  printf 'ORCH_PROJECT=%q\nORCH_LABEL=%q\n' "$(jq -r '.project // ""' <<<"$issue")" "$(jq -r '.labels[0] // ""' <<<"$issue")"
} > "$run_dir/lane.env"

# 6. The terminal, visible in Orca under the lane.
handle=$(open_terminal "$worktree" "$lane · $chosen" "$ORCH_HOME/lane-run.sh $run_dir" "$ticket") \
  || die "the worktree $worktree exists but Orca did not open a terminal in it; run by hand: (cd $worktree && $ORCH_HOME/lane-run.sh $run_dir)"
# Orca knows the worktree by now: link it to its ticket.
orca worktree set --worktree "path:$worktree" --linear-issue "$ticket" --comment "$role · $chosen · ouverte par le dispatcher" > /dev/null 2>&1 || true
echo "$handle" > "$run_dir/terminal.handle"

jq -n --arg lane "$lane" --arg worktree "$worktree" --arg requested "$requested" --arg chosen "$chosen" --arg rule "$rule" --arg run "$run_dir" --arg terminal "$handle" \
  '{lane: $lane, worktree: $worktree, requested: $requested, model: $chosen, rule: $rule, run_dir: $run, terminal: $terminal}'

if [ -n "$wait_for_exit" ]; then
  # The shell of the terminal outlives the run: the run says it is over by
  # writing its exit code.
  deadline=$(( $(date +%s) + ${ORCH_WAIT_SECONDS:-1800} ))
  until [ -f "$run_dir/exit-code" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || die "the lane did not finish within the wait"
    sleep 2
  done
  exit "$(cat "$run_dir/exit-code")"
fi
