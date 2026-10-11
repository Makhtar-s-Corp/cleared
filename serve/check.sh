#!/usr/bin/env bash
# Checks who can read the dashboard: this machine through Tailscale, yes; a
# container of the host, no, by any address; nothing listens anywhere else.
# Uses a container that already runs (the Coolify proxy): it starts none.
#
#   serve/check.sh        exit 0 when every line says ok
set -uo pipefail
port=${CLEARED_DASHBOARD_PORT:-${ORCH_DASHBOARD_PORT:-8787}}
address=$(tailscale ip -4 | head -n 1)
container=${ORCH_CHECK_CONTAINER:-coolify-proxy}
failed=0
say() { if [ "$2" = "$3" ]; then echo "ok    $1 ($2)"; else echo "FAIL  $1: got $2, expected $3"; failed=1; fi; }

say "this machine, through its Tailscale address" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$address:$port/")" 200
say "this machine, a path other than the page" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$address:$port/ledger.db")" 404

# From inside a container: the Tailscale address answers, but with a refusal;
# the addresses of the Docker networks and of the host do not answer at all.
from_container() { docker exec "$container" wget -q -O /dev/null --timeout=4 "http://$1:$port/" 2>&1 | grep -o -E '403|refused|timed out|bad address|unreachable' | head -n 1; }
say "a container, to the Tailscale address" "$(from_container "$address")" 403
for gateway in $(docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | sort -u); do
  result=$(from_container "$gateway")
  case "$result" in refused | "timed out" | unreachable) echo "ok    a container, to the Docker gateway $gateway ($result)" ;; *) echo "FAIL  a container, to the Docker gateway $gateway: got ${result:-an answer}"; failed=1 ;; esac
done

listening=$(ss -ltnH "sport = :$port" | awk '{print $4}' | sort -u | paste -sd' ')
say "listening addresses" "$listening" "$address:$port"
exit "$failed"
