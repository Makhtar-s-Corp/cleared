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

port=${CLEARED_DASHBOARD_PORT:-${ORCH_DASHBOARD_PORT:-8787}}
bind=$(tailscale ip -4 | head -n 1)
[ -n "$bind" ] || die "the Tailscale address of this machine could not be read"
# The project this copy works on is written where every script finds it: in
# the units (a service has no terminal to inherit it from) and in the one
# line a terminal reads (~/.config/ferme/project). One project for the
# machine, and it must have been named: a tool that is a repository of its
# own would otherwise work on itself.
named="${XDG_CONFIG_HOME:-$HOME/.config}/cleared/project"
project=$(cd "$ORCH_REPO" 2> /dev/null && pwd -P) || die "the project ($ORCH_REPO) is not a folder of this machine"
git -C "$project" rev-parse --is-inside-work-tree > /dev/null 2>&1 || die "the project ($project) is not a git checkout"
if [ "$project" = "$(cd "$ORCH_HOME" && pwd -P)" ] && [ ! -d "$project/.cleared" ] && [ ! -d "$project/.ferme" ]; then
  die "no project is named: this copy of the tool would work on itself. Run this with ORCH_REPO=<main checkout of the project>"
fi
known=$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$cleared_project_file" 2> /dev/null || true)
[ -z "$known" ] || [ "$known" = "$project" ] || die "this machine already works on $known ($named): one project for a machine. To move it, remove that file, then run this again"
guard_ref=${ORCH_GUARD_REF:-$(git -C "$project" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2> /dev/null || true)}
guard_ref=${guard_ref:-origin/main}
guard_settings=$(mktemp)
trap 'rm -f "$guard_settings"' EXIT
if git -C "$project" cat-file -e "$guard_ref:.cleared/agents.conf" 2> /dev/null; then
  git -C "$project" show "$guard_ref:.cleared/agents.conf" > "$guard_settings"
elif git -C "$project" cat-file -e "$guard_ref:.ferme/agents.conf" 2> /dev/null; then
  git -C "$project" show "$guard_ref:.ferme/agents.conf" > "$guard_settings"
fi
if [ -z "$(conf_get_from guard salt "$guard_settings" 2> /dev/null || true)" ]; then
  echo 'Add [guard] salt = <random value> to the project agents.conf and commit it; the installer will not write it.' >&2
  terms=$(conf_get_from guard terms "$guard_settings" 2> /dev/null || true)
  allowed=$(conf_get_from guard allowed "$guard_settings" 2> /dev/null || true)
  if { [ -n "$terms" ] && [ "$terms" != none ]; } || { [ -n "$allowed" ] && [ "$allowed" != none ]; }; then
    die 'fingerprint lists are configured but their salt is not committed; no services were installed'
  fi
fi
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
units="$HOME/.config/systemd/user"
# Stop every installed legacy unit before publishing or enabling new units.
# Stop timers first, then let an active wake finish before stopping services.
# Preserve the old unit files so the operator can roll back.
legacy_units=(ferme-wake.service ferme-wake.timer)
for old in "$units"/ferme-*.service "$units"/ferme-*.timer; do
  [ -f "$old" ] || continue
  unit=$(basename "$old")
  case " ${legacy_units[*]} " in *" $unit "*) ;; *) legacy_units+=("$unit") ;; esac
done
while read -r unit _; do
  case "$unit" in ferme-*.service | ferme-*.timer)
    case " ${legacy_units[*]} " in *" $unit "*) ;; *) legacy_units+=("$unit") ;; esac
    ;; esac
done < <(systemctl --user list-unit-files --no-legend 'ferme-*' 2> /dev/null)
while read -r unit _; do
  case "$unit" in ferme-*.service | ferme-*.timer)
    case " ${legacy_units[*]} " in *" $unit "*) ;; *) legacy_units+=("$unit") ;; esac
    ;; esac
done < <(systemctl --user list-units --all --no-legend 'ferme-*' 2> /dev/null)
stop_legacy_unit() {
  local unit=$1
  if [ ! -f "$units/$unit" ] && ! systemctl --user is-active --quiet "$unit" 2> /dev/null && ! systemctl --user is-enabled "$unit" > /dev/null 2>&1; then
    return 0
  fi
  if ! systemctl --user stop "$unit"; then
    die "could not stop legacy unit $unit; resolve it with systemctl --user status $unit and rerun the installer"
  fi
  if ! systemctl --user disable "$unit"; then
    die "could not disable legacy unit $unit; resolve it with systemctl --user status $unit and rerun the installer"
  fi
}
for unit in "${legacy_units[@]}"; do
  case "$unit" in *.timer) stop_legacy_unit "$unit" ;; esac
done
for attempt in {1..30}; do
  systemctl --user is-active --quiet ferme-wake.service 2> /dev/null || break
  [ "$attempt" -lt 30 ] || die "legacy wake is still active; wait for ferme-wake.service to finish before rerunning the installer"
  sleep 1
done
for unit in "${legacy_units[@]}"; do
  case "$unit" in *.service) stop_legacy_unit "$unit" ;; esac
done
mkdir -p "$(dirname "$named")"
printf '%s\n' "$project" > "$named"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
for unit in "$here"/cleared-*.service "$here"/cleared-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|; s|@ORCH_REPO@|$project|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
# A legacy installation may still have timers enabled. Keep the unit files so
# rollback stays possible, but do not run two dispatchers for one project.
systemctl --user enable --now cleared-dashboard.service cleared-dashboard-refresh.timer cleared-wake.timer cleared-legacy-import.timer
systemctl --user restart cleared-dashboard.service
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Dashboard: http://$bind:$port/"
