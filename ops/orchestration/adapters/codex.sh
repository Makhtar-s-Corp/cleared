#!/usr/bin/env bash
# Adapter for the Codex CLI. Contract: lib/contract.sh.
#
# Codex never runs on the host. This adapter only calls the trusted task
# script of the main checkout (ADAPTER_TASK_SCRIPT), which runs Codex in a
# container on a guarded snapshot of the commit and brings back a patch. When
# it cannot start now (a CI run in progress, uncommitted changes) the adapter
# exits with 2; when the guard of that script refuses the content, with 3.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/contract.sh"

case "${1:-}" in
  list-models)
    shift
    # Codex keeps the list its server sent it: no call is needed.
    cache="${CODEX_HOME:-$HOME/.codex}/models_cache.json"
    [ -f "$cache" ] || exit 0
    listed=$(jq -r '.. | objects | select(has("slug")) | .slug' "$cache" | sort -u)
    if [ $# -eq 0 ]; then
      printf '%s\n' "$listed"
    else
      for candidate in "$@"; do grep -xF -- "$candidate" <<<"$listed" || true; done
    fi
    ;;
  version)
    # The copy that counts is the one the isolated task script mounts in its
    # container, not the one on the PATH.
    task_script=${ADAPTER_TASK_SCRIPT:-}
    case "$task_script" in "~/"*) task_script="$HOME/${task_script#\~/}" ;; esac
    mounted=$(grep -o -E '/[^ :"]+/node_modules/@openai/codex' "$task_script" 2>/dev/null | head -n 1)
    installed=$(jq -r '.version' "$mounted/package.json" 2>/dev/null || codex --version 2>/dev/null | awk '{print $NF}')
    contract_npm_version codex "${ADAPTER_PACKAGE:-}" "$installed"
    ;;
  run)
    shift
    contract_parse_run "$@"
    out=$(mktemp) err=$(mktemp) body=$(mktemp)
    trap 'rm -f "$out" "$err" "$body"' EXIT
    refuse() {
      echo "Codex n'a pas été lancé : $1" | tee "$body" >&2
      contract_usage '{}'
      contract_report codex 2 "$body"
      exit 2
    }
    task_script=${ADAPTER_TASK_SCRIPT:-}
    case "$task_script" in "~/"*) task_script="$HOME/${task_script#\~/}" ;; esac
    [ -x "$task_script" ] || refuse "le script de tâche isolée est introuvable (${task_script:-non configuré})."
    # Rule of the host (2026-10-06): no container starts while a CI run is in
    # progress, and the task script starts three.
    running=$(gh run list --limit 30 --json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo unknown)
    [ "$running" = 0 ] || refuse "une CI est en cours ou son état est illisible ($running) : aucun conteneur ne démarre pendant une CI."
    git diff --quiet HEAD || refuse "la copie de travail a des modifications non commitées."

    set +e
    "$task_script" "$PWD" "$prompt_file" "$model" > >(tee "$out") 2> >(tee "$err" >&2)
    code=$?
    set -e
    wait
    if [ "$code" != 0 ] && grep -q -E '^(Refus|Refused)' "$err"; then
      {
        grep -E '^(Refus|Refused)' "$err" | tail -n 1
        echo
        echo "Ce que le garde-fou a relevé (emplacements seulement, jamais la valeur) :"
        echo
        grep -E ': (secret|adresse|terme|IBAN)' "$err" | sed -E 's#^/tmp/[^/]+/repo/##; s/^/- /' | head -n 30
      } > "$body"
      cat "$body" >&2
      contract_usage '{}'
      contract_report codex 3 "$body"
      exit 3
    fi
    # The task script prints the last message twice (the CLI, then its file).
    half=$(( $(wc -c < "$out") / 2 ))
    if [ "$half" -gt 0 ] && cmp -s <(head -c "$half" "$out") <(tail -c "$half" "$out"); then head -c "$half" "$out" > "$body"; else cp "$out" "$body"; fi
    [ -s "$body" ] || echo "Codex n'a rendu aucun texte (code $code)." > "$body"
    # The CLI only prints a total in this mode: the split stays empty.
    total=$(grep -A1 '^tokens used' "$err" | tail -n 1 | tr -dc '0-9')
    contract_usage "$(jq -nc --arg total "$total" '{tokens_total: (if $total == "" then null else ($total | tonumber) end)}')"
    contract_report codex "$code" "$body"
    exit "$code"
    ;;
  *)
    echo "usage: $(basename "$0") list-models [<model>...] | version | run --model <id> --prompt-file <file> --report <file> --usage <file>" >&2
    exit 64
    ;;
esac
