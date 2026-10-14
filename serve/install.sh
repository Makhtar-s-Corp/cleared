#!/usr/bin/env bash
# Installs the systemd user units of the dispatcher, with no administrator
# rights, no container and no proxy:
#   - the dashboard, served to the Tailscale network only, and the timer that
#     writes it again;
#   - the wake of the project lead, every minute;
#   - the hourly reading of the old sessions into the ledger.
# Before any unit, it proves that each harness model the configuration can
# start answers, asked as a lane asks it (serve/check-harness.sh; one small
# request per model, on the subscription; CLEARED_SKIP_HARNESS_PROBE=1 skips
# it on a host that cannot reach the providers). Then checks who can reach the dashboard. Run it again from another checkout
# to move every unit there while the wake timer is stopped.
#
#   serve/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"
. "$here/../lib/contract.sh"

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
chmod go-w "$named"
# The agent-to-service lead bridge reads this fixed service-owned pointer,
# independent of an agent-supplied XDG_CONFIG_HOME.
service_named="$HOME/.config/cleared/project"
mkdir -p "$(dirname "$service_named")"
chmod go-w "$(dirname "$service_named")"
if [ "$named" != "$service_named" ]; then
  printf '%s\n' "$project" > "$service_named"
  chmod go-w "$service_named"
fi
printf '%s\n' "$ORCH_STATE_DIR" > "$HOME/.config/cleared/state"
chmod go-w "$HOME/.config/cleared/state"
mkdir -p "$units" "$ORCH_STATE_DIR/dashboard"
# The service keeps its state private. Account creation and sudo grants are
# administrator actions, never an installer side effect.
agent_user=$(conf_get security agent_user)
command -v python3 > /dev/null || die "Install Python 3 for the local socket peer-UID check"
if [ -n "$agent_user" ]; then
  getent passwd "$agent_user" > /dev/null || die "Create [security] agent_user=$agent_user first; see docs/security.md"
  [ "$(id -u "$agent_user")" != "$(id -u)" ] || die "agent_user must differ from the service account"
  bwrap_path=$(conf_get security bwrap_path)
  bwrap_path=${bwrap_path:-/usr/bin/bwrap}
  [ -x "$bwrap_path" ] || die "Install bubblewrap or set [security] bwrap_path to its executable; see docs/security.md"
  [ -n "$(conf_get security socket_path)" ] || die "Set [security] socket_path to a shared local Unix path; see docs/security.md"
  socket_parent=$(dirname "$(conf_get security socket_path)")
  [ -d "$socket_parent" ] || die "Create the service-owned socket directory $socket_parent first"
  [ "$(stat -c %u "$socket_parent")" = "$(id -u)" ] || die "Socket directory must belong to the service account"
  socket_mode=$(stat -c %a "$socket_parent")
  (( (8#$socket_mode & 022) == 0 )) || die "Socket directory must not be group/world-writable"
  if sudo -n -u "$agent_user" -- test -w "$socket_parent" 2>/dev/null; then
    die "$agent_user can write the socket directory $socket_parent"
  fi
  if ! sudo -n -u "$agent_user" -- true 2>/dev/null; then
    die "Configure noninteractive sudo from the service account to $agent_user for the harness CLIs; see docs/security.md"
  fi
  for protected in "$ORCH_STATE_DIR" "$ORCH_HOME" "$project" "$ORCH_CONF" "$HOME" "$HOME/.config/cleared" "$HOME/.local/bin"; do
    [ -e "$protected" ] || continue
    if sudo -n -u "$agent_user" -- test -w "$protected" 2>/dev/null; then
      die "$agent_user can write protected path $protected: remove that access before installing"
    fi
  done
  probe=$(sudo -n -u "$agent_user" -- mktemp "$ORCH_STATE_DIR/.agent-write-probe.XXXXXX" 2>/dev/null || true)
  if [ -n "$probe" ]; then rm -f "$probe"; die "$agent_user wrote to Cleared state; remove that access before installing"; fi
  writable=$(sudo -n -u "$agent_user" -- find "$ORCH_STATE_DIR" -writable -print -quit 2>/dev/null || true)
  [ -z "$writable" ] || die "$agent_user can write Cleared state path $writable"
  # The door of the heavy commands (when-free.sh, lib/common.sh): the teams
  # take it with flock on a descriptor opened read-only, so it lives outside
  # the state, in a directory of this account that $agent_user may traverse
  # and not write, and the file is readable by it and writable by nobody
  # else. The host status the service writes for the teams sits next to it.
  heavy_lock=$(conf_get lanes heavy_lock) || heavy_lock=
  if [ -z "$heavy_lock" ]; then
    [ -z "$(conf_get lanes heavy_commands)" ] || die "Set [lanes] heavy_lock to an absolute path outside Cleared state, in a directory this account owns and $agent_user can traverse but not write (for example $socket_parent/heavy.lock): the teams' heavy commands cannot open a door in the state; see docs/configuration.md"
  else
    case "$heavy_lock" in /*) ;; *) die "[lanes] heavy_lock must be an absolute path, not \"$heavy_lock\" (no ~: the agents' account has another home)" ;; esac
    ! heavy_lock_in_state "$heavy_lock" || die "[lanes] heavy_lock ($heavy_lock) is inside Cleared state, which $agent_user must not open: name a file in a service-owned directory outside it"
    heavy_dir=$(dirname "$heavy_lock")
    [ -d "$heavy_dir" ] || die "Create the service-owned directory of [lanes] heavy_lock first: $heavy_dir (traversable by $agent_user, writable by this account only)"
    [ "$(stat -c %u "$heavy_dir")" = "$(id -u)" ] || die "The directory of [lanes] heavy_lock ($heavy_dir) must belong to the service account"
    heavy_mode=$(stat -c %a "$heavy_dir")
    (( (8#$heavy_mode & 022) == 0 )) || die "The directory of [lanes] heavy_lock ($heavy_dir) must not be group/world-writable"
    [ ! -L "$heavy_lock" ] || die "[lanes] heavy_lock ($heavy_lock) must not be a symbolic link"
    [ -e "$heavy_lock" ] || (umask 022 && : >> "$heavy_lock") || die "[lanes] heavy_lock ($heavy_lock) could not be created"
    [ -f "$heavy_lock" ] || die "[lanes] heavy_lock ($heavy_lock) must be a regular file"
    [ "$(stat -c %u "$heavy_lock")" = "$(id -u)" ] || die "[lanes] heavy_lock ($heavy_lock) must belong to the service account"
    chmod 0644 "$heavy_lock"
    host_status_write '{}' || die "the host status next to [lanes] heavy_lock could not be written in $heavy_dir"
    if sudo -n -u "$agent_user" -- test -w "$heavy_dir" 2>/dev/null; then
      die "$agent_user can write the directory of [lanes] heavy_lock ($heavy_dir): it may open the door for reading, nothing more"
    fi
    # Nor any directory above it: one it could write would let it move that
    # directory aside and put a door and a host status of its own in its place.
    heavy_up=$heavy_dir
    while [ "$heavy_up" != / ]; do
      heavy_up=$(dirname "$heavy_up")
      if sudo -n -u "$agent_user" -- test -w "$heavy_up" 2>/dev/null; then
        die "$agent_user can write $heavy_up, above the directory of [lanes] heavy_lock: it could put a door and a host status of its own in place of $heavy_dir; choose a directory whose parents it cannot write"
      fi
    done
    for heavy_file in "$heavy_lock" "$(host_status_path)"; do
      if sudo -n -u "$agent_user" -- test -w "$heavy_file" 2>/dev/null; then
        die "$agent_user can write $heavy_file: it may read it, nothing more"
      fi
    done
    sudo -n -u "$agent_user" -- test -r "$(host_status_path)" 2>/dev/null || die "$agent_user cannot read the host status $(host_status_path): grant traversal of $heavy_dir and read access"
    # As when-free.sh does it: opened read-only, then flock (the door may be
    # held by a session at work: it is waited for, a while).
    if ! said=$(cd / && sudo -n -u "$agent_user" -- bash -c 'exec 8< "$1" && flock -w 60 8' _ "$heavy_lock" 2>&1); then
      die "$agent_user cannot open [lanes] heavy_lock ($heavy_lock) read-only and take its lock: grant traversal of $heavy_dir and read access to the file, or run this again if a session held it for a minute ($(contract_probe_reason <<<"${said:-nothing}"))"
    fi
  fi
  # The human's own accesses (tracker tokens, signing key, passkeys) and the app's access token belong to this
  # account alone: the agents' account must read none of them, nor traverse their directory.
  human_dir=$(conf_get app human_credentials_dir) || human_dir=
  human_dir=${human_dir:-${XDG_CONFIG_HOME:-$HOME/.config}/cleared/human}; human_dir=${human_dir/#\~/$HOME}
  app_token=$(conf_get app token_file) || app_token=
  app_token=${app_token:-${XDG_CONFIG_HOME:-$HOME/.config}/cleared/app-token}; app_token=${app_token/#\~/$HOME}
  for secret in "$human_dir" "$human_dir/credentials.json" "$human_dir/passkeys.json" "$human_dir/human-signing.key" "$app_token"; do
    [ -e "$secret" ] || continue
    if sudo -n -u "$agent_user" -- test -r "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -x "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -w "$secret" 2>/dev/null; then
      die "$agent_user can reach $secret: the human's accesses and the app token must be closed to it (mode 0700 / 0600, owned by this account)"
    fi
  done
  # The forge's app key and its installation token (docs/security.md, Identities and approval) are this account's alone too.
  while IFS= read -r secret; do
    [ -e "$secret" ] || continue
    if sudo -n -u "$agent_user" -- test -r "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -x "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -w "$secret" 2>/dev/null; then
      die "$agent_user can reach $secret: the forge's app key and token must be closed to it (mode 0600, owned by this account)"
    fi
  done < <(forge_secret_paths)
  grant_socket=$(conf_get app grant_socket) || grant_socket=
  if [ -n "$grant_socket" ] && sudo -n -u "$agent_user" -- test -w "$(dirname "$grant_socket")" 2>/dev/null; then
    die "$agent_user can write the directory of [app] grant_socket"
  fi
  for protected in "$ORCH_HOME" "$project"; do
    writable=$(sudo -n -u "$agent_user" -- find "$protected" -writable -print -quit 2>/dev/null || true)
    [ -z "$writable" ] || die "$agent_user can write protected path $writable"
  done
  if ! sudo -n -u "$agent_user" -- test -r "$ORCH_HOME/release-request.mjs" 2>/dev/null; then
    die "$agent_user cannot read the release client: grant read and path traversal, not write"
  fi
  # The probes that start node as the agents' account run from /: the folder
  # this was started from may be closed to that account, and node would then
  # fail on its current directory instead of on what is probed (#87). The
  # first line node wrote is part of the message.
  if ! said=$(cd / && sudo -n -u "$agent_user" -- env ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
    node "$ORCH_HOME/lead-command.mjs" ping 2>&1 > /dev/null); then
    die "Configure the narrow agent-to-service sudo rule for serve/lead-actions.mjs; see docs/security.md (the lead client as $agent_user said: $(contract_probe_reason <<<"${said:-nothing}"))"
  fi
  # NODE_OPTIONS runs before lead-actions.mjs can scrub the environment. Prove
  # sudoers drops it, including when an agent explicitly asks sudo to keep env.
  env_probe=$(mktemp -d)
  chmod 755 "$env_probe"
  : > "$env_probe/marker"
  chmod 600 "$env_probe/marker"
  cat > "$env_probe/probe.cjs" <<EOF
if (process.getuid() === $(id -u)) require('node:fs').writeFileSync('$env_probe/marker', 'injected');
EOF
  chmod 644 "$env_probe/probe.cjs"
  said=$(cd / && sudo -n -u "$agent_user" -- env NODE_OPTIONS="--require=$env_probe/probe.cjs" ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
    node "$ORCH_HOME/lead-command.mjs" ping 2>&1 > /dev/null) || die "The lead client failed the sudo environment probe: $(contract_probe_reason <<<"${said:-nothing}")"
  # From / too: a node stopped by its current directory would leave the
  # marker untouched and prove nothing.
  (cd / && sudo -n -u "$agent_user" -- env NODE_OPTIONS="--require=$env_probe/probe.cjs" \
    sudo -n -E -u "$(id -un)" /usr/bin/node "$ORCH_HOME/serve/lead-actions.mjs" ping > /dev/null 2>&1) || true
  [ ! -s "$env_probe/marker" ] || die "The reverse sudo rule preserves NODE_OPTIONS; require env_reset and forbid SETENV"
  rm -f "$env_probe/marker" "$env_probe/probe.cjs"
  rmdir "$env_probe"
fi
# Each harness model the configuration can start answers, asked as a lane
# asks it (under the agents' account when there is one), before any unit is
# written or started: serve/check-harness.sh, one small request per model on
# the subscription. A host that cannot reach the providers skips it, loudly.
if [ "${CLEARED_SKIP_HARNESS_PROBE:-}" = 1 ]; then
  echo "WARNING: CLEARED_SKIP_HARNESS_PROBE=1: the harness models were NOT probed. Nothing proves that a lane can start${agent_user:+ under $agent_user}; run serve/check-harness.sh once this host can reach the providers." >&2
else
  # The table goes out as it is printed; what it says on its error output is kept for the message.
  { harness_said=$("$here/check-harness.sh" 2>&1 >&3) && harness_code=0 || harness_code=$?; } 3>&1
  if [ "$harness_code" != 0 ]; then
    [ -z "$harness_said" ] || printf '%s\n' "$harness_said" >&2
    harness_first=$(sed -n '1{s/^check-harness\.sh: //;p;}' <<<"$harness_said")
    die "harness probe failed: ${harness_first:-serve/check-harness.sh exited $harness_code}. No unit was installed or started. Sign the CLI in${agent_user:+ as $agent_user} (or fix [models]) and run this again; on a host that cannot reach the providers, CLEARED_SKIP_HARNESS_PROBE=1 skips the probe"
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
  reachable= said=
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if said=$(cd / && sudo -n -u "$agent_user" -- env ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
      node "$ORCH_HOME/release-request.mjs" status TEST-0 2>&1 > /dev/null); then reachable=1; break; fi
    sleep 0.2
  done
  [ -n "$reachable" ] || die "$agent_user cannot reach the release socket; check [security] socket_path and directory traversal (the release client said: $(contract_probe_reason <<<"${said:-nothing}"))"
fi
"$ORCH_HOME/dashboard.sh" > /dev/null
sleep 1
"$here/check.sh"
echo "Cleared app: http://$bind:$app_port/login (the old dashboard address now redirects there)"
echo "Access token: run '$ORCH_HOME/cleared app --bind $bind --link' on this machine to print the sign-in address; the token file stays outside the project."
[ -n "$agent_user" ] || echo "release lock is not a security boundary: agents run as the service account"
