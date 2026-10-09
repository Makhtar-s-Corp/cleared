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
# line a terminal reads (~/.config/ferme/project). One project for the
# machine, and it must have been named: a tool that is a repository of its
# own would otherwise work on itself.
named="${XDG_CONFIG_HOME:-$HOME/.config}/ferme/project"
project=$(cd "$ORCH_REPO" 2> /dev/null && pwd -P) || die "the project ($ORCH_REPO) is not a folder of this machine"
git -C "$project" rev-parse --is-inside-work-tree > /dev/null 2>&1 || die "the project ($project) is not a git checkout"
if [ "$project" = "$(cd "$ORCH_HOME" && pwd -P)" ] && [ ! -d "$project/.ferme" ]; then
  die "no project is named: this copy of the tool would work on itself. Run this with ORCH_REPO=<main checkout of the project>"
fi
known=$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$named" 2> /dev/null || true)
[ -z "$known" ] || [ "$known" = "$project" ] || die "this machine already works on $known ($named): one project for a machine. To move it, remove that file, then run this again"
# What goes into a unit is written as it is: a path systemd or sed would read
# another way is refused, not written half right.
for path in "$ORCH_HOME" "$project" "$ORCH_STATE_DIR"; do
  case "$path" in *[\ \|\&%\"\'\\]* | *$'\n'*) die "\"$path\" cannot be written in a unit as it is (a blank, |, &, %, a quote or a backslash): move it" ;; esac
done
# Two wakes never run on one machine: the units of a project that carried
# its own copy of the tool (orchestration-*) are stopped by whoever
# switches, not here, so that going back is one command too.
# (Waking: its timer enabled, or its timer or its service running now. The
# service a timer starts is « static » for systemd whether the timer is on
# or off: that says nothing.)
case "$(systemctl --user is-enabled orchestration-wake.timer 2> /dev/null || true)" in enabled*) waking=1 ;; *) waking= ;; esac
if [ -n "$waking" ] || systemctl --user is-active --quiet orchestration-wake.timer 2> /dev/null || systemctl --user is-active --quiet orchestration-wake.service 2> /dev/null; then
  die "an older copy of the tool still wakes on this machine (orchestration-wake.timer): stop it first (systemctl --user disable --now orchestration-wake.timer orchestration-dashboard.service orchestration-dashboard-refresh.timer orchestration-legacy-import.timer), then run this again"
fi
mkdir -p "$(dirname "$named")"
printf '%s\n' "$project" > "$named"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
for unit in "$here"/ferme-*.service "$here"/ferme-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|; s|@ORCH_REPO@|$project|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now ferme-dashboard.service ferme-dashboard-refresh.timer ferme-wake.timer ferme-legacy-import.timer
systemctl --user restart ferme-dashboard.service
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Dashboard: http://$bind:$port/"
