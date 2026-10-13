#!/usr/bin/env bash
# Installs the systemd user units of the dispatcher, with no administrator
# rights, no container and no proxy:
#   - the dashboard, served to the Tailscale network only, and the timer that
#     writes it again;
#   - the wake of the project lead, every minute;
#   - the hourly reading of the old sessions into the ledger.
# Then checks who can reach the dashboard. Run it again from another checkout
# to move every unit there while the wake timer is stopped.
#
#   serve/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"

port=${CLEARED_DASHBOARD_PORT:-8787}
app_port=${CLEARED_APP_PORT:-8788}
bind=$(tailscale ip -4 | head -n 1)
[ -n "$bind" ] || die "the Tailscale address of this machine could not be read"
# The project this copy works on is written where every script finds it: in
# the units (a service has no terminal to inherit it from) and in the one
# line a terminal reads (~/.config/cleared/project). One project for the
# machine, and it must have been named: a tool that is a repository of its
# own would otherwise work on itself.
named="${XDG_CONFIG_HOME:-$HOME/.config}/cleared/project"
project=$(cd "$ORCH_REPO" 2> /dev/null && pwd -P) || die "the project ($ORCH_REPO) is not a folder of this machine"
git -C "$project" rev-parse --is-inside-work-tree > /dev/null 2>&1 || die "the project ($project) is not a git checkout"
if [ "$project" = "$(cd "$ORCH_HOME" && pwd -P)" ] && [ ! -d "$project/.cleared" ]; then
  die "no project is named: this copy of the tool would work on itself. Run this with ORCH_REPO=<main checkout of the project>"
fi
known=$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$cleared_project_file" 2> /dev/null || true)
[ -z "$known" ] || [ "$known" = "$project" ] || die "this machine already works on $known ($named): one project for a machine. To move it, remove that file, then run this again"
# What goes into a unit is written as it is: a path systemd or sed would read
# another way is refused, not written half right.
for path in "$ORCH_HOME" "$project" "$ORCH_STATE_DIR"; do
  case "$path" in *[\ \|\&%\"\'\\]* | *$'\n'*) die "\"$path\" cannot be written in a unit as it is (a blank, |, &, %, a quote or a backslash): move it" ;; esac
done
guard_ref=${ORCH_GUARD_REF:-$(git -C "$project" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2> /dev/null || true)}
guard_ref=${guard_ref:-origin/main}
guard_settings=$(mktemp)
trap 'rm -f "$guard_settings"' EXIT
git -C "$project" show "$guard_ref:.cleared/agents.conf" > "$guard_settings" 2> /dev/null || die "the committed project configuration (.cleared/agents.conf at $guard_ref) could not be read; no services were installed"
if [ -z "$(conf_get_from guard salt "$guard_settings" 2> /dev/null || true)" ]; then
  echo 'Add [guard] salt = <random value> to the project agents.conf and commit it; the installer will not write it.' >&2
  terms=$(conf_get_from guard terms "$guard_settings" 2> /dev/null || true)
  allowed=$(conf_get_from guard allowed "$guard_settings" 2> /dev/null || true)
  if { [ -n "$terms" ] && [ "$terms" != none ]; } || { [ -n "$allowed" ] && [ "$allowed" != none ]; }; then
    die 'fingerprint lists are configured but their salt is not committed; no services were installed'
  fi
fi
units="$HOME/.config/systemd/user"
if [ "${CLEARED_INSTALL_FROM_WAKE:-}" != 1 ]; then
  case "$(systemctl --user is-enabled cleared-wake.timer 2> /dev/null || true)" in
    enabled*) die "a Cleared wake timer is already active; disable it and wait for cleared-wake.service to finish before installing" ;;
  esac
  if systemctl --user is-active --quiet cleared-wake.timer 2> /dev/null; then
    die "a Cleared wake timer is already active; stop it before installing"
  fi
  wake_state=$(systemctl --user show -p ActiveState --value cleared-wake.service 2> /dev/null) || die "the Cleared wake state could not be read; no services were installed"
  case "$wake_state" in
    inactive|failed) ;;
    *) die "a Cleared wake is already active ($wake_state); wait for cleared-wake.service to finish before installing" ;;
  esac
fi
mkdir -p "$(dirname "$named")"
printf '%s\n' "$project" > "$named"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
# The service keeps its state private. Account creation and sudo grants are
# administrator actions, never an installer side effect.
agent_user=$(conf_get security agent_user)
if [ -n "$agent_user" ]; then
  getent passwd "$agent_user" > /dev/null || die "Create [security] agent_user=$agent_user first; see docs/security.md"
  [ "$(id -u "$agent_user")" != "$(id -u)" ] || die "agent_user must differ from the service account"
  bwrap_path=$(conf_get security bwrap_path)
  bwrap_path=${bwrap_path:-/usr/bin/bwrap}
  [ -x "$bwrap_path" ] || die "Install bubblewrap or set [security] bwrap_path to its executable; see docs/security.md"
  [ -n "$(conf_get security socket_path)" ] || die "Set [security] socket_path to a shared local Unix path; see docs/security.md"
  if ! sudo -n -u "$agent_user" -- true 2>/dev/null; then
    die "Configure noninteractive sudo from the service account to $agent_user for the harness CLIs; see docs/security.md"
  fi
  for protected in "$ORCH_STATE_DIR" "$ORCH_HOME" "$project" "$ORCH_CONF"; do
    if sudo -n -u "$agent_user" -- test -w "$protected" 2>/dev/null; then
      die "$agent_user can write protected path $protected: remove that access before installing"
    fi
  done
  probe=$(sudo -n -u "$agent_user" -- mktemp "$ORCH_STATE_DIR/.agent-write-probe.XXXXXX" 2>/dev/null || true)
  if [ -n "$probe" ]; then rm -f "$probe"; die "$agent_user wrote to Cleared state; remove that access before installing"; fi
  writable=$(sudo -n -u "$agent_user" -- find "$ORCH_STATE_DIR" -writable -print -quit 2>/dev/null || true)
  [ -z "$writable" ] || die "$agent_user can write Cleared state path $writable"
  for protected in "$ORCH_HOME" "$project"; do
    writable=$(sudo -n -u "$agent_user" -- find "$protected" -writable -print -quit 2>/dev/null || true)
    [ -z "$writable" ] || die "$agent_user can write protected path $writable"
  done
  if ! sudo -n -u "$agent_user" -- test -r "$ORCH_HOME/release-request.mjs" 2>/dev/null; then
    die "$agent_user cannot read the release client: grant read and path traversal, not write"
  fi
  if ! sudo -n -u "$agent_user" -- env ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
    node "$ORCH_HOME/lead-command.mjs" ping > /dev/null 2>&1; then
    die "Configure the narrow agent-to-service sudo rule for serve/lead-actions.mjs; see docs/security.md"
  fi
fi
chmod o-w "$ORCH_STATE_DIR"
for unit in "$here"/cleared-*.service "$here"/cleared-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@APP_PORT@|$app_port|; s|@BIND@|$bind|; s|@DASHBOARD_DIR@|$ORCH_STATE_DIR/dashboard|; s|@ORCH_HOME@|$ORCH_HOME|; s|@ORCH_REPO@|$project|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now cleared-release-broker.service cleared-dashboard.service cleared-dashboard-refresh.timer cleared-wake.timer cleared-legacy-import.timer cleared-app.service
systemctl --user restart cleared-release-broker.service cleared-dashboard.service cleared-app.service
if [ -n "$agent_user" ]; then
  reachable=
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if sudo -n -u "$agent_user" -- env ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
      node "$ORCH_HOME/release-request.mjs" status TEST-0 > /dev/null 2>&1; then reachable=1; break; fi
    sleep 0.2
  done
  [ -n "$reachable" ] || die "$agent_user cannot reach the release socket; check [security] socket_path and directory traversal"
fi
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Cleared app: http://$bind:$app_port/login (the old dashboard address now redirects there)"
echo "Access token: run '$ORCH_HOME/cleared app --bind $bind --link' on this machine to print the sign-in address; the token file stays outside the project."
[ -n "$agent_user" ] || echo "release lock is not a security boundary: agents run as the service account"
