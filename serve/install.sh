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
# The project this copy works on is written where every script finds it: in
# the units (a service has no terminal to inherit it from) and in the one
# line a terminal reads (~/.config/ferme/project). Never the tool itself by
# accident: the project must have been named.
named="${XDG_CONFIG_HOME:-$HOME/.config}/ferme/project"
[ "$ORCH_REPO" != "$(git -C "$ORCH_HOME" rev-parse --show-toplevel 2> /dev/null)" ] || [ -d "$ORCH_REPO/.ferme" ] \
  || die "no project is named: run this with ORCH_REPO=<main checkout of the project>, or write that path in $named"
mkdir -p "$(dirname "$named")"
printf '%s\n' "$ORCH_REPO" > "$named"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
for unit in "$here"/ferme-*.service "$here"/ferme-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|; s|@ORCH_REPO@|$ORCH_REPO|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now ferme-dashboard.service ferme-dashboard-refresh.timer ferme-wake.timer ferme-legacy-import.timer
systemctl --user restart ferme-dashboard.service
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Dashboard: http://$bind:$port/"
