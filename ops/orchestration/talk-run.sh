#!/usr/bin/env bash
# The conversation itself, in the terminal talk.sh opened: starts the
# interactive session of the first model of the chain that can hold one, and
# writes it to the ledger (source discussion) with the tokens its own session
# log counts. Never run by a model.
#
#   talk-run.sh <run dir>
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

run_dir=${1:?usage: talk-run.sh <run dir>}
[ -f "$run_dir/talk.env" ] || die "$run_dir is not the folder of a discussion"
set -a
. "$run_dir/talk.env"
set +a
permissions_env "$ORCH_ROLE"
# The one file the session may edit, and the script it transcribes with.
export ORCH_EDIT_ONLY="$ORCH_DECISIONS_WORKTREE/docs/decisions.md"
export ORCH_RUN_ID="$ORCH_RUN_BASE-$ORCH_ROLE-a1" ORCH_FROM="$(conf_get lead name), en discussion"

code=2
while IFS=$'\t' read -r alias adapter model; do
  adapter_env "$adapter"
  session=$(cat /proc/sys/kernel/random/uuid)
  echo "── $ORCH_LANE · discussion · $alias ($adapter: $model) ──"
  ledger run-start --run-id "$ORCH_RUN_ID" --role "$ORCH_ROLE" --model "$model" --provider "$adapter" --lane "$ORCH_LANE" \
    --source discussion --requested-model "$ORCH_REQUESTED_ALIAS" || true
  # The terminal is the screen of the conversation: nothing is piped.
  "$(adapter_path "$adapter")" talk --model "$model" --prompt-file "$run_dir/prompt.md" --session-id "$session" < "${ORCH_TTY:-/dev/tty}"
  code=$?
  [ "$code" = 2 ] || break
  echo "$alias ne peut pas tenir de conversation ici : modèle suivant."
done < <(jq -r '.[] | [.alias, .adapter, .model] | @tsv' "$run_dir/chain.json")

node --no-warnings "$ORCH_HOME/lib/session-usage.mjs" "$session" "$model" > "$run_dir/usage.json" 2> /dev/null || echo '{}' > "$run_dir/usage.json"
outcome=done
[ "$code" = 0 ] || outcome=failed
ledger run-end --run-id "$ORCH_RUN_ID" --outcome "$outcome" --exit-code "$code" --usage-file "$run_dir/usage.json" || true
echo "$code" > "$run_dir/exit-code"

# A change left in the file of the decisions and never transcribed is said,
# not thrown away and not sent.
if [ -n "$(git -C "$ORCH_DECISIONS_WORKTREE" status --porcelain 2> /dev/null)" ]; then
  echo "!! docs/decisions.md a été modifié sans être transcrit : le changement reste dans $ORCH_DECISIONS_WORKTREE, rien n'est parti."
fi
echo "Discussion terminée. Décisions transcrites pendant cette discussion :"
ledger sql "select ticket, detail from events where kind = 'decision' and run_id = '$ORCH_RUN_ID' order by at" 2> /dev/null | jq -r 'if length == 0 then "- aucune" else .[] | "- \(.ticket // "sans ticket") : \(.detail)" end' || true
exit "$code"
