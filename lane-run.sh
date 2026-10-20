#!/usr/bin/env bash
# Runs inside the terminal of a lane, in its worktree: calls the adapter of
# the model the dispatcher picked, takes the declared fallback if that
# backend refuses to start, writes each attempt to the ledger, then posts the
# report in tracker with the model actually used.
#
#   lane-run.sh <run directory prepared by spawn-lane.sh>
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

run_dir=${1:?usage: lane-run.sh <run directory>}
. "$run_dir/lane.env"
# Which process this session is: one that dies without a word (its terminal
# closed, the host restarted) is told from one at work.
echo $$ > "$run_dir/pid"
# Whatever stops this script, the run says it is over: a wake waits for it.
lane_worktree=$PWD
handover_captured=
capture_handover() {
  [ -n "$handover_captured" ] && return 0
  handover_captured=1
  [ "$(conf_get memory enabled)" = true ] || return 0
  [[ "$ORCH_TICKET" =~ ^[A-Z]+-[0-9]+$ ]] || return 0
  local actual_model=${lane_model:-${model:-}}
  if [ -z "$actual_model" ]; then
    ledger event --kind handover_missing --ticket "$ORCH_TICKET" --run-id "${lane_run_id:-${run_id:-$ORCH_RUN_BASE}}" --detail 'No model started; any handover is left for recovery'
    return 0
  fi
  node "$ORCH_HOME/lib/memory/cli.mjs" capture "$lane_worktree" "$ORCH_ROLE" "$actual_model" "$ORCH_TICKET" "${lane_run_id:-${run_id:-$ORCH_RUN_BASE}}" \
    || echo '!! Handover could not be stored; inspect the worktree and the run backup.' >&2
}
on_exit() {
  capture_handover
  echo "${lane_code:-${code:-1}}" > "$run_dir/exit-code"
}
trap on_exit EXIT
export ORCH_LANE ORCH_TICKET ORCH_ROLE
[ -z "${ORCH_PUSH_BRANCH:-}" ] || export ORCH_PUSH_BRANCH
# How what this run posts is signed (the acting lead posts by itself).
[ -z "${ORCH_SIGNED:-}" ] || export ORCH_SIGNED
signed_as=${ORCH_SIGNED:-}
mkdir -p "$ORCH_STATE_DIR/reports"

french_number() { printf '%s' "$1" | sed -E ':a;s/^([0-9]+)([0-9]{3})/\1 \2/;ta'; }

# attempt <index in chain> <role> <prompt file> <chain file> <requested alias>:
# one run of one candidate. Sets run_id, report, usage_file, alias, adapter,
# model, code.
attempt() {
  local index=$1 role=$2 prompt=$3 chain=$4 requested=$5 outcome
  alias=$(jq -r ".[$index].alias" "$chain") adapter=$(jq -r ".[$index].adapter" "$chain") model=$(jq -r ".[$index].model" "$chain")
  run_id="$ORCH_RUN_BASE-$role-a$((index + 1))"
  report="$ORCH_STATE_DIR/reports/$run_id.md" usage_file="$run_dir/$role-usage-$((index + 1)).json"
  ledger run-start --run-id "$run_id" --ticket "$ORCH_TICKET" --role "$role" --lane "$ORCH_LANE" \
    --model "$model" --provider "$adapter" --requested-model "$requested" \
    --project "${ORCH_PROJECT:-}" --label "${ORCH_LABEL:-}"
  echo "── $ORCH_LANE · $role · $alias ($adapter: $model) ──"
  # What this run posts by itself says which model wrote it.
  [ -z "${signed_as:-}" ] || export ORCH_SIGNED="$signed_as, model $alias"
  adapter_env "$adapter"
  # The role's own permissions, unless the run was given others (the acting
  # lead), which never apply to another role of the same lane (the write-up).
  if [ "$role" = "$ORCH_ROLE" ]; then permissions_env "${ORCH_PERMISSIONS:-$role}"; else permissions_env "$role"; fi
  # The budget of the ticket is for the work of the lane, not for the write-up of its report.
  ORCH_BUDGET_USD=$([ "$role" = "$ORCH_ROLE" ] && echo "${ORCH_BUDGET_USD:-}") ORCH_RUN_ID=$run_id ORCH_ROLE=$role ORCH_REQUESTED_MODEL=$requested \
    "$(adapter_path "$adapter")" run --model "$model" --prompt-file "$prompt" --report "$report" --usage "$usage_file"
  code=$?
  case "$code" in 0) outcome=done; model_seen "$adapter" "$model" ;; 2 | 3) outcome=refused ;; *) outcome=failed ;; esac
  [ -f "$usage_file" ] || echo '{}' > "$usage_file"
  # Where the subscription stands, if this backend said it: kept for the rules and the dashboard.
  node --no-warnings "$ORCH_HOME/lib/limits.mjs" note "$adapter" "$usage_file" 2> /dev/null || true
  ledger run-end --run-id "$run_id" --outcome "$outcome" --exit-code "$code" --usage-file "$usage_file"
  if [ -n "${ORCH_PR:-}" ]; then ledger run-set --run-id "$run_id" --pr-number "$ORCH_PR" --lines-changed "${ORCH_PR_LINES:-0}"; fi
}

# run_chain <role> <prompt file> <chain file> <requested alias>: first
# candidate that starts. A backend that cannot start now (exit 2) hands over
# to the declared fallback; one whose safeguard refuses the task (exit 3) does
# so only if [policy] guard_refusal says fallback. Both are said out loud.
run_chain() {
  local role=$1 prompt=$2 chain=$3 requested=$4 count index why
  count=$(jq length "$chain")
  fallback_note=
  for ((index = 0; index < count; index++)); do
    attempt "$index" "$role" "$prompt" "$chain" "$requested"
    case "$code" in
      2) why="could not start" ;;
      3)
        why="was refused by its guard"
        if [ "$(conf_get policy guard_refusal)" != fallback ]; then
          ledger event --kind model_fallback_failed --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "$alias: its safeguard refused the task; no fallback by policy"
          echo "!! $alias $why : the team stops here (no fallback after a guard refusal)."
          return 0
        fi
        ;;
      *) return 0 ;;
    esac
    if [ $((index + 1)) -lt "$count" ]; then
      fallback_note="$alias $why ; configured fallback: $(jq -r ".[$((index + 1))].alias" "$chain")."
      ledger event --kind model_fallback --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "$alias could not run (exit $code), next: $(jq -r ".[$((index + 1))].alias" "$chain")"
      echo "!! $fallback_note"
    else
      ledger event --kind model_fallback_failed --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "no model of the chain could start (last: $alias, exit $code)"
      echo "!! No model in the chain could start (last attempt: $alias)."
    fi
  done
}

run_chain "$ORCH_ROLE" "$run_dir/prompt.md" "$run_dir/chain.json" "$ORCH_REQUESTED_ALIAS"
lane_run_id=$run_id
lane_code=$code lane_report=$report lane_usage=$usage_file lane_alias=$alias lane_adapter=$adapter lane_model=$model lane_fallback=$fallback_note
capture_handover

# What a session leaves uncommitted in its lane is committed here, by the
# rules, whatever the mode (#116): a backend that cannot commit ([security]
# agent_user, where Git's control files are read-only to it, or [adapter.<name>]
# commits = no in a container) brings its work back as changes to the
# worktree, and a harness of this account with no git identity of its own
# can leave its work staged and stop. Without this the work would be lost to
# the push, and the fast lane would judge an empty head. It goes under the
# message the model wrote (.commit-message, which is not part of its work),
# with the dispatcher's identity (the app's under [forge], else the local
# one), hooks off. A backend that committed by itself keeps its commits as it
# made them: nothing is amended, and a clean worktree gets nothing.
# Never in the project's main checkout, where the acting lead runs: that
# checkout is the service's.
if { [ "$lane_code" = 0 ] || [ "$lane_code" = 5 ]; } \
  && [ "$(realpath -m -- "$PWD")" != "$(realpath -m -- "$ORCH_REPO")" ] \
  && grep -qw -- "$ORCH_ROLE" <<<"$(conf_get lanes push_roles)"; then
  message=$(mktemp)
  # A real file that says something: a blank one, or anything else by that
  # name, leaves the default subject.
  if [ -f .commit-message ] && [ ! -L .commit-message ] && grep -q '[^[:space:]]' .commit-message; then head -c 4000 .commit-message > "$message"; fi
  rm -rf .commit-message
  # Every git call of this step, in shared-uid mode the model has the service's
  # uid and can write the shared .git/config (linked worktrees read it): each
  # setting that runs a program is switched off on the command line.
  commit_git=(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.editor=false -c diff.external=
    -c core.sshCommand= -c credential.helper= -c commit.gpgSign=false -c gpg.program=false)
  if [ -n "$(GIT_OPTIONAL_LOCKS=0 "${commit_git[@]}" status --porcelain 2> /dev/null)" ]; then
    # A rebase or a merge in progress, or a detached HEAD: the work stays in
    # the worktree for the team to finish, said as it is.
    git_dir=$("${commit_git[@]}" rev-parse --git-dir 2> /dev/null)
    if [ -n "$git_dir" ] && { [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] || [ -f "$git_dir/MERGE_HEAD" ]; }; then
      echo "!! The work of $lane_alias was not committed: a rebase or a merge is in progress in the worktree; it remains there."
    elif ! "${commit_git[@]}" symbolic-ref -q HEAD > /dev/null 2>&1; then
      echo "!! The work of $lane_alias was not committed: HEAD is detached; it remains in the worktree."
    else
      [ -s "$message" ] || printf 'chore: the work of %s on %s\n\nSession %s; it wrote no commit message.\n' "$lane_alias" "$ORCH_TICKET" "$lane_run_id" > "$message"
      "${commit_git[@]}" add -A
      "${commit_git[@]}" -c user.name="$(git config user.name || echo dispatcher)" -c user.email="$(git config user.email || echo dispatcher@localhost)" commit --quiet -F "$message" \
        || echo "!! The work of $lane_alias could not be committed (git commit refused); it remains in the worktree."
    fi
  fi
  rm -f "$message"
fi

# The fast lane (docs/fast-lane.md): the rules judge what this session
# leaves, at this very commit, before it leaves; still on the fast lane, the
# targeted tests of the changed files run here, with no shell, under the
# agents' account when the project has one (they run the branch's code), and
# what they gave is kept with the commit they ran on. The full checks run on
# the forge as for any lane. Never in the project's main checkout.
fast_lane_session() {
  local head kept key=${ORCH_LANE#*/} code=0 minutes agent_user agent_home prefix=() argv=()
  head=$(git rev-parse --verify --quiet HEAD) || return 0
  kept=$(node --no-warnings "$ORCH_HOME/lib/fast-lane.mjs" decide "$key" "$head" 2> /dev/null) || kept=full
  if [ "$kept" != fast ]; then echo "Fast lane: the rules send $ORCH_TICKET to the full circuit at ${head:0:8}."; return 0; fi
  node --no-warnings "$ORCH_HOME/lib/fast-lane.mjs" targeted "$key" "$head" > "$run_dir/targeted.argv" 2> /dev/null || { node --no-warnings "$ORCH_HOME/lib/fast-lane.mjs" tests-done "$key" "$head" skipped || true; echo "Fast lane: no targeted tests to run: skipped at ${head:0:8}."; return 0; }
  mapfile -d '' -t argv < "$run_dir/targeted.argv"
  [ "${#argv[@]}" -gt 0 ] || return 0
  minutes=$(conf_get fast_lane tests_timeout_minutes)
  [[ "$minutes" =~ ^[0-9]+$ ]] || minutes=10
  agent_user=$(conf_get security agent_user)
  if [ -n "$agent_user" ] && [ "$(id -un)" != "$agent_user" ]; then
    agent_home=$(getent passwd "$agent_user" | cut -d: -f6)
    agent_mount_args
    prefix=("${AGENT_MOUNT_ARGS[@]}")
    [ "${#prefix[@]}" = 0 ] || prefix+=(--)
    sudo -n -u "$agent_user" -- env -i PATH="$agent_home/.local/bin:/usr/local/bin:/usr/bin:/bin" HOME="$agent_home" LANG=C.UTF-8 CI=1 \
      timeout -k 10 "$((minutes * 60))" "${prefix[@]}" "${argv[@]}" > "$run_dir/targeted-tests.log" 2>&1 < /dev/null || code=$?
  else
    # No credential of the service goes with them: an empty environment, and
    # an empty home (the service's HOME holds its files and its keys).
    local scratch_home
    scratch_home=$(mktemp -d) || { node --no-warnings "$ORCH_HOME/lib/fast-lane.mjs" tests-done "$key" "$head" skipped || true; echo "Fast lane: targeted tests at ${head:0:8}: skipped (no empty home could be made)."; return 0; }
    env -i PATH="$PATH" HOME="$scratch_home" LANG=C.UTF-8 CI=1 timeout -k 10 "$((minutes * 60))" "${argv[@]}" > "$run_dir/targeted-tests.log" 2>&1 < /dev/null || code=$?
    rm -rf -- "$scratch_home"

  fi
  node --no-warnings "$ORCH_HOME/lib/fast-lane.mjs" tests-done "$key" "$head" "$code" || true
  echo "Fast lane: targeted tests at ${head:0:8}: $([ "$code" = 0 ] && echo passed || echo "failed (exit $code)")."
}
if [ "${ORCH_FAST_LANE:-}" = fast ] && { [ "$lane_code" = 0 ] || [ "$lane_code" = 5 ]; } \
  && [ "$(realpath -m -- "$PWD")" != "$(realpath -m -- "$ORCH_REPO")" ]; then
  fast_lane_session
fi

# What the user reads in tracker. The figures and the model come from the
# scripts; only the wording of the report may come from the writing model.
body=$(mktemp)
if [ -f "$lane_report" ]; then
  sed -n '/^## \(Report\|Compte rendu\)$/,/^## \(Changed files\|Fichiers modifiés\)$/p' "$lane_report" | sed '1d;$d' > "$body"
  used=$(sed -n 's/^model: //p' "$lane_report")
else
  # The backend stopped before writing anything: said as it is.
  echo "The \`$lane_adapter\` adapter stopped without a report (exit $lane_code). Its output remains in the team terminal." > "$body"
  used=$lane_model
fi
writeup_note=
if [ "$lane_code" = 0 ] && [ -f "$run_dir/writeup-chain.json" ] && [ -r "$(prompt_file writeup)" ]; then
  {
    prompt_text "$(prompt_file writeup)"
    echo
    cat "$body"
  } > "$run_dir/writeup-prompt.md"
  scratch=$(mktemp -d)
  lane_dir=$PWD
  cd "$scratch"
  ORCH_TEXT_ONLY=1 run_chain "$ORCH_WRITEUP_ROLE" "$run_dir/writeup-prompt.md" "$run_dir/writeup-chain.json" "$(jq -r '.[0].alias' "$run_dir/writeup-chain.json")"
  cd "$lane_dir"
  # $code and $report are those of the last attempt of the write-up.
  if [ "$code" = 0 ]; then
    sed -n '/^## \(Report\|Compte rendu\)$/,/^## \(Changed files\|Fichiers modifiés\)$/p' "$report" | sed '1d;$d' > "$body"
    writeup_note="Report formatted by $(sed -n 's/^model: //p' "$report")."
  else
    writeup_note="Formatting failed; this is the original team report."
  fi
  rm -rf "$scratch"
fi

# A lane has no network command: when its role is one whose work is pushed,
# this is where its branch leaves and its pull request opens.
pushed_note=
# (Also the work of a session its budget stopped: what it committed is not lost.)
# Never from the project's main checkout, as for the commit above.
if { [ "$lane_code" = 0 ] || [ "$lane_code" = 5 ]; } \
  && [ "$(realpath -m -- "$PWD")" != "$(realpath -m -- "$ORCH_REPO")" ] \
  && grep -qw -- "$ORCH_ROLE" <<<"$(conf_get lanes push_roles)"; then
  # Its answer is its last line on stdout. What git and gh say on the way is
  # kept in a file and shown once the script has ended.
  push_err=$(mktemp)
  if pushed=$(ORCH_RUN_ID=$lane_run_id "$ORCH_HOME/push-lane.sh" "$PWD" 2> "$push_err"); then
    pushed=$(sed -n '$p' <<<"$pushed")
    if [[ "$pushed" =~ ^#[0-9]+$ ]]; then
      pushed_note="Pull request opened or updated: $pushed (draft)."
      # Kept with what is known of the lane of this ticket.
      kept_lane=$(lane_record "${ORCH_LANE#*/}")
      [ ! -f "$kept_lane" ] || { lane_write "$kept_lane" --argjson pr "${pushed#\#}" --arg at "$(now_utc)" '. + {pr: $pr, pushed_at: $at}'; } || true
    elif [[ "$pushed" == "nothing to push"* ]]; then
      pushed_note="Nothing to push: the team has no commit."
    else
      pushed_note="Unexpected response from the push script: ${pushed:-nothing}. Check manually."
    fi
  else
    # Its own last word, not a hint git may have added after it.
    reason=$(grep '^push-lane\.sh: ' "$push_err" | sed -n '$p')
    pushed_note="The branch was not pushed: ${reason:-$(sed -n '$p' "$push_err")}"
  fi
  cat "$push_err" >&2
  rm -f "$push_err"
  echo "$pushed_note"
fi

case "$lane_code" in
  0) result="done" ;;
  2) result="not started: nothing was sent to the model" ;;
  3) result="refused by the provider guard: nothing was sent" ;;
  5) result="stopped: the ticket cost cap was reached" ;;
  *) result="failed (exit $lane_code)" ;;
esac
tokens=$(jq -r '.tokens_total // empty' "$lane_usage")
cost=$(jq -r 'if .cost_usd then (.cost_usd * 100 | round / 100 | tostring) else empty end' "$lane_usage")
comment="$run_dir/comment.md"
{
  echo "**Lane \`$ORCH_LANE\`** · role $ORCH_ROLE · $ORCH_TICKET${ORCH_PR:+ · PR #$ORCH_PR}"
  echo
  echo "- Requested model: \`$ORCH_REQUESTED_ALIAS\` ($ORCH_RULE_NOTE)"
  echo "- Used model: \`$used\` (adapter \`$lane_adapter\`)"
  [ -n "$lane_fallback" ] && echo "- Fallback: $lane_fallback"
  [ -n "${ORCH_SPAWN_NOTE:-}" ] && echo "- $ORCH_SPAWN_NOTE"
  echo "- Result: $result${tokens:+ · $(french_number "$tokens") tokens}${cost:+ · $cost \$ at API list price}"
  [ -n "$pushed_note" ] && echo "- $pushed_note"
  [ -n "$writeup_note" ] && echo "- $writeup_note"
  echo
  cat "$body"
} > "$comment"
rm -f "$body"

if [ "${ORCH_COMMENT_ON:-}" = none ]; then
  echo "tracker comment not sent (requested): $comment"
elif url=$("$ORCH_HOME/tracker.sh" comment "$ORCH_COMMENT_ON" "$comment" "${ORCH_SIGNED:-$ORCH_ROLE, lane $ORCH_LANE}"); then
  echo "tracker comment: $url"
  echo "$url" > "$run_dir/comment.url"
elif [ $? = 4 ]; then
  # The user already got his comments of the hour: this one is kept, and
  # leaves with the others in one grouped comment (flush_outbox, at a wake).
  mkdir -p "$ORCH_STATE_DIR/tracker-outbox"
  # Written under another name, then renamed: a wake never takes half a file.
  cp "$comment" "$ORCH_STATE_DIR/tracker-outbox/.$ORCH_RUN_BASE.part"
  mv "$ORCH_STATE_DIR/tracker-outbox/.$ORCH_RUN_BASE.part" "$ORCH_STATE_DIR/tracker-outbox/$ORCH_COMMENT_ON--$ORCH_RUN_BASE.md"
  echo "tracker comment kept for a grouped send (hourly limit reached): $comment"
else
  echo "!! The tracker comment could not be sent. It remains here: $comment"
fi
echo "Report: $lane_report"
# A lane woken again and again keeps the terminals of its last sessions only.
[ -z "${ORCH_KEEP_TERMINALS:-}" ] || close_old_terminals "$ORCH_LANE" "$ORCH_KEEP_TERMINALS"
echo "$lane_code" > "$run_dir/exit-code"
exit "$lane_code"
