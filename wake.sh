#!/usr/bin/env bash
# The wake of Cleared's v1 services. Run every minute by a timer; no model.
#
#   1. Tries again what only waited: the comments the hourly limit held back,
#      the go-lives that waited for the host, the tickets a go-live could not
#      close.
#   2. Follows the release watch (lib/release.mjs reconcile) and notes an
#      outage of GitHub, with its start and its end, in the ledger.
#   3. Reads what moved in the tracker and on GitHub since the last wake
#      (lib/wake.mjs) and keeps it in its state, where the snapshot reads
#      each pull request's size and checks.
#   4. Writes the snapshot (lib/board-collector.mjs) and the heartbeat's wake
#      end (lib/heartbeat.mjs), then dispatches the notifications
#      (lib/notify.mjs).
#
#   wake.sh
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# = 0 ] || die "usage: wake.sh"
wake_dir="$ORCH_STATE_DIR/wake"
mkdir -p "$wake_dir"
ledger init > /dev/null
# What GitHub's status page says is read once a wake (lib/common.sh,
# github_down), by the go-lives and by the outage note below.
export CLEARED_GITHUB_DOWN_CACHE="$wake_dir/github-status.read"
rm -f "$CLEARED_GITHUB_DOWN_CACHE"
# One wake at a time: one that finds another at work leaves quietly, it
# comes back in a minute.
exec 8> "$wake_dir/lock"
flock -n 8 || exit 0

work=
wake_cleanup() {
  local result=$?
  trap - EXIT
  [ -z "$work" ] || rm -rf "$work"
  if [ "$result" -eq 0 ]; then
    node --no-warnings "$ORCH_HOME/lib/board-collector.mjs" > /dev/null || result=1
  fi
  node --no-warnings "$ORCH_HOME/lib/heartbeat.mjs" wake-end "$result" > /dev/null || true
  # What waits for the human, and what went wrong, told on his phone
  # (lib/notify.mjs, [notify]): last, once the snapshot and the health are
  # written. It never fails the wake, and never holds the wake's lock for
  # long: it gives up its own sends after CLEARED_NOTIFY_DEADLINE_SECONDS
  # (30 by default, 50 at most) and is stopped here after 60 seconds whatever happens.
  # The wake lock (fd 8) is closed for it: a sendmail child that outlives the kill must not hold the lock.
  timeout -k 5 60 node --no-warnings "$ORCH_HOME/lib/notify.mjs" dispatch > /dev/null 8>&- || true
  exit "$result"
}
trap wake_cleanup EXIT

node --no-warnings "$ORCH_HOME/lib/release.mjs" reconcile > /dev/null 2>&1 || true

# What the hourly limit held back leaves now, grouped, if the user may be written.
flush_outbox
# The go-lives that only waited for the host.
open_queued_merges
close_tickets_left_open

# GitHub down, as its status page says: noted when it starts, written to the
# ledger when it ends, with both times.
github_mark="$wake_dir/github-down"
github_read=0
github_out=$(github_down) || github_read=$?
# Its page cannot be read: an outage already noted goes on, none begins.
if [ "$github_read" != 0 ]; then
  github_out=
  [ ! -f "$github_mark" ] || github_out=$(sed -n '2p' "$github_mark")
fi
if [ -n "$github_out" ]; then
  [ -f "$github_mark" ] || printf '%s\n%s\n' "$(now_utc)" "$github_out" > "$github_mark"
elif [ -f "$github_mark" ]; then
  began=$(sed -n '1p' "$github_mark")
  ledger event --kind github_down --at "$began" --value "$(( ($(date +%s) - $(date -d "$began" +%s)) / 60 ))" \
    --detail "from $began to $(now_utc): $(sed -n '2p' "$github_mark")"
  rm -f "$github_mark"
fi

# What moved since the last wake, kept in the state the snapshot reads.
state="$wake_dir/state.json"
work=$(mktemp -d)
# Taken before anything is read: it becomes the time of this wake.
read_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# The tracker is asked for what was touched since the last wake, with some
# overlap; what was already seen is told apart by its identifier. A state
# file that cannot be read is no state: this wake starts over as a first one
# (lib/wake.mjs does the same with it).
last=$(jq -r '.at // empty' "$state" 2> /dev/null || true)
if [ -z "$last" ] || ! since=$(date -u -d "$last - 12 minutes" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null); then
  since=$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ)
  [ ! -f "$state" ] || echo "$(basename "$0"): $state cannot be read: starting over as a first wake" >&2
fi
# A source that does not answer: this wake sees nothing and moves nothing.
"$ORCH_HOME/tracker.sh" changes "$since" > "$work/tracker.json" || die "tracker did not answer: nothing read, nothing moved"
if [ -n "$github_out" ]; then
  echo '[]' > "$work/pulls.json"
else
  (cd "$ORCH_REPO" && gh pr list --state all --limit 60 --json number,title,headRefName,isDraft,state,updatedAt,statusCheckRollup,changedFiles,additions,deletions) > "$work/pulls.json" \
    || die "GitHub did not answer: nothing read, nothing moved"
fi
# What Cleared's scripts posted themselves.
cat "$ORCH_STATE_DIR/tracker-comments.jsonl" "$ORCH_STATE_DIR/tracker-issues.jsonl" 2> /dev/null | jq -r '.id // empty' > "$work/agent-ids.txt" || true
echo '[]' > "$work/none.json"
node --no-warnings "$ORCH_HOME/lib/wake.mjs" "$state" "$work/tracker.json" "$work/pulls.json" "$work/agent-ids.txt" "$read_at" "$work/none.json" "$(conf_get lead wake_on)" "${github_out:+down}" "$work/none.json" "$(conf_get tracker go_state)" "$work/none.json" > "$work/changes.json"
jq '.next' "$work/changes.json" > "$state.next" && mv "$state.next" "$state"
