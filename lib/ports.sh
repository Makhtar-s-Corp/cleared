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
ports_tailscale=tailscale

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
# scheme's own when none is written (https://host is 443). The scheme is read
# in any case, as browsers read it (HTTPS://host is 443 too). Fails on what is
# not http(s)://host[:port][/path]: another scheme, no host, a user name.
ports_origin_port() {
  local own scheme hostport host port
  case "$1" in *://*) ;; *) return 1 ;; esac
  scheme=${1%%://*}; scheme=${scheme,,}
  case "$scheme" in https) own=443 ;; http) own=80 ;; *) return 1 ;; esac
  hostport=${1#*://}; hostport=${hostport%%[/?#]*}
  case "$hostport" in
    *@* | *[[:space:]]*) return 1 ;;
    \[*\]:*) host=${hostport%]:*}; port=${hostport##*]:} ;;
    \[*\]) host=$hostport; port=$own ;;
    *:*:*) return 1 ;;
    *:*) host=${hostport%%:*}; port=${hostport##*:} ;;
    *) host=$hostport; port=$own ;;
  esac
  case "$host" in '' | '[') return 1 ;; esac
  printf '%s\n' "$port"
}

# ports_https <url>: whether the address is https, the scheme read in any case.
ports_https() {
  case "$1" in *://*) ;; *) return 1 ;; esac
  local scheme=${1%%://*}
  [ "${scheme,,}" = https ]
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

# ports_served <port>: whether tailscale serve publishes that port, as
# `tailscale serve status --json` says it (a key of its "TCP" object), the JSON
# read by node, never evaluated. 0: it does; 1: it does not; 2: it cannot be
# told (no tailscale, a refusal, an answer that is no such JSON).
ports_served() {
  local said code=0
  command -v "$ports_tailscale" > /dev/null 2>&1 || return 2
  said=$("$ports_tailscale" serve status --json 2> /dev/null) || return 2
  printf '%s' "$said" | node -e '
    let text = "";
    process.stdin.on("data", (d) => { text += d; }).on("end", () => {
      let status;
      try { status = JSON.parse(text); } catch { process.exit(2); }
      if (!status || typeof status !== "object" || Array.isArray(status)) process.exit(2);
      const tcp = status.TCP;
      if (tcp === undefined || tcp === null) process.exit(1);
      if (typeof tcp !== "object" || Array.isArray(tcp)) process.exit(2);
      process.exit(Object.hasOwn(tcp, process.argv[1]) ? 0 : 1);
    });' "$1" > /dev/null 2>&1 || code=$?
  case "$code" in 0 | 1) return "$code" ;; esac
  return 2
}

# ports_origin_held <listeners> <[app] public_origin> <its port> <Tailscale address>:
# the port tailscale serve is told to publish is free, or tailscale serve's
# already (a re-run). Accepted holders: a process named tailscaled (ss names
# this account's own, /proc/<pid>/comm the one found by its socket); and, as
# tailscaled runs as root and cannot be named without root, a holder of
# another account on a Tailscale address when `tailscale serve status` lists
# that port. Anything else is refused, named as far as this account can.
ports_origin_held() {
  local address port pid uid inode name who reason served= held=0
  while read -r address port pid uid inode name; do
    [ "$port" = "$3" ] || continue
    [ "$pid" != - ] || [ "$inode" = - ] || pid=$(ports_pid_of_inode "$inode") || pid=-
    if [ "$name" = - ] && [ "$pid" != - ]; then name=$(sed -n '1p' "$ports_proc/$pid/comm" 2> /dev/null) || true; name=${name:--}; fi
    [ "$name" != tailscaled ] || continue
    if [ "$pid" != - ]; then
      who="${name/#-/a process} (pid $pid), which is not tailscaled"
    else
      if [ "$uid" != - ]; then who="a process of $(getent passwd "$uid" | cut -d: -f1 || true) (uid $uid)"; else who="a process of another account"; fi
      who="$who, which this account cannot name without root"
      if { [ "${address%%%*}" = "$4" ] || ports_tailnet "$address"; }; then
        [ -n "$served" ] || { ports_served "$3" && served=0 || served=$?; }
        case "$served" in
          0) echo "note: $address:$3 is held by $who; 'tailscale serve status' lists port $3, so it is taken as tailscale serve, already publishing there." >&2; continue ;;
          1) reason="'tailscale serve status' does not list port $3, so it is not tailscale serve" ;;
          *) reason="'tailscale serve status' could not be read to show that it is tailscale serve (is tailscale installed, and may this account read it? 'sudo tailscale set --operator=$(id -un)' allows it): an unknown holder" ;;
        esac
      else
        reason="not a Tailscale address, so not tailscale serve"
      fi
      who="$who; $reason"
    fi
    echo "the port of [app] public_origin ($2) is $3, the port tailscale serve is told to publish, and $address:$3 is already held by $who ('sudo ss -ltnp \"sport = :$3\"' names it). Free that port, or choose another one for public_origin (8443 or 10000) and its tailscale serve command (docs/app.md)." >&2
    held=1
  done <<< "$1"
  [ "$held" = 0 ]
}

# ports_dropin_env <drop-in directory> <name>...: the values systemd gives these
# variables from the Environment= lines of <directory>/*.conf, read as text and
# never evaluated: files in the order of their names, [Service] only, comments
# and other keys skipped, quotes and backslashes as systemd reads them, an empty
# Environment= clearing what came before, the last assignment winning. Prints
# "<name><TAB><value>" for each one set. A directory that cannot be read has no
# drop-in for this account; a file in it that cannot be read, or a line whose
# quotes do not close, fails: what the unit gets cannot be told then.
ports_dropin_env() {
  local dir=$1 file files=()
  shift
  [ -d "$dir" ] && [ -r "$dir" ] && [ -x "$dir" ] || return 0
  while IFS= read -r -d '' file; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    [ "$(readlink -f -- "$file")" != /dev/null ] || continue
    [ -f "$file" ] && [ -r "$file" ] || { echo "$file cannot be read" >&2; return 1; }
    files+=("$file")
  done < <(printf '%s\0' "$dir"/*.conf | LC_ALL=C sort -z)
  [ "${#files[@]}" -gt 0 ] || return 0
  LC_ALL=C awk -v names="$*" '
    function words(s,   i, c, q, cur, n, has) {
      n = 0; cur = ""; q = ""; has = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (q == "" && (c == " " || c == "\t")) { if (has) { w[++n] = cur; cur = ""; has = 0 } continue }
        has = 1
        if (c == "\\" && q != "\047" && i < length(s)) { i++; cur = cur substr(s, i, 1); continue }
        if (q == "" && (c == "\"" || c == "\047")) { q = c; continue }
        if (q != "" && c == q) { q = ""; continue }
        cur = cur c
      }
      if (q != "") return -1
      if (has) w[++n] = cur
      return n
    }
    BEGIN { split(names, list, " "); for (i in list) wanted[list[i]] = 1 }
    FNR == 1 { section = ""; pending = "" }
    {
      line = $0; sub(/\r$/, "", line)
      if (pending == "" && line ~ /^[ \t]*[#;]/) next
      line = pending line; pending = ""
      if (line ~ /\\$/) { pending = substr(line, 1, length(line) - 1) " "; next }
      if (line ~ /^[ \t]*\[/) { section = line; gsub(/^[ \t]+|[ \t]+$/, "", section); next }
      if (section != "[Service]" || line !~ /^[ \t]*Environment[ \t]*=/) next
      value = line; sub(/^[ \t]*Environment[ \t]*=[ \t]*/, "", value); sub(/[ \t]+$/, "", value)
      if (value == "") { split("", set); next }
      n = words(value)
      if (n < 0) { print FILENAME ": a quote does not close: " line > "/dev/stderr"; broken = 1; next }
      for (i = 1; i <= n; i++) {
        j = index(w[i], "="); if (j < 2) continue
        name = substr(w[i], 1, j - 1); if (name in wanted) set[name] = substr(w[i], j + 1)
      }
    }
    END { if (broken) exit 1; for (name in set) print name "\t" set[name] }' "${files[@]}"
}

# ports_link <what> <address>: a notification link names an address, never
# 80 or 443: http(s)://host[:port], the scheme read in any case.
ports_link() {
  local link_port
  if ! link_port=$(ports_origin_port "$2"); then
    echo "$1 is \"$2\", which is not an http(s) address with a host (http(s)://host[:port])." >&2
  elif ports_number "the port of $1 ($2)" "$link_port"; then
    return 0
  fi
  echo "  Use the address of [app] public_origin, with its port, for example https://<machine>.<tailnet>.ts.net:8443 (docs/notifications.md)" >&2
  return 1
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

# ports_install_check <dashboard port> <app port> <[app] port> <[app] public_origin> <link base> <Tailscale address> [<units directory> [<legacy link base>]]:
# every port the installation binds, and every port it tells to publish, before
# anything is written; and the notification link, from this shell (CLEARED_ and
# the legacy ORCH_ name) and from the drop-ins of cleared-wake.service and
# cleared-app.service in the units directory. Says every problem, then returns
# 1 when there is one.
ports_install_check() {
  local listeners failed=0 origin_port address port pid uid inode name remedy unit assigned variable value
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
    elif ports_https "$4" && { [ "$origin_port" = "$1" ] || [ "$origin_port" = "$2" ]; }; then
      # (an http origin is the app itself, on its own port: http://localhost:8788)
      echo "the port of [app] public_origin ($origin_port) is also the port of the dashboard or the app: tailscale serve publishes the app on a port of its own, for example 8443" >&2; failed=1
    elif ports_https "$4" && ! ports_origin_held "$listeners" "$4" "$origin_port" "$6"; then
      failed=1
    fi
  fi
  [ -z "$5" ] || ports_link "CLEARED_NOTIFY_LINK_BASE in this shell" "$5" || failed=1
  [ -z "${8:-}" ] || ports_link "ORCH_NOTIFY_LINK_BASE in this shell" "$8" || failed=1
  if [ -n "${7:-}" ]; then
    for unit in cleared-wake.service cleared-app.service; do
      if ! assigned=$(ports_dropin_env "$7/$unit.d" CLEARED_NOTIFY_LINK_BASE ORCH_NOTIFY_LINK_BASE); then
        echo "the drop-ins of $unit ($7/$unit.d) could not be read, so the notification link they set cannot be checked: make them readable by this account, or remove the broken one" >&2; failed=1; continue
      fi
      while IFS=$'\t' read -r variable value; do
        [ -n "$value" ] || continue
        ports_link "$variable, set for $unit in $7/$unit.d" "$value" || failed=1
      done <<< "$assigned"
    done
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
  ports_https "$1" || return 0
  origin_port=$(ports_origin_port "$1") || return 0
  printf 'tailscale serve --bg --https=%s http://%s:%s\n' "$origin_port" "$2" "$3"
}
