// The programs the Codex harness runs in a session's container: one for each
// turn (`codex exec --json`, then `codex exec resume` on the same thread) and
// one for the human who took the session over (Codex's interactive program,
// `codex resume`, on the same thread).
//
// The login is a Codex API key in a file, mounted read only at
// LOGIN_FILE_MOUNT. Each launcher reads it inside the container into
// CODEX_API_KEY in the harness's environment only: never a word of a command
// line, which the host's `ps` and `docker inspect` show; never printed, never
// journaled; `codex login` is never run, so no credential is written to the
// session's volume. Codex keeps the variable out of the commands it runs
// (shell_environment_policy, its own default for names holding KEY, and named
// here). The prompt of a turn arrives on the standard input (`-`), so it is no
// word of a command line either.
//
// CODEX_HOME is on the session's config volume, so that a turn, the human's
// terminal and the next turn find the same thread (its rollout file), and no
// configuration of the host's own Codex is read.
//
// The sandbox is Codex's own and is chosen by the role (sandboxOf): read only
// for a reviewer, a reader, the lead and an author whose plan waits for its
// Go; the checkout writable for an author at work. Approvals are `never`: an
// exec turn has no channel on which a call waits for a person (the app
// server's approvals are not used: docs/adapters.md, the decision gate).
// Nothing here ever passes danger-full-access, a --dangerously-bypass flag,
// --full-auto or --approve-for-me.
import { CONFIG_MOUNT, LOGIN_FILE_MOUNT } from '../../../container/session-runtime.ts';
import { GIT_IDENTITY } from '../../../../images/session/runner/main.ts';
import type { Policy } from '../../policy.ts';

export const INTERACTIVE_NAME = 'Codex';
export const CODEX_HOME = `${CONFIG_MOUNT}/codex`;

// Exit codes the adapter reads: no login in the container, no Codex program.
export const EXIT_NO_LOGIN = 3;
export const EXIT_NO_PROGRAM = 127;

// Where a turn writes its process id (exec keeps it), so that the host can
// end the program itself: ending the docker client would leave it running.
// Codex's npm program is a node script that starts its native binary, so its
// children are ended with it.
export const TURN_PID_FILE = '/tmp/.cleared-codex-turn.pid';
export const END_TURN: readonly string[] = [
  'sh', '-c',
  `p=$(cat ${TURN_PID_FILE} 2>/dev/null); case "$p" in ''|*[!0-9]*) exit 0;; esac; grep -aq -- --json /proc/$p/cmdline 2>/dev/null || { rm -f ${TURN_PID_FILE}; exit 0; }; pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; i=0; while [ $i -lt 30 ] && [ -e /proc/$p ]; do sleep 0.1; i=$((i+1)); done; pkill -KILL -P "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; rm -f ${TURN_PID_FILE}; exit 0`,
];

// The last token_count line of the thread's rollout file ($1 the thread),
// where Codex writes its rate limit windows; at most 64 KiB, nothing when
// there is no such file. Only that line leaves the container, and the
// adapter keeps only its windows.
export const RATE_LIMITS: readonly string[] = [
  'sh', '-c',
  `f=$(ls -t '${CODEX_HOME}'/sessions/*/*/*/rollout-*-"$1".jsonl 2>/dev/null | head -n 1); [ -n "$f" ] || exit 0; grep -F '"token_count"' "$f" | tail -n 1 | head -c 65536`,
  'codex-rate-limits',
];

export type Sandbox = 'read-only' | 'workspace-write';

// The role's sandbox: only an author whose plan has its Go writes.
export function sandboxOf(policy: Policy): Sandbox {
  return policy.role === 'author' && policy.planning !== true ? 'workspace-write' : 'read-only';
}

const identity = Object.entries(GIT_IDENTITY).map(([name, value]) => `${name}='${value}'`).join(' ');

const COMMON = [
  `k=$(head -c 4096 "$1" 2>/dev/null | tr -d '\\r\\n') || k=''`,
  `if [ -z "$k" ]; then echo "Cleared: no Codex login in the session's container." >&2; exit ${EXIT_NO_LOGIN}; fi`,
  'b=$(command -v codex) || b=\'\'',
  `if [ -z "$b" ]; then echo "Cleared: the Codex program is not installed in the session's image." >&2; exit ${EXIT_NO_PROGRAM}; fi`,
  'CODEX_API_KEY=$k; export CODEX_API_KEY; unset k OPENAI_API_KEY ANTHROPIC_API_KEY',
  `CODEX_HOME='${CODEX_HOME}'; export CODEX_HOME`,
  `export ${identity}`,
  'mkdir -p "$CODEX_HOME" 2>/dev/null',
];

// The settings every Codex run takes, as `-c key=value` words: they win over
// any configuration file, and `codex exec resume` has no --sandbox flag.
function settings(sandbox: Sandbox, approval: 'never' | 'on-request'): string[] {
  return [
    '-c', `approval_policy="${approval}"`,
    '-c', `sandbox_mode="${sandbox}"`,
    // The container's egress is the network's guard (B5.4d): the tests reach
    // the session's services through it.
    ...(sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    '-c', 'shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]',
  ];
}

// sh, with $1 the login file, $2 the model, $3 the thread ('' for the first
// turn), then Codex's settings. Reads the prompt on its standard input.
export const TURN_LAUNCH = [
  ...COMMON,
  `echo $$ > ${TURN_PID_FILE}`,
  'm=$2; t=$3; shift 3',
  'if [ -n "$t" ]; then exec "$b" exec resume --json --skip-git-repo-check -m "$m" "$@" "$t" -; fi',
  'exec "$b" exec --json --skip-git-repo-check -m "$m" "$@" -',
].join('\n');

// The same for the human: sh, with $1 to $3 as above and $3 the thread. The
// shared background server is not used, so Give back leaves nothing running.
export const INTERACTIVE_LAUNCH = [
  ...COMMON,
  'm=$2; t=$3; shift 3',
  'exec "$b" resume --no-daemon --include-non-interactive -m "$m" "$@" "$t"',
].join('\n');

// Codex's thread ids are its own (a UUID so far): a conservative shape, since
// the id reaches a command line.
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isThreadId = (value: unknown): value is string => typeof value === 'string' && THREAD_ID.test(value);

export function turnCommand(model: string, thread: string | undefined, sandbox: Sandbox): string[] {
  if (!MODEL.test(model)) throw new Error(`not a model name: ${JSON.stringify(model)}`);
  if (thread !== undefined && !isThreadId(thread)) throw new Error('not a thread id');
  return ['sh', '-c', TURN_LAUNCH, 'codex', LOGIN_FILE_MOUNT, model, thread ?? '', ...settings(sandbox, 'never')];
}

// The human answers Codex's own approvals in the terminal, inside the same sandbox.
export function interactiveCommand(model: string, thread: string, sandbox: Sandbox): string[] {
  if (!MODEL.test(model)) throw new Error(`not a model name: ${JSON.stringify(model)}`);
  if (!isThreadId(thread)) throw new Error('not a thread id');
  return ['sh', '-c', INTERACTIVE_LAUNCH, 'codex', LOGIN_FILE_MOUNT, model, thread, ...settings(sandbox, 'on-request')];
}
