#!/usr/bin/env bash
# Opens a lane for one role on one ticket: a git worktree on the branch
# <role>/<ticket> (Orca shows it as a lane of that name) and a terminal in it
# that runs the model picked by agents.conf.
#
#   spawn-lane.sh <role> <ticket> [--model <alias>] [--prompt-file <file>]
#                 [--comment-on <ticket>|none] [--author-model <alias>]
#                 [--path <touched path>]... [--pr-lines <n>] [--wait] [--dry-run]
#
# This script knows the contract of the adapters and nothing else: no model
# and no provider is named here.
#
# Exit codes: 0 spawned, 3 lane limit reached, 5 no model of the chain is
# available, 1 anything else.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
[ $# -ge 2 ] || usage
role=$1 ticket=$2
shift 2
forced= prompt_file= comment_on=$ticket author= pr_lines= wait_for_exit= dry_run=
paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model) forced=$2; shift 2 ;;
    --prompt-file) prompt_file=$2; shift 2 ;;
    --comment-on) comment_on=$2; shift 2 ;;
    --author-model) author=$2; shift 2 ;;
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
[ -n "$forced" ] && route_args+=(--model "$forced")
[ -n "$author" ] && route_args+=(--author-model "$author")
[ -n "$pr_lines" ] && route_args+=(--pr-lines "$pr_lines")
routed=$(node "$ORCH_HOME/lib/route.mjs" "${route_args[@]}" "${paths[@]}")
requested=$(jq -r '.chain[0].alias' <<<"$routed")
rule=$(jq -r '.rule' <<<"$routed")

# 2. Availability, asked to each adapter. An unavailable model is replaced by
# its declared fallback, loudly; a chain with no available model is an error.
available=$(mktemp)
echo '[]' > "$available"
spawn_note=
while IFS=$'\t' read -r alias adapter model; do
  if model_available "$adapter" "$model"; then
    jq -c --arg alias "$alias" --arg adapter "$adapter" --arg model "$model" '. + [{alias: $alias, adapter: $adapter, model: $model}]' "$available" > "$available.next" && mv "$available.next" "$available"
  else
    echo "$(basename "$0"): $alias ($adapter: $model) is not available" >&2
    [ "$(jq length "$available")" = 0 ] && spawn_note="${spawn_note}${alias} indisponible au lancement. "
  fi
done < <(jq -r '.chain[] | [.alias, .adapter, .model] | @tsv' <<<"$routed")
if [ "$(jq length "$available")" = 0 ]; then
  [ -n "$dry_run" ] || ledger event --kind model_fallback_failed --ticket "$ticket" --detail "$lane: no model of the chain is available ($(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed"))"
  die "no model of the chain is available for $lane: $(jq -r '[.chain[].alias] | join(" > ")' <<<"$routed")"
fi
chosen=$(jq -r '.[0].alias' "$available")
if [ "$chosen" != "$requested" ]; then
  spawn_note="${spawn_note}Repli déclaré pris : $chosen."
  [ -n "$dry_run" ] || ledger event --kind model_fallback --ticket "$ticket" --detail "$lane: $requested unavailable at spawn, fallback $chosen"
  echo "$(basename "$0"): fallback, $requested -> $chosen" >&2
fi

if [ -n "$dry_run" ]; then
  jq -n --arg lane "$lane" --arg rule "$rule" --arg requested "$requested" --slurpfile chain "$available" --argjson notes "$(jq -c '.notes' <<<"$routed")" \
    '{lane: $lane, rule: $rule, requested: $requested, would_run: $chain[0][0], fallbacks: $chain[0][1:], notes: $notes}'
  rm -f "$available"
  exit 0
fi

prompt_file=${prompt_file:-$ORCH_HOME/prompts/$role.md}
[ -f "$prompt_file" ] || die "no prompt for the role \"$role\": $prompt_file"

# 3. The limit on lanes running at once is applied here, not left to a rule.
max=$(conf_get limits max_lanes)
open=$(dispatcher_lanes | wc -l | tr -d ' ')
if dispatcher_lanes | grep -qxF "$lane"; then die "the lane $lane is already open"; fi
if [ "$open" -ge "$max" ]; then
  ledger event --kind lane_limit_reached --ticket "$ticket" --detail "$lane refused: $open lanes open for a limit of $max" --value "$open"
  echo "$(basename "$0"): lane limit reached ($open open, limit $max): $lane not opened" >&2
  exit 3
fi

# 4. The worktree. Orca lists any git worktree of the repository by itself.
root=$(expand_home "$(conf_get lanes root)")
base=$(conf_get lanes base)
worktree="$root/$role-$ticket"
[ -e "$worktree" ] && die "$worktree already exists"
git -C "$ORCH_REPO" fetch --quiet origin "${base#origin/}" || echo "$(basename "$0"): fetch failed, using the local $base" >&2
git -C "$ORCH_REPO" worktree add --quiet -b "$lane" "$worktree" "$base"

# 5. What the terminal of the lane will run.
run_base="$ticket-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="$ORCH_STATE_DIR/runs/$run_base"
mkdir -p "$run_dir"
mv "$available" "$run_dir/chain.json"
{
  cat "$prompt_file"
  printf '\n---\nTicket %s : %s\n%s\nLane : %s (branche du même nom).\n' "$ticket" "$(jq -r '.title' <<<"$issue")" "$(jq -r '.url' <<<"$issue")" "$lane"
} > "$run_dir/prompt.md"
writeup_role=$(conf_get linear writeup_role)
if [ -n "$writeup_role" ] && [ "$comment_on" != none ] && [ "$writeup_role" != "$role" ]; then
  written=$(node "$ORCH_HOME/lib/route.mjs" --role "$writeup_role")
  echo '[]' > "$run_dir/writeup-chain.json"
  while IFS=$'\t' read -r alias adapter model; do
    if model_available "$adapter" "$model"; then
      jq -c --arg alias "$alias" --arg adapter "$adapter" --arg model "$model" '. + [{alias: $alias, adapter: $adapter, model: $model}]' "$run_dir/writeup-chain.json" > "$run_dir/writeup-chain.next" && mv "$run_dir/writeup-chain.next" "$run_dir/writeup-chain.json"
    fi
  done < <(jq -r '.chain[] | [.alias, .adapter, .model] | @tsv' <<<"$written")
  [ "$(jq length "$run_dir/writeup-chain.json")" = 0 ] && rm -f "$run_dir/writeup-chain.json"
fi
{
  printf 'ORCH_LANE=%q\nORCH_TICKET=%q\nORCH_ROLE=%q\nORCH_RUN_BASE=%q\n' "$lane" "$ticket" "$role" "$run_base"
  printf 'ORCH_REQUESTED_ALIAS=%q\nORCH_RULE_NOTE=%q\nORCH_SPAWN_NOTE=%q\n' "$requested" "règle : $rule" "$spawn_note"
  printf 'ORCH_COMMENT_ON=%q\nORCH_WRITEUP_ROLE=%q\n' "$comment_on" "$writeup_role"
  printf 'ORCH_PROJECT=%q\nORCH_LABEL=%q\n' "$(jq -r '.project // ""' <<<"$issue")" "$(jq -r '.labels[0] // ""' <<<"$issue")"
} > "$run_dir/lane.env"

# 6. The terminal, visible in Orca under the lane.
terminal=
for _ in 1 2 3 4 5 6; do
  if terminal=$(orca terminal create --worktree "path:$worktree" --title "$lane · $chosen" --command "$ORCH_HOME/lane-run.sh $run_dir" --json 2>/dev/null); then break; fi
  terminal=
  sleep 5
done
[ -n "$terminal" ] || die "the worktree $worktree exists but Orca did not open a terminal in it; run by hand: (cd $worktree && $ORCH_HOME/lane-run.sh $run_dir)"
handle=$(jq -r '.. | objects | .handle? // empty' <<<"$terminal" | head -n 1)
# Orca knows the worktree by now: link it to its ticket.
orca worktree set --worktree "path:$worktree" --linear-issue "$ticket" --comment "$role · $chosen · ouverte par le dispatcher" > /dev/null 2>&1 || true
echo "$handle" > "$run_dir/terminal.handle"

jq -n --arg lane "$lane" --arg worktree "$worktree" --arg requested "$requested" --arg chosen "$chosen" --arg rule "$rule" --arg run "$run_dir" --arg terminal "$handle" \
  '{lane: $lane, worktree: $worktree, requested: $requested, model: $chosen, rule: $rule, run_dir: $run, terminal: $terminal}'

if [ -n "$wait_for_exit" ]; then
  orca terminal wait --terminal "$handle" --for exit --timeout-ms "${ORCH_WAIT_MS:-1800000}" > /dev/null 2>&1 || true
  [ -f "$run_dir/exit-code" ] || die "the lane did not finish within the wait"
  exit "$(cat "$run_dir/exit-code")"
fi
