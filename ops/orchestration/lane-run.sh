#!/usr/bin/env bash
# Runs inside the terminal of a lane, in its worktree: calls the adapter of
# the model the dispatcher picked, takes the declared fallback if that
# backend refuses to start, writes each attempt to the ledger, then posts the
# report in Linear with the model actually used.
#
#   lane-run.sh <run directory prepared by spawn-lane.sh>
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

run_dir=${1:?usage: lane-run.sh <run directory>}
. "$run_dir/lane.env"
export ORCH_LANE ORCH_TICKET ORCH_ROLE
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
  adapter_env "$adapter"
  permissions_env "$role"
  ORCH_RUN_ID=$run_id ORCH_ROLE=$role ORCH_REQUESTED_MODEL=$requested \
    "$(adapter_path "$adapter")" run --model "$model" --prompt-file "$prompt" --report "$report" --usage "$usage_file"
  code=$?
  case "$code" in 0) outcome=done; model_seen "$adapter" "$model" ;; 2) outcome=refused ;; *) outcome=failed ;; esac
  [ -f "$usage_file" ] || echo '{}' > "$usage_file"
  ledger run-end --run-id "$run_id" --outcome "$outcome" --exit-code "$code" --usage-file "$usage_file"
  if [ -n "${ORCH_PR:-}" ]; then ledger run-set --run-id "$run_id" --pr-number "$ORCH_PR" --lines-changed "${ORCH_PR_LINES:-0}"; fi
}

# run_chain <role> <prompt file> <chain file> <requested alias>: first
# candidate that starts.
# A refusal to start (exit 2) moves to the declared fallback, and says so.
run_chain() {
  local role=$1 prompt=$2 chain=$3 requested=$4 count index
  count=$(jq length "$chain")
  fallback_note=
  for ((index = 0; index < count; index++)); do
    attempt "$index" "$role" "$prompt" "$chain" "$requested"
    [ "$code" = 2 ] || return 0
    if [ $((index + 1)) -lt "$count" ]; then
      fallback_note="$alias a refusé de démarrer ; repli déclaré : $(jq -r ".[$((index + 1))].alias" "$chain")."
      ledger event --kind model_fallback --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "$alias refused to start, next: $(jq -r ".[$((index + 1))].alias" "$chain")"
      echo "!! $fallback_note"
    else
      ledger event --kind model_fallback_failed --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "no model of the chain could start (last: $alias)"
      echo "!! Aucun modèle de la chaîne n'a pu démarrer (dernier essai : $alias)."
    fi
  done
}

run_chain "$ORCH_ROLE" "$run_dir/prompt.md" "$run_dir/chain.json" "$ORCH_REQUESTED_ALIAS"
lane_code=$code lane_report=$report lane_usage=$usage_file lane_alias=$alias lane_adapter=$adapter lane_model=$model lane_fallback=$fallback_note

# What the user reads in Linear. The figures and the model come from the
# scripts; only the wording of the report may come from the writing model.
body=$(mktemp)
sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$lane_report" | sed '1d;$d' > "$body"
writeup_note=
if [ "$lane_code" = 0 ] && [ -f "$run_dir/writeup-chain.json" ]; then
  {
    cat "$ORCH_HOME/prompts/writeup.md"
    echo
    cat "$body"
  } > "$run_dir/writeup-prompt.md"
  scratch=$(mktemp -d)
  (cd "$scratch" && export ORCH_TEXT_ONLY=1 && run_chain "$ORCH_WRITEUP_ROLE" "$run_dir/writeup-prompt.md" "$run_dir/writeup-chain.json" "$(jq -r '.[0].alias' "$run_dir/writeup-chain.json")"; exit "$code")
  if [ $? = 0 ]; then
    writeup_report=$(ls -t "$ORCH_STATE_DIR/reports/$ORCH_RUN_BASE-$ORCH_WRITEUP_ROLE-"*.md | head -n 1)
    sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$writeup_report" | sed '1d;$d' > "$body"
    writeup_note="Texte mis en forme par $(sed -n 's/^model: //p' "$writeup_report")."
  else
    writeup_note="La mise en forme a échoué : le compte rendu est celui de la lane, tel quel."
  fi
  rm -rf "$scratch"
fi

case "$lane_code" in 0) result="terminé" ;; 2) result="refusé avant le lancement du modèle" ;; *) result="échec (code $lane_code)" ;; esac
tokens=$(jq -r '.tokens_total // empty' "$lane_usage")
cost=$(jq -r 'if .cost_usd then (.cost_usd * 100 | round / 100 | tostring | sub("\\."; ",")) else empty end' "$lane_usage")
comment="$run_dir/comment.md"
{
  echo "**Lane \`$ORCH_LANE\`** · rôle $ORCH_ROLE · $ORCH_TICKET${ORCH_PR:+ · PR #$ORCH_PR}"
  echo
  echo "- Modèle demandé : \`$ORCH_REQUESTED_ALIAS\` ($ORCH_RULE_NOTE)"
  echo "- Modèle utilisé : \`$(sed -n 's/^model: //p' "$lane_report")\` (adaptateur \`$lane_adapter\`)"
  [ -n "$lane_fallback" ] && echo "- Repli : $lane_fallback"
  [ -n "${ORCH_SPAWN_NOTE:-}" ] && echo "- $ORCH_SPAWN_NOTE"
  echo "- Résultat : $result${tokens:+ · $(french_number "$tokens") tokens}${cost:+ · $cost \$ au tarif API}"
  [ -n "$writeup_note" ] && echo "- $writeup_note"
  echo
  cat "$body"
} > "$comment"
rm -f "$body"

if [ "${ORCH_COMMENT_ON:-}" = none ]; then
  echo "Commentaire Linear non envoyé (demandé) : $comment"
elif url=$("$ORCH_HOME/linear.sh" comment "$ORCH_COMMENT_ON" "$comment" "$ORCH_ROLE, lane $ORCH_LANE"); then
  echo "Commentaire Linear : $url"
  echo "$url" > "$run_dir/comment.url"
else
  echo "!! Le commentaire Linear n'a pas pu être envoyé. Il reste ici : $comment"
fi
echo "Compte rendu : $lane_report"
echo "$lane_code" > "$run_dir/exit-code"
exit "$lane_code"
