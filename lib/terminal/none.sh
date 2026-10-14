# The terminal adapter for no terminal at all: each session is started
# detached, in a session of its own, and nobody watches it. What it prints
# goes to terminal.log in its run folder. Sourced by lib/common.sh
# (terminal), never executed; the contract is written at the top of
# lib/terminal/orca.sh.
#
# Started by a wake, a session must outlive the wake: a systemd unit that
# ends stops every process it started. The session is therefore put in a
# scope of its own of the user's systemd manager (systemd-run --user
# --scope), as the release watch is; where there is no such manager (a
# script run by hand), setsid alone detaches it.
#
# Its handle is none:<pid>:<start>:<boot>, the start of the process in ticks
# since the boot of the host, and that boot: a number the system gives to
# another process later is never taken for it. Nothing is signalled before
# the process is checked to be that one, and a Cleared session.

# none_session <handle>: the process of that handle, when it is still the
# session that was started (same boot, same start, a Cleared run script, as
# cleared status checks it), and nothing otherwise.
none_session() {
  local kind pid start boot stat fields argv
  IFS=: read -r kind pid start boot <<<"$1"
  [ "$kind" = none ] && [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$start" =~ ^[0-9]+$ ]] || return 1
  [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id 2> /dev/null)" ] || return 1
  stat=$(cat "/proc/$pid/stat" 2> /dev/null) || return 1
  # The name of the process is between parentheses and may hold anything:
  # the fields are read after it (the 22nd, its start, is the 20th there).
  read -r -a fields <<<"${stat##*) }"
  [ "${fields[19]:-}" = "$start" ] || return 1
  mapfile -d '' -t argv 2> /dev/null < "/proc/$pid/cmdline" || return 1
  case "${argv[0]:-}" in bash | sh | */bash | */sh) ;; *) return 1 ;; esac
  [ "${argv[1]:-}" = "$ORCH_HOME/lane-run.sh" ] || [ "${argv[1]:-}" = "$ORCH_HOME/talk-run.sh" ] || return 1
  printf '%s\n' "$pid"
}

# The command runs in the worktree, its input empty, its output in
# terminal.log. The process is the session's own leader: its number is the
# one of its process group, which holds the harness it starts. The handle and
# the worktree (its resolved path) are also kept in terminal.none, in the run
# folder: closing the terminals of a worktree finds them there, whichever
# path names it. Nothing waits for the session.
terminal_open() {
  local worktree=$1 title=$2 command=$3 run_dir=$4 ticket=${5:-} log pid stat fields handle launch
  log="$run_dir/terminal.log"
  # Run by a shell of its own: the descriptors the caller holds (the lock of
  # the wakes among them) are not handed to the session, and its process
  # number is printed once it is detached.
  # shellcheck disable=SC2016
  launch='cd "$1" || exit 1
for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -le 2 ] || eval "exec $fd>&-" 2> /dev/null; done
setsid bash -c "exec $2" < /dev/null >> "$3" 2>&1 &
echo "$!"'
  pid=
  if [ -d "$worktree" ] && [ -d "$run_dir" ] && command -v setsid > /dev/null; then
    if ! pid=$(systemd-run --user --scope --collect --quiet --description="Cleared: $title" -- bash -c "$launch" cleared-session "$worktree" "$command" "$log" 2> /dev/null); then
      # Started by a systemd unit, and no scope: the session stays in the
      # unit and may end with it. Said where the session and its caller write.
      [ -z "${INVOCATION_ID:-}" ] || echo "$(basename "$0"): systemd-run --user gave the session of $title no scope of its own: it may end with the unit that started it" | tee -a "$log" >&2
      pid=$(bash -c "$launch" cleared-session "$worktree" "$command" "$log" 2>> "$log") || pid=
    fi
  fi
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    ledger event --kind terminal_failed --ticket "$ticket" --detail "$title: the session could not be started in $worktree (no terminal: [terminal] adapter = none)"
    return 1
  fi
  stat=$(cat "/proc/$pid/stat" 2> /dev/null) || stat=
  read -r -a fields <<<"${stat##*) }"
  handle="none:$pid:${fields[19]:-0}:$(cat /proc/sys/kernel/random/boot_id 2> /dev/null)"
  # The worktree as the file system resolves it: git names it so, whatever
  # link the configured root goes through.
  printf '%s\n%s\n' "$handle" "$(realpath -m -- "$worktree")" > "$run_dir/terminal.none"
  printf '%s\n' "$handle"
}

# There is no terminal to show, to write down or to type in: a lane of the
# dispatcher is told by its ticket, and reads it at its next session.
terminal_show() {
  die "[terminal] adapter = none: sessions run without a terminal, there is none to show or to type in. A lane of the dispatcher is told by its ticket (tell-lane.sh <ticket> <file>): the message is handed to it at its next session"
}
terminal_send() { terminal_show; }

# Closing a session ends its whole process group: the run script, sudo, and
# the harness under [security] agent_user with what it started. The account
# of the service cannot signal the processes of the agents' account, and
# sudo stops passing signals on once it is gone: the group is therefore
# signalled from both accounts (sudo -n -u <agent_user> -- kill, the rule the
# harness starts with), SIGTERM, then SIGKILL after ORCH_STOP_GRACE seconds
# (10). The only number signalled is the one the service wrote in the handle,
# once checked (none_session), or a group of that number that only the
# session can have left (none_orphans). What is still there after the KILL is
# said, on stderr and in the ledger, and the close fails: nobody takes a
# worktree from under a session that runs.
#
# none_members <group>: the live processes of that process group, one number
# a line, as /proc shows them.
none_members() {
  local dir stat fields
  for dir in /proc/[0-9]*; do
    stat=
    read -r -d '' stat 2> /dev/null < "$dir/stat" || [ -n "$stat" ] || continue
    read -r -a fields <<<"${stat##*) }"
    [ "${fields[2]:-}" = "$1" ] && [ "${fields[0]:-}" != Z ] && printf '%s\n' "${dir#/proc/}"
  done
  return 0
}

# none_orphans <handle>: the number of the process group of that handle when
# its leader is gone but processes of the group are left (a run script that
# died, killed, or stopped by an earlier close that could not reach the
# agents' account). A group outlives its leader under the same number, which
# the system gives to no other process while the group has a member; members
# can only join a group of their own session. So: the same boot, no process
# of that number, and every member in the session of that number, started
# after the leader.
none_orphans() {
  local kind pid start boot member stat fields members
  IFS=: read -r kind pid start boot <<<"$1"
  [ "$kind" = none ] && [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$start" =~ ^[0-9]+$ ]] || return 1
  [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id 2> /dev/null)" ] && [ ! -e "/proc/$pid" ] || return 1
  members=$(none_members "$pid")
  [ -n "$members" ] || return 1
  while IFS= read -r member; do
    stat=$(cat "/proc/$member/stat" 2> /dev/null) || continue
    read -r -a fields <<<"${stat##*) }"
    [ "${fields[3]:-}" = "$pid" ] && [ "${fields[19]:-0}" -ge "$start" ] || return 1
  done <<<"$members"
  printf '%s\n' "$pid"
}

# none_agent: the agents' account, when the harness runs under another one
# than this script's.
none_agent() {
  local agent
  agent=$(conf_get security agent_user 2> /dev/null) || agent=
  [ -n "$agent" ] && [ "$agent" != "$(id -un)" ] && printf '%s\n' "$agent"
}

# none_signal <signal> <group> [<agent account>]: the group, from this
# account and from the agents' one.
none_signal() {
  kill -"$1" -- "-$2" 2> /dev/null || true
  [ -z "${3:-}" ] || sudo -n -u "$3" -- kill -"$1" -- "-$2" > /dev/null 2>&1 || true
}

# none_agent_holds <group> <agent account>: what the agents' account says of
# the group: "held" (a process of its own is still in it), "free", or nothing
# when sudo could not ask it. (/proc may hide its processes from the service.)
none_agent_holds() {
  sudo -n -u "$2" -- sh -c 'if kill -0 "-$1" 2> /dev/null; then echo held; else echo free; fi' cleared-check "$1" 2> /dev/null
}

# none_stop_group <group> <handle>: TERM, the grace, KILL, and the check that
# nothing of the group is left.
none_stop_group() {
  local group=$1 agent grace=${ORCH_STOP_GRACE:-10} tries left held=free why
  agent=$(none_agent) || agent=
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=10
  none_signal TERM "$group" "$agent"
  for ((tries = grace * 5; tries > 0; tries--)); do
    [ -n "$(none_members "$group")" ] || break
    sleep 0.2
  done
  [ -z "$agent" ] || held=$(none_agent_holds "$group" "$agent")
  if [ -n "$(none_members "$group")" ] || [ "$held" != free ]; then
    # Something of the group is still there: its number is still its own.
    none_signal KILL "$group" "$agent"
    for ((tries = 25; tries > 0; tries--)); do
      [ -n "$(none_members "$group")" ] || break
      sleep 0.2
    done
    [ -z "$agent" ] || held=$(none_agent_holds "$group" "$agent")
  fi
  left=$(none_members "$group" | paste -sd' ' -)
  if [ -z "$left" ] && [ "$held" = free ]; then return 0; fi
  if [ -n "$left" ]; then why="process(es) $left of its group $group are still running after SIGKILL"
  elif [ -z "$held" ]; then why="sudo -n -u $agent could not stop and check the processes of $agent in its group $group"
  else why="processes of $agent are still in its group $group after SIGKILL"; fi
  echo "$(basename "$0"): the session $2 is not over: $why; its worktree is left as it is" >&2
  ledger event --kind session_not_stopped --detail "the session $2 is not over: $why" > /dev/null 2>&1 || true
  return 1
}

# 0 once the session and every process of its group are gone, or when the
# handle names no session of Cleared any more; 1, said, when something of it
# is left.
terminal_close() {
  local pid stat fields
  if pid=$(none_session "$1"); then
    stat=$(cat "/proc/$pid/stat" 2> /dev/null) || return 0
    read -r -a fields <<<"${stat##*) }"
    # A session that leads no process group of its own (none starts so): it alone.
    if [ "${fields[2]:-}" != "$pid" ]; then kill -TERM "$pid" 2> /dev/null; return 0; fi
  else
    pid=$(none_orphans "$1") || return 0
  fi
  none_stop_group "$pid" "$1"
}

terminal_stop() { terminal_close "$1"; }

# Fails when a session in that worktree could not be ended.
terminal_close_worktree() {
  local mark worktree code=0
  worktree=$(realpath -m -- "$1")
  for mark in "$ORCH_STATE_DIR"/runs/*/terminal.none; do
    [ -f "$mark" ] && [ "$(sed -n '2p' "$mark")" = "$worktree" ] || continue
    terminal_close "$(sed -n '1p' "$mark")" || code=1
  done
  return "$code"
}

terminal_remove_worktree() { git -C "$ORCH_REPO" worktree remove --force "$1"; }

# No terminal shows a name: the branch names the lane.
terminal_name_worktree() { return 0; }

terminal_has_screen() { return 1; }
