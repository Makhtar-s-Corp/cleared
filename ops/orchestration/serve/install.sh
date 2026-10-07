#!/usr/bin/env bash
# Installs the systemd user units of the dispatcher, with no administrator
# rights, no container and no proxy:
#   - the dashboard, served to the Tailscale network only, and the timer that
#     writes it again;
#   - the wake of the project lead, every minute;
#   - the hourly reading of the old sessions into the ledger.
# Then checks who can reach the dashboard. Run it again from another checkout
# to move every unit there.
#
#   serve/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"

port=${ORCH_DASHBOARD_PORT:-8787}
bind=$(tailscale ip -4 | head -n 1)
[ -n "$bind" ] || die "the Tailscale address of this machine could not be read"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
for unit in "$here"/orchestration-*.service "$here"/orchestration-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now orchestration-dashboard.service orchestration-dashboard-refresh.timer orchestration-wake.timer orchestration-legacy-import.timer
systemctl --user restart orchestration-dashboard.service
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Dashboard: http://$bind:$port/"
