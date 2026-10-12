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
if [ "${1:-}" = comment ] && [ "$adapter" != linear ]; then
  [ $# -ge 3 ] || die "usage: tracker.sh comment <ticket> <file|-> [sender]"
  input=$3
  temporary=
  if [ "$input" = - ]; then
    temporary=$(mktemp)
    cat > "$temporary"
    input=$temporary
  fi
  trap '[ -z "${temporary:-}" ] || rm -f "$temporary"; [ -z "${formatted:-}" ] || rm -f "$formatted"' EXIT
  [ -f "$input" ] && grep -q '[^[:space:]]' "$input" || die "nothing to post"
  mkdir -p "$ORCH_STATE_DIR"
  exec 9> "$ORCH_STATE_DIR/tracker-comments.lock"
  flock -w 60 9 || die "another comment is being posted for too long"
  limit=$(conf_get tracker comments_per_hour)
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=6
  mapfile -d '' -t parent < "/proc/$PPID/cmdline" 2> /dev/null || parent=()
  if [ "$(basename "${parent[0]:-}")" != bash ] || [ "$(realpath -q "${parent[1]:-/nonexistent}" 2> /dev/null)" != "$(realpath "$ORCH_HOME/confirm-decision.sh")" ]; then
    recent=$(jq -R -r --arg since "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" 'fromjson? | select(.at > $since) | .at' "$ORCH_STATE_DIR/tracker-comments.jsonl" 2> /dev/null | grep -c . || true)
    if [ "$recent" -ge "$limit" ]; then
      echo "$(basename "$0"): the user was already written $recent times in the last hour (limit: $limit): nothing posted" >&2
      exit 4
    fi
  fi
  formatted=$(mktemp)
  from=${4:-${ORCH_SIGNED:-script}}
  user_message agent_comment "from=$from" "owner=$(owner_name)" "body=$(cat "$input")" > "$formatted"
  posted=$(node --no-warnings "$ORCH_HOME/lib/tracker/cli.mjs" comment-json "$2" "$formatted") || exit $?
  jq -nc --arg id "$(jq -r '.id' <<<"$posted")" --arg ticket "$2" --arg from "$from" --arg at "$(now_utc)" '{id: $id, ticket: $ticket, from: $from, at: $at}' >> "$ORCH_STATE_DIR/tracker-comments.jsonl"
  jq -r '.url' <<<"$posted"
  exit
fi
case "$adapter" in
  linear) exec "$ORCH_HOME/lib/tracker/adapters/linear.sh" "$@" ;;
  github|local) exec node --no-warnings "$ORCH_HOME/lib/tracker/cli.mjs" "$@" ;;
  *) die "unknown [tracker] adapter: $adapter" ;;
esac
