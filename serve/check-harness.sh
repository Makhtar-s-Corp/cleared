#!/usr/bin/env bash
# Proves that each harness model the project's configuration can start
# answers now: its adapter's `probe` asks the real CLI one small question
# ("Reply with the single word OK.") exactly as a lane starts it (under
# [security] agent_user through sudo and bubblewrap, without API key nor
# forge and tracker credentials, on the subscription), from an empty folder,
# under a timeout (CLEARED_PROBE_TIMEOUT seconds, 120 by default). The models
# are the distinct adapter:model pairs of the aliases named by [roles],
# [rules], [harness] and [review] when_same, and of their [fallbacks]
# (lib/route.mjs configured); an alias nothing names is not asked. One small
# request per model, on the subscription.
#
# serve/install.sh runs it before it installs or starts any unit. It is meant
# to be the first check of a doctor as well, and can be run by hand:
#
#   serve/check-harness.sh     prints a table; exit 1 when a model does not answer
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"
. "$here/../lib/contract.sh"

listed=$(node --no-warnings "$ORCH_HOME/lib/route.mjs" configured) || die "the models of $ORCH_CONF could not be read"
agent_user=$(conf_get security agent_user)
if [ -z "$listed" ]; then
  echo "Harness probe: no model is named by [roles], [rules], [harness] or [review] when_same; nothing to probe."
  exit 0
fi
echo "Harness probe, as ${agent_user:-$(id -un) (no [security] agent_user)}: one small request per model, on the subscription."
said=$(mktemp)
trap 'rm -f "$said"' EXIT
rows=$'ADAPTER\tMODEL\tALIASES\tRESULT'
failed=0
while IFS=$'\t' read -r kind first second third; do
  if [ "$kind" = unknown ]; then
    rows+=$'\n'"-"$'\t'"-"$'\t'"$first"$'\t'"FAIL: not in [models] (named by $second)"
    echo "$(basename "$0"): the alias $first, named by $second, is not in [models]" >&2
    failed=1
    continue
  fi
  adapter=$first model=$second aliases=$third
  code=0
  # Each adapter with its own [adapter.<name>] settings only, as for a run.
  out=$(
    adapter_env "$adapter"
    path="$ORCH_HOME/adapters/$adapter.sh"
    [ -x "$path" ] || { echo "FAIL $model: no adapter for \"$adapter\" (adapters/$adapter.sh)"; exit 1; }
    exec "$path" probe "$model" < /dev/null
  ) 2> "$said" || code=$?
  line=$(grep -m 1 -E "^(ok|FAIL|skip) " <<<"$out" || true)
  case "$line" in
    "ok "*) [ "$code" = 0 ] && result=ok || result="FAIL: the adapter said ok but exited $code" ;;
    "skip "*) result="skip: ${line#skip "$model": }" ;;
    "FAIL "*) result="FAIL: ${line#FAIL "$model": }" ;;
    *)
      reason=$(contract_probe_reason < "$said")
      result="FAIL: ${reason:-the adapter gave no probe answer} (exit $code)"
      ;;
  esac
  rows+=$'\n'"$adapter"$'\t'"$model"$'\t'"$aliases"$'\t'"$result"
  if [[ "$result" == FAIL* ]]; then
    echo "$(basename "$0"): $adapter:$model ($aliases) did not answer${agent_user:+ under $agent_user}: ${result#FAIL: }" >&2
    failed=1
  fi
done <<<"$listed"
awk -F'\t' '
  { for (i = 1; i <= NF; i++) { cell[NR, i] = $i; if (length($i) > width[i]) width[i] = length($i) } }
  END { for (r = 1; r <= NR; r++) printf "  %-" width[1] "s  %-" width[2] "s  %-" width[3] "s  %s\n", cell[r, 1], cell[r, 2], cell[r, 3], cell[r, 4] }' <<<"$rows"
exit "$failed"
