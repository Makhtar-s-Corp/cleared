#!/usr/bin/env bash
# Writes the dashboard again: one static HTML page, built from the ledger.
# Meant to run at every wake of the dispatcher. No container, no framework,
# no script in the page.
#
#   dashboard.sh [<output file>]      default: state/dashboard/index.html
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

out=${1:-$ORCH_STATE_DIR/dashboard/index.html}
mkdir -p "$(dirname "$out")"
ledger init > /dev/null

# Once a week this also checks how far behind the CLIs are.
"$ORCH_HOME/check-cli.sh" > /dev/null || true
cli=$(cat "$ORCH_STATE_DIR/cli-versions.json" 2>/dev/null || echo null)

# What the ledger does not hold: read here, by scripts, never by a model.
# A source that does not answer is written as null and shown as such.
waiting=$("$ORCH_HOME/linear.sh" waiting 2>/dev/null || echo null)
merged=$(cd "$ORCH_REPO" && gh pr list --state merged --search "merged:>=$(date -u -d '7 days ago' +%F)" --limit 500 --json number --jq length 2>/dev/null || echo null)
inputs=$(mktemp)
trap 'rm -f "$inputs"' EXIT
jq -n \
  --argjson waiting "$waiting" \
  --argjson merged "${merged:-null}" \
  --argjson cli "$cli" \
  --argjson lanes "$(dispatcher_lanes | jq -R . | jq -sc .)" \
  --argjson max_lanes "$(conf_get limits max_lanes)" \
  --argjson worktrees "$(git -C "$ORCH_REPO" worktree list --porcelain | grep -c '^branch ')" \
  --argjson load "$(cut -d' ' -f1 /proc/loadavg)" \
  --argjson cores "$(nproc)" \
  --argjson swap_total_kb "$(awk '/^SwapTotal/ {print $2}' /proc/meminfo)" \
  --argjson swap_free_kb "$(awk '/^SwapFree/ {print $2}' /proc/meminfo)" \
  --argjson mem_total_kb "$(awk '/^MemTotal/ {print $2}' /proc/meminfo)" \
  --argjson mem_available_kb "$(awk '/^MemAvailable/ {print $2}' /proc/meminfo)" \
  --arg github_down_since "$(sed -n '1p' "$ORCH_STATE_DIR/wake/github-down" 2> /dev/null || true)" \
  '{waiting: $waiting, merged_prs_7d: $merged, cli: $cli, lanes: $lanes, max_lanes: $max_lanes, worktrees: $worktrees,
    load: $load, cores: $cores, swap_total_kb: $swap_total_kb, swap_free_kb: $swap_free_kb,
    mem_total_kb: $mem_total_kb, mem_available_kb: $mem_available_kb,
    github_down_since: (if $github_down_since == "" then null else $github_down_since end)}' > "$inputs"

node --no-warnings "$ORCH_HOME/lib/dashboard.mjs" "$inputs" > "$out.tmp"
mv "$out.tmp" "$out"
echo "$out"
