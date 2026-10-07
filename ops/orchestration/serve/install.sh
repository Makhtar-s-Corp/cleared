#!/usr/bin/env bash
# Installs what serves the dashboard to the Tailscale network only: a systemd
# user unit for the page, another with its timer to write it again. No
# administrator rights, no container, no proxy. Then checks who can reach it.
# Run it again from another checkout to move both units there.
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
for unit in orchestration-dashboard.service orchestration-dashboard-refresh.service orchestration-dashboard-refresh.timer; do
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now orchestration-dashboard.service orchestration-dashboard-refresh.timer
systemctl --user restart orchestration-dashboard.service
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Dashboard: http://$bind:$port/"
