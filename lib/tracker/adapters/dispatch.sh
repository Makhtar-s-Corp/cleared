#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")/../../.." && pwd)/lib/common.sh"
adapter=$(conf_get tracker adapter)
[ -n "$adapter" ] || die "Missing required [tracker] adapter (linear | github | local)"
if [ "${1:-}" = decorate-worktree ] && [ "$adapter" != linear ]; then
  orca worktree set --worktree "path:$2" --display-name "$3" --comment "$5"
  exit $?
fi
if [ "${1:-}" = legacy-line-allowed ]; then
  [ "$adapter" = linear ]
  exit $?
fi
if [ "${1:-}" = ticket-prefix ]; then
  case "$adapter" in
    linear) conf_get tracker team ;;
    github) printf 'GH\n' ;;
    local) printf 'LOCAL\n' ;;
    *) die "unknown [tracker] adapter: $adapter" ;;
  esac
  exit
fi
case "$adapter" in
  linear) exec "$ORCH_HOME/lib/tracker/adapters/linear.sh" "$@" ;;
  github|local) exec node --no-warnings "$ORCH_HOME/lib/tracker/cli.mjs" "$@" ;;
  *) die "unknown [tracker] adapter: $adapter" ;;
esac
