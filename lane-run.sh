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
# Which process this session is: one that dies without a word (its terminal
# closed, the host restarted) is told from one at work.
echo $$ > "$run_dir/pid"
# Whatever stops this script, the run says it is over: a wake waits for it.
trap 'echo "${lane_code:-${code:-1}}" > "$run_dir/exit-code"' EXIT
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
  [ -z "${signed_as:-}" ] || export ORCH_SIGNED="$signed_as, modèle $alias"
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
      2) why="n'a pas pu démarrer" ;;
      3)
        why="a été refusé par son garde-fou"
        if [ "$(conf_get policy guard_refusal)" != fallback ]; then
          ledger event --kind model_fallback_failed --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "$alias: its safeguard refused the task; no fallback by policy"
          echo "!! $alias $why : la lane s'arrête là (pas de repli après un refus de garde-fou)."
          return 0
        fi
        ;;
      *) return 0 ;;
    esac
    if [ $((index + 1)) -lt "$count" ]; then
      fallback_note="$alias $why ; repli déclaré : $(jq -r ".[$((index + 1))].alias" "$chain")."
      ledger event --kind model_fallback --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "$alias could not run (exit $code), next: $(jq -r ".[$((index + 1))].alias" "$chain")"
      echo "!! $fallback_note"
    else
      ledger event --kind model_fallback_failed --ticket "$ORCH_TICKET" --run-id "$run_id" --detail "no model of the chain could start (last: $alias, exit $code)"
      echo "!! Aucun modèle de la chaîne n'a pu démarrer (dernier essai : $alias)."
    fi
  done
}

run_chain "$ORCH_ROLE" "$run_dir/prompt.md" "$run_dir/chain.json" "$ORCH_REQUESTED_ALIAS"
lane_run_id=$run_id
lane_code=$code lane_report=$report lane_usage=$usage_file lane_alias=$alias lane_adapter=$adapter lane_model=$model lane_fallback=$fallback_note

# What a backend that cannot commit brought back ([adapter.<name>] commits =
# no: its work comes back as changes applied to the worktree) is committed
# here, by the rules, under the message it wrote (.commit-message, which is
# not part of its work). Without this the work would wait for another model
# to commit it. A backend that commits by itself is left alone: what it did
# not commit is its to sort out.
if { [ "$lane_code" = 0 ] || [ "$lane_code" = 5 ]; } && [ "$(conf_get "adapter.$lane_adapter" commits)" = no ] && grep -qw -- "$ORCH_ROLE" <<<"$(conf_get lanes push_roles)"; then
  message=$(mktemp)
  # A real file that says something: a blank one, or anything else by that
  # name, leaves the default subject.
  if [ -f .commit-message ] && [ ! -L .commit-message ] && grep -q '[^[:space:]]' .commit-message; then head -c 4000 .commit-message > "$message"; fi
  rm -rf .commit-message
  if [ -n "$(git status --porcelain 2> /dev/null)" ]; then
    [ -s "$message" ] || printf 'chore: the work of %s on %s\n\nSession %s; it wrote no commit message.\n' "$lane_alias" "$ORCH_TICKET" "$lane_run_id" > "$message"
    git add -A
    git -c user.name="$(git config user.name || echo dispatcher)" -c user.email="$(git config user.email || echo dispatcher@localhost)" commit --quiet -F "$message" \
      || echo "!! Le travail de $lane_alias n'a pas pu être enregistré (git commit a refusé) : il reste dans la copie de travail."
  fi
  rm -f "$message"
fi

# What the user reads in Linear. The figures and the model come from the
# scripts; only the wording of the report may come from the writing model.
body=$(mktemp)
if [ -f "$lane_report" ]; then
  sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$lane_report" | sed '1d;$d' > "$body"
  used=$(sed -n 's/^model: //p' "$lane_report")
else
  # The backend stopped before writing anything: said as it is.
  echo "L'adaptateur \`$lane_adapter\` s'est arrêté sans compte rendu (code $lane_code). Ce qu'il a affiché est resté dans le terminal de la lane." > "$body"
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
    sed -n '/^## Compte rendu$/,/^## Fichiers modifiés$/p' "$report" | sed '1d;$d' > "$body"
    writeup_note="Texte mis en forme par $(sed -n 's/^model: //p' "$report")."
  else
    writeup_note="La mise en forme a échoué : le compte rendu est celui de la lane, tel quel."
  fi
  rm -rf "$scratch"
fi

# A lane has no network command: when its role is one whose work is pushed,
# this is where its branch leaves and its pull request opens.
pushed_note=
# (Also the work of a session its budget stopped: what it committed is not lost.)
if { [ "$lane_code" = 0 ] || [ "$lane_code" = 5 ]; } && grep -qw -- "$ORCH_ROLE" <<<"$(conf_get lanes push_roles)"; then
  # Its answer is its last line on stdout. What git and gh say on the way is
  # kept in a file and shown once the script has ended.
  push_err=$(mktemp)
  if pushed=$(ORCH_RUN_ID=$lane_run_id "$ORCH_HOME/push-lane.sh" "$PWD" 2> "$push_err"); then
    pushed=$(sed -n '$p' <<<"$pushed")
    if [[ "$pushed" =~ ^#[0-9]+$ ]]; then
      pushed_note="PR ouverte ou mise à jour : $pushed (brouillon)."
      # Kept with what is known of the lane of this ticket.
      kept_lane=$(lane_record "${ORCH_LANE#*/}")
      [ ! -f "$kept_lane" ] || { jq --argjson pr "${pushed#\#}" --arg at "$(now_utc)" '. + {pr: $pr, pushed_at: $at}' "$kept_lane" > "$kept_lane.part" && mv "$kept_lane.part" "$kept_lane"; } || true
    elif [[ "$pushed" == "nothing to push"* ]]; then
      pushed_note="Rien à pousser : la lane n'a aucun commit."
    else
      pushed_note="Réponse inattendue du script de push : ${pushed:-rien}. À vérifier à la main."
    fi
  else
    # Its own last word, not a hint git may have added after it.
    reason=$(grep '^push-lane\.sh: ' "$push_err" | sed -n '$p')
    pushed_note="La branche n'a pas été poussée : ${reason:-$(sed -n '$p' "$push_err")}"
  fi
  cat "$push_err" >&2
  rm -f "$push_err"
  echo "$pushed_note"
fi

case "$lane_code" in
  0) result="terminé" ;;
  2) result="pas démarré : rien n'a été envoyé au modèle" ;;
  3) result="refusé par le garde-fou du fournisseur : rien n'a été envoyé" ;;
  5) result="arrêté : le plafond de coût du ticket est atteint" ;;
  *) result="échec (code $lane_code)" ;;
esac
tokens=$(jq -r '.tokens_total // empty' "$lane_usage")
cost=$(jq -r 'if .cost_usd then (.cost_usd * 100 | round / 100 | tostring | sub("\\."; ",")) else empty end' "$lane_usage")
comment="$run_dir/comment.md"
{
  echo "**Lane \`$ORCH_LANE\`** · rôle $ORCH_ROLE · $ORCH_TICKET${ORCH_PR:+ · PR #$ORCH_PR}"
  echo
  echo "- Modèle demandé : \`$ORCH_REQUESTED_ALIAS\` ($ORCH_RULE_NOTE)"
  echo "- Modèle utilisé : \`$used\` (adaptateur \`$lane_adapter\`)"
  [ -n "$lane_fallback" ] && echo "- Repli : $lane_fallback"
  [ -n "${ORCH_SPAWN_NOTE:-}" ] && echo "- $ORCH_SPAWN_NOTE"
  echo "- Résultat : $result${tokens:+ · $(french_number "$tokens") tokens}${cost:+ · $cost \$ au tarif API}"
  [ -n "$pushed_note" ] && echo "- $pushed_note"
  [ -n "$writeup_note" ] && echo "- $writeup_note"
  echo
  cat "$body"
} > "$comment"
rm -f "$body"

if [ "${ORCH_COMMENT_ON:-}" = none ]; then
  echo "Commentaire Linear non envoyé (demandé) : $comment"
elif url=$("$ORCH_HOME/linear.sh" comment "$ORCH_COMMENT_ON" "$comment" "${ORCH_SIGNED:-$ORCH_ROLE, lane $ORCH_LANE}"); then
  echo "Commentaire Linear : $url"
  echo "$url" > "$run_dir/comment.url"
elif [ $? = 4 ]; then
  # The user already got his comments of the hour: this one is kept, and
  # leaves with the others in one grouped comment (flush_outbox, at a wake).
  mkdir -p "$ORCH_STATE_DIR/linear-outbox"
  # Written under another name, then renamed: a wake never takes half a file.
  cp "$comment" "$ORCH_STATE_DIR/linear-outbox/.$ORCH_RUN_BASE.part"
  mv "$ORCH_STATE_DIR/linear-outbox/.$ORCH_RUN_BASE.part" "$ORCH_STATE_DIR/linear-outbox/$ORCH_COMMENT_ON--$ORCH_RUN_BASE.md"
  echo "Commentaire Linear gardé pour un envoi groupé (limite de l'heure atteinte) : $comment"
else
  echo "!! Le commentaire Linear n'a pas pu être envoyé. Il reste ici : $comment"
fi
echo "Compte rendu : $lane_report"
# A lane woken again and again keeps the terminals of its last sessions only.
[ -z "${ORCH_KEEP_TERMINALS:-}" ] || close_old_terminals "$ORCH_LANE" "$ORCH_KEEP_TERMINALS"
echo "$lane_code" > "$run_dir/exit-code"
exit "$lane_code"
