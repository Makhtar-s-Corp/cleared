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
# the worktree are also kept in terminal.none, in the run folder: closing the
# terminals of a worktree finds them there. Nothing waits for the session.
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
  printf '%s\n%s\n' "$handle" "$worktree" > "$run_dir/terminal.none"
  printf '%s\n' "$handle"
}

# There is no terminal to show, to write down or to type in: a lane of the
# dispatcher is told by its ticket, and reads it at its next session.
terminal_show() {
  die "[terminal] adapter = none: sessions run without a terminal, there is none to show or to type in. A lane of the dispatcher is told by its ticket (tell-lane.sh <ticket> <file>): the message is handed to it at its next session"
}
terminal_send() { terminal_show; }

# SIGTERM to the session and the process group it leads (its harness, under
# sudo, gets it from sudo). A process that is gone, or that is no longer the
# session of that handle, is left alone: there is nothing of it to close.
terminal_close() {
  local pid stat fields
  pid=$(none_session "$1") || return 0
  stat=$(cat "/proc/$pid/stat" 2> /dev/null) || return 0
  read -r -a fields <<<"${stat##*) }"
  if [ "${fields[2]:-}" = "$pid" ]; then kill -TERM -- "-$pid" 2> /dev/null; else kill -TERM "$pid" 2> /dev/null; fi
}

terminal_close_worktree() {
  local mark
  for mark in "$ORCH_STATE_DIR"/runs/*/terminal.none; do
    [ -f "$mark" ] && [ "$(sed -n '2p' "$mark")" = "$1" ] || continue
    terminal_close "$(sed -n '1p' "$mark")" || true
  done
  return 0
}

terminal_remove_worktree() { git -C "$ORCH_REPO" worktree remove --force "$1"; }

# No terminal shows a name: the branch names the lane.
terminal_name_worktree() { return 0; }

terminal_has_screen() { return 1; }
