# The ports the installation binds or publishes, checked before anything is
# written (serve/install.sh). Sourced, never executed. Issue #112.
#
# Two rules, with no setting to turn them off:
#   - never 80 or 443: they belong to the public proxy of the machine. On
#     2026-10-17 `tailscale serve` held 443 on the Tailscale address, and after
#     a reboot the proxy could not bind 0.0.0.0:443: production was down for
#     six hours;
#   - never a port something else already listens on, on any address of the
#     machine (stricter than the kernel: a holder on one address would still
#     stop a later bind of 0.0.0.0 on that port, as the proxy found). The one
#     holder accepted is this installation's own unit for that port, so that
#     running the installer again changes nothing.
# When the list of listening ports cannot be read, nothing can be proved free:
# the check fails.

# Where the kernel's tables are read, and the program that lists the sockets.
# Plain variables, not read from the environment: the tests set them after
# sourcing this file.
ports_proc=/proc
ports_ss=ss

# ports_listeners: one line per TCP socket that listens, "address port pid uid
# inode" ("-" for what is not known). ss names the process only for this
# account's own sockets; /proc/net/tcp gives the account and the inode, not
# the process. Returns 1, saying why, when neither can be read, or when ss
# prints a line that is no listening socket. Nothing printed by ss is "nothing
# listens" only when the kernel's tables show no listener either.
ports_listeners() {
  local said listed table
  if command -v "$ports_ss" > /dev/null 2>&1; then
    said=$("$ports_ss" -ltnHp 2>&1) || { echo "ss -ltnHp failed: $(printf '%s\n' "$said" | sed -n '1p')" >&2; return 1; }
    if [ -z "$said" ]; then
      for table in "$ports_proc/net/tcp" "$ports_proc/net/tcp6"; do
        [ -e "$table" ] || continue
        [ -r "$table" ] || { echo "ss printed nothing, and $table cannot be read: the listening ports cannot be proved" >&2; return 1; }
        if awk 'NR > 1 && $4 == "0A" { found = 1; exit } END { exit !found }' "$table"; then
          echo "ss printed nothing, but $table has listening sockets: the list of listening ports cannot be read" >&2
          return 1
        fi
      done
      return 0
    fi
    listed=$(printf '%s\n' "$said" | awk 'NF == 0 { next }
      NF < 4 { print "ss printed a line that is no listening socket: " $0 > "/dev/stderr"; exit 2 }
      {
        local_address = $4; i = match(local_address, /:[^:]*$/)
        address = substr(local_address, 1, i - 1); port = substr(local_address, i + 1)
        if (!i || port !~ /^[0-9]+$/) { print "ss printed a line that is no listening socket: " $0 > "/dev/stderr"; exit 2 }
        pid = "-"; name = "-"
        if (match($0, /users:\(\("[^"]*",pid=[0-9]+/)) { users = substr($0, RSTART, RLENGTH); name = users; sub(/^users:\(\("/, "", name); sub(/".*$/, "", name); pid = users; sub(/^.*pid=/, "", pid) }
        print address, port, pid, "-", "-", name
      }') || return 1
    [ -z "$listed" ] || printf '%s\n' "$listed"
    return 0
  fi
  local table read=0
  for table in "$ports_proc/net/tcp" "$ports_proc/net/tcp6"; do
    [ -e "$table" ] || continue
    [ -r "$table" ] || { echo "ss is not installed and $table cannot be read" >&2; return 1; }
    read=1
    awk 'NR > 1 && $4 == "0A" {
      split($2, local_address, ":"); hex = local_address[1]; port = 0
      for (i = 1; i <= length(local_address[2]); i++) port = port * 16 + index("0123456789ABCDEF", toupper(substr(local_address[2], i, 1))) - 1
      if (length(hex) == 8) { address = ""; for (i = 7; i >= 1; i -= 2) { b = 0; for (j = 0; j < 2; j++) b = b * 16 + index("0123456789ABCDEF", toupper(substr(hex, i + j, 1))) - 1; address = address (address == "" ? "" : ".") b } }
      else address = (hex ~ /^0+$/) ? "[::]" : "[" hex "]"
      print address, port, "-", $8, $10, "-" }' "$table" || { echo "$table could not be read" >&2; return 1; }
  done
  [ "$read" = 1 ] || { echo "ss is not installed and $ports_proc/net/tcp cannot be read" >&2; return 1; }
}

# ports_pid_of_inode <inode>: the process of this account holding that socket.
ports_pid_of_inode() {
  local fd
  for fd in "$ports_proc"/[0-9]*/fd/*; do
    [ "$(readlink "$fd" 2> /dev/null)" = "socket:[$1]" ] || continue
    fd=${fd#"$ports_proc"/}; printf '%s\n' "${fd%%/*}"; return 0
  done
  return 1
}

# ports_unit_of_pid <pid>: the systemd user unit of this account the process
# runs in (its cgroup), or nothing. A child of the unit's main process counts:
# `cleared app` starts the server as a child.
ports_unit_of_pid() {
  local path
  path=$(sed -n "s|^[0-9]*:[^:]*:\(/.*/user@$(id -u)\.service/.*\)\$|\1|p" "$ports_proc/$1/cgroup" 2> /dev/null | sed -n '1p') || true
  path=${path##*/}
  case "$path" in *.service) printf '%s\n' "$path" ;; esac
}

# ports_number <what> <port>: refuses what is not a port, and 80 and 443.
ports_number() {
  case "$2" in '' | *[!0-9]* | 0*) echo "$1 is \"$2\", which is not a port number" >&2; return 1 ;; esac
  [ "$2" -le 65535 ] || { echo "$1 is $2, which is not a port number" >&2; return 1; }
  case "$2" in
    80 | 443) echo "$1 is $2: the installation never binds or publishes ports 80 and 443, they belong to the public proxy of this machine (docs/concepts.md, Decisions). Choose another port" >&2; return 1 ;;
  esac
}

# ports_origin_port <url>: the port an http(s) address is reached on, the
# scheme's own when none is written (https://host is 443).
ports_origin_port() {
  local own=80 rest hostport
  case "$1" in https://*) own=443 ;; http://*) ;; *) return 1 ;; esac
  rest=${1#*://}; hostport=${rest%%[/?#]*}; hostport=${hostport##*@}
  case "$hostport" in
    \[*\]:*) printf '%s\n' "${hostport##*]:}" ;;
    \[*\]) echo "$own" ;;
    *:*) printf '%s\n' "${hostport##*:}" ;;
    *) echo "$own" ;;
  esac
}

# ports_held <listeners> <what> <port> <own unit> <how to change it>: says who
# holds the port, unless it is only the unit named.
ports_held() {
  local address port pid uid inode name unit who note held=0
  while read -r address port pid uid inode name; do
    [ "$port" = "$3" ] || continue
    [ "$pid" != - ] || [ "$inode" = - ] || pid=$(ports_pid_of_inode "$inode") || pid=-
    unit=
    [ "$pid" = - ] || unit=$(ports_unit_of_pid "$pid")
    [ -z "$4" ] || [ "$unit" != "$4" ] || continue
    if [ "$pid" != - ]; then who="${name/#-/a process} (pid $pid${unit:+, unit $unit})"
    elif [ "$uid" != - ]; then who="a process of $(getent passwd "$uid" | cut -d: -f1 || true) (uid $uid)"
    else who="a process of another account"; fi
    # A container or WSL has no user unit in its cgroup: the unit of the running app cannot be recognised then.
    note=
    [ "$pid" = - ] || [ -n "$unit" ] || note=" In a container or WSL, where the cgroup names no user unit of this account, the unit that runs the app cannot be recognised: stop that unit first, or pass a free port."
    echo "$2 is $3, and $address:$3 is already held by $who ('sudo ss -ltnp \"sport = :$3\"' names it). $5.$note" >&2
    held=1
  done <<< "$1"
  [ "$held" = 0 ]
}

# ports_tailnet <address>: whether an address of this machine is on the tailnet:
# 100.64.0.0/10, or fd7a:115c:a1e0::/48 (as ss writes it, brackets and scope aside).
ports_tailnet() {
  local a=$1
  a=${a#\[}; a=${a%\]}; a=${a%%%*}; a=${a,,}
  case "$a" in
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].* | fd7a:115c:a1e0:*) return 0 ;;
  esac
  return 1
}

# ports_install_check <dashboard port> <app port> <[app] port> <[app] public_origin> <link base> <Tailscale address>:
# every port the installation binds, and every port it tells to publish, before
# anything is written. Says every problem, then returns 1 when there is one.
ports_install_check() {
  local listeners failed=0 origin_port link_port address port pid uid inode name
  listeners=$(ports_listeners) || { echo "the listening ports of this machine could not be read, so no port can be proved free" >&2; return 1; }
  ports_number "the dashboard port (CLEARED_DASHBOARD_PORT)" "$1" || failed=1
  ports_number "the app port (CLEARED_APP_PORT)" "$2" || failed=1
  [ "$1" != "$2" ] || { echo "the dashboard and the app have the same port ($1): give them two" >&2; failed=1; }
  if [ "$failed" = 0 ]; then
    ports_held "$listeners" "the dashboard port (CLEARED_DASHBOARD_PORT)" "$1" cleared-dashboard.service "Nothing of it is touched: run this again with CLEARED_DASHBOARD_PORT=<a free port>" || failed=1
    ports_held "$listeners" "the app port (CLEARED_APP_PORT)" "$2" cleared-app.service "Nothing of it is touched: run this again with CLEARED_APP_PORT=<a free port> (and the tailscale serve target with it)" || failed=1
  fi
  [ -z "$3" ] || ports_number "[app] port (what 'cleared app' binds without --port)" "$3" || failed=1
  if [ -n "$4" ]; then
    if ! origin_port=$(ports_origin_port "$4"); then
      echo "[app] public_origin ($4) is not an http(s) address" >&2; failed=1
    elif ! ports_number "the port of [app] public_origin ($4)" "$origin_port"; then
      echo "  Publish the app on HTTPS port 8443 (or 10000), never 443, for example: tailscale serve --bg --https=8443 http://127.0.0.1:$2, and set [app] public_origin = https://<machine>.<tailnet>.ts.net:8443 (docs/app.md)" >&2; failed=1
    elif [ "${4%%://*}" = https ] && { [ "$origin_port" = "$1" ] || [ "$origin_port" = "$2" ]; }; then
      # (an http origin is the app itself, on its own port: http://localhost:8788)
      echo "the port of [app] public_origin ($origin_port) is also the port of the dashboard or the app: tailscale serve publishes the app on a port of its own, for example 8443" >&2; failed=1
    fi
  fi
  if [ -n "$5" ]; then
    if ! link_port=$(ports_origin_port "$5"); then :
    elif ! ports_number "the port of CLEARED_NOTIFY_LINK_BASE ($5)" "$link_port"; then
      echo "  Use the address of [app] public_origin, with its port, for example https://<machine>.<tailnet>.ts.net:8443 (docs/notifications.md)" >&2; failed=1
    fi
  fi
  # Not this installation's to undo, but the very state of 2026-10-17: said.
  while read -r address port pid uid inode name; do
    case "$port" in 80 | 443) ;; *) continue ;; esac
    { [ "${address%%%*}" = "$6" ] || ports_tailnet "$address"; } || continue
    remedy="tailscale serve --https=$port off"
    [ "$port" != 80 ] || remedy="tailscale serve --http=80 off"
    echo "WARNING: something listens on $address:$port, a Tailscale address of this machine (tailscale serve on its default port?). It stops a public proxy from binding 0.0.0.0:$port after a reboot: see 'tailscale serve status', and '$remedy'." >&2
  done <<< "$listeners"
  [ "$failed" = 0 ]
}

# ports_serve_hint <[app] public_origin> <app address> <app port>: the command
# that publishes the app on the port of public_origin, already checked above.
ports_serve_hint() {
  local origin_port
  case "$1" in https://*) ;; *) return 0 ;; esac
  origin_port=$(ports_origin_port "$1") || return 0
  printf 'tailscale serve --bg --https=%s http://%s:%s\n' "$origin_port" "$2" "$3"
}
