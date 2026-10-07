#!/usr/bin/env bash
# Installs what serves the dashboard on the Tailscale network only: two
# systemd user units and a timer (no administrator rights), and prepares the
# route of the Coolify proxy, which an administrator copies in place.
# Run it again from another checkout to move the refresh there.
#
#   serve/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"

port=8787
bind=$(docker network inspect coolify --format '{{(index .IPAM.Config 0).Gateway}}')
address=$(tailscale ip -4 | head -n 1)
[ -n "$bind" ] && [ -n "$address" ] || die "the gateway of the coolify network or the Tailscale address could not be read"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
for unit in orchestration-dashboard.service orchestration-dashboard-refresh.service orchestration-dashboard-refresh.timer; do
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now orchestration-dashboard.service orchestration-dashboard-refresh.timer
systemctl --user restart orchestration-dashboard.service

route="$ORCH_STATE_DIR/orchestration-dashboard.yaml"
sed -e "s|TAILSCALE_IP|$address|; s|@BIND@|$bind|; s|@PORT@|$port|" "$here/orchestration-dashboard.yaml" > "$route"
echo "Units installed. The proxy route still needs an administrator:"
echo "  sudo cp $route /data/coolify/proxy/dynamic/"
echo "Then: http://orchestration.$address.sslip.io/"
