#!/usr/bin/env bash
# Installs the systemd user units of Cleared, with no administrator rights,
# no container and no proxy: the release broker, the wake every minute, and
# the app, served to the Tailscale network only. Run it again from another
# checkout to move every unit there while the wake timer is stopped.
# Before anything is written, every port it binds or tells to publish is
# checked (lib/ports.sh): never 80 or 443, never a port something else
# listens on. No setting turns that off (#112).
#
#   serve/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../lib/common.sh"

# contract_probe_reason < text: the line of it that says why, cut short: the
# first one that names an error (error, failed, denied, not logged,
# unauthorized, invalid, refused), else the first that says something (a
# warning or a stack frame often comes before the error). Whatever looks like
# a key or a token is hidden: a word starting with sk-, a run of 24 or more of
# A-Z a-z 0-9 _ + / = . - with both cases and a digit (base64, JWT, most
# keys), or one of 32 or more letters and digits only, with a digit (hex). A
# path stays readable (a piece of it that looks like a key does not), and so
# do model ids, error names and words joined by hyphens.
contract_probe_reason() {
  tr -d '\r' | awk '
    function secret(t) {
      if (t ~ /^sk-/ && length(t) >= 20) return 1
      if (length(t) >= 24 && t ~ /[a-z]/ && t ~ /[A-Z]/ && t ~ /[0-9]/) return 1
      return length(t) >= 32 && t ~ /^[A-Za-z0-9]+$/ && t ~ /[0-9]/ && t ~ /[A-Za-z]/
    }
    function hide(t,   n, part, i, out) {
      if (t !~ /^\.?\//) return secret(t) ? "[hidden]" : t
      n = split(t, part, "/"); out = part[1]
      for (i = 2; i <= n; i++) out = out "/" (secret(part[i]) ? "[hidden]" : part[i])
      return out
    }
    function clean(line,   out) {
      out = ""
      while (match(line, /[A-Za-z0-9_+\/=.-]+/)) {
        out = out substr(line, 1, RSTART - 1) hide(substr(line, RSTART, RLENGTH))
        line = substr(line, RSTART + RLENGTH)
      }
      return out line
    }
    /[^[:space:]]/ {
      if (!seen++) first = $0
      if (tolower($0) ~ /error|failed|denied|not logged|unauthorized|invalid|refused/) { said = $0; found = 1; exit }
    }
    END {
      if (!found) said = first
      if (!found && !seen) exit
      said = clean(said)
      sub(/^[[:space:]]+/, "", said)
      print said
    }' | cut -c1-200
}


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
# The ports, before the first write: the dashboard's and the app's, [app]
# port, the port of [app] public_origin (the one tailscale serve publishes,
# 443 when none is written) and of the notifications' link (this shell's, and
# the drop-ins' of cleared-wake.service and cleared-app.service). 80 and 443
# are refused outright, a port held by anything but this installation's own
# unit (or, for public_origin, tailscale serve) too, and so is a machine whose
# listening ports cannot be read.
. "$here/../lib/ports.sh"
public_origin=$(conf_get app public_origin) || public_origin=
app_conf_port=$(conf_get app port) || app_conf_port=
ports_install_check "$port" "$app_port" "$app_conf_port" "$public_origin" "${CLEARED_NOTIFY_LINK_BASE:-}" "$bind" "$units" "${ORCH_NOTIFY_LINK_BASE:-}" \
  || die "a port check failed (above): nothing was written, no unit was touched"
# Behind tailscale serve (an https public_origin) the app listens on [app] bind, this machine only by default (app/main.mjs).
app_address=$bind
if ports_https "$public_origin"; then app_address=$(conf_get app bind) || app_address=; app_address=${app_address:-127.0.0.1}; fi
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
mkdir -p "$units" "$ORCH_STATE_DIR"
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
  # The notification secrets (Web Push keys, the browsers' subscriptions, the adapters' credentials: docs/notifications.md) too.
  notify_dir=$(conf_get notify secrets_dir) || notify_dir=
  notify_dir=${notify_dir:-${XDG_CONFIG_HOME:-$HOME/.config}/cleared/notify}; notify_dir=${notify_dir/#\~/$HOME}
  for secret in "$notify_dir" "$notify_dir/vapid.json" "$notify_dir/subscriptions.json" "$notify_dir/credentials.json"; do
    [ -e "$secret" ] || continue
    if sudo -n -u "$agent_user" -- test -r "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -x "$secret" 2>/dev/null || sudo -n -u "$agent_user" -- test -w "$secret" 2>/dev/null; then
      die "$agent_user can reach $secret: the notification secrets must be closed to it (mode 0700 / 0600, owned by this account)"
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
fi
chmod o-w "$ORCH_STATE_DIR"
for unit in "$here"/cleared-*.service "$here"/cleared-*.timer; do
  unit=$(basename "$unit")
  sed -e "s|@PORT@|$port|; s|@APP_PORT@|$app_port|; s|@BIND@|$bind|; s|@ORCH_HOME@|$ORCH_HOME|; s|@ORCH_REPO@|$project|" "$here/$unit" > "$units/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now cleared-release-broker.service cleared-wake.timer cleared-app.service
systemctl --user restart cleared-release-broker.service cleared-app.service
if [ -n "$agent_user" ]; then
  reachable= said=
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if said=$(cd / && sudo -n -u "$agent_user" -- env ORCH_REPO="$project" ORCH_CONF="$ORCH_CONF" ORCH_STATE_DIR="$ORCH_STATE_DIR" \
      node "$ORCH_HOME/release-request.mjs" status TEST-0 2>&1 > /dev/null); then reachable=1; break; fi
    sleep 0.2
  done
  [ -n "$reachable" ] || die "$agent_user cannot reach the release socket; check [security] socket_path and directory traversal (the release client said: $(contract_probe_reason <<<"${said:-nothing}"))"
fi
if [ -n "$(ports_serve_hint "$public_origin" "$app_address" "$app_port")" ]; then
  echo "Cleared app: $public_origin/login, once it is published on the Tailscale network, if not done yet (never on 443: docs/app.md):"
  echo "  $(ports_serve_hint "$public_origin" "$app_address" "$app_port")"
else
  echo "Cleared app: http://$bind:$app_port/login"
fi
echo "Access token: run '$ORCH_HOME/cleared app --bind $bind --link' on this machine to print the sign-in address; the token file stays outside the project."
[ -n "$agent_user" ] || echo "release lock is not a security boundary: agents run as the service account"
# The units do not read this shell: the link is set by a drop-in on cleared-wake.service (docs/notifications.md, Service environment).
[ -n "${CLEARED_NOTIFY_LINK_BASE:-}" ] || echo "WARNING: CLEARED_NOTIFY_LINK_BASE is not set in this shell: notifications will have no link, and Web Push will report no_subject, until a drop-in sets it for cleared-wake.service (docs/notifications.md, Service environment)." >&2
