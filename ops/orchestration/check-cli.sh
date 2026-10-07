#!/usr/bin/env bash
# Weekly check of the CLIs behind the adapters: one that is more than
# cli_max_days_behind days behind its latest release is written to the ledger
# (event cli_outdated), where the daily digest picks it up. Meant to be called
# at every wake of the dispatcher: it does nothing if it ran in the last week.
#
#   check-cli.sh [--force]
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

stamp="$ORCH_STATE_DIR/cli-versions.json"
mkdir -p "$ORCH_STATE_DIR"
if [ "${1:-}" != --force ] && [ -f "$stamp" ] && [ $(( $(date +%s) - $(stat -c %Y "$stamp") )) -lt 604800 ]; then
  exit 0
fi
max=$(conf_get limits cli_max_days_behind)
ledger init > /dev/null
versions='[]'
for adapter in "$ORCH_HOME"/adapters/*.sh; do
  name=$(basename "$adapter" .sh)
  adapter_env "$name"
  line=$("$adapter" version < /dev/null 2>/dev/null || true)
  [ -n "$line" ] || line=$(jq -nc --arg cli "$name" '{cli: $cli, installed: null, latest: null, days_behind: null}')
  versions=$(jq -c --argjson line "$line" '. + [$line]' <<<"$versions")
  behind=$(jq -r '.days_behind // empty' <<<"$line")
  if [ -n "$behind" ] && [ "$behind" -gt "$max" ]; then
    ledger event --kind cli_outdated --value "$behind" \
      --detail "$(jq -r '"\(.cli) \(.installed), latest \(.latest): \(.days_behind) days behind"' <<<"$line")"
  fi
done
jq -n --argjson versions "$versions" --arg at "$(now_utc)" --argjson max "$max" '{checked_at: $at, max_days_behind: $max, versions: $versions}' > "$stamp"
cat "$stamp"
