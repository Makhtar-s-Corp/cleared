// The programs the Cursor harness runs in a session's container: one for each
// turn (print mode, stream-json) and one for the human who took the session
// over (Cursor's interactive agent, resumed on the same chat).
//
// The login is a Cursor API key in a file, mounted read only at
// LOGIN_FILE_MOUNT. Each launcher reads it inside the container into
// CURSOR_API_KEY in the harness's environment only: never `--api-key`, which
// would put it on a command line the host's `ps` and `docker inspect` show;
// never printed, never journaled. The binary is `agent` (Cursor's current
// name), else `cursor-agent` (its former one); neither found exits 127.
//
// The permissions (permissions.ts) are written to `.cursor/cli.json` of the
// checkout, where Cursor documents the project's file; the host keeps that
// folder out of git (workspace/checkout.ts EXCLUDED) and the policy denies
// the session's own writes there. The prompt of a turn arrives on the
// standard input, so it is no word of a command line.
//
// Chats live in CURSOR_CONFIG_DIR on the session's config volume so that a
// turn, the human's terminal and the next turn find the same chat. Whether
// the installed Cursor honours that variable is one of the points the
// owner's trial checks (docs/adapters.md).
import { CONFIG_MOUNT, LOGIN_FILE_MOUNT } from '../../../container/session-runtime.ts';
import { GIT_IDENTITY } from '../../../../images/session/runner/main.ts';

export const INTERACTIVE_NAME = 'Cursor';
export const CURSOR_CONFIG_DIR = `${CONFIG_MOUNT}/cursor`;

// Exit codes the adapter reads: no login in the container, no Cursor program.
export const EXIT_NO_LOGIN = 3;
export const EXIT_NO_PROGRAM = 127;
export const EXIT_NO_PERMISSIONS = 4;

// Where a turn writes its process id (exec keeps it), so that the host can
// end the program itself: ending the docker client would leave it running.
export const TURN_PID_FILE = '/tmp/.cleared-cursor-turn.pid';
export const END_TURN: readonly string[] = [
  'sh', '-c',
  `p=$(cat ${TURN_PID_FILE} 2>/dev/null); case "$p" in ''|*[!0-9]*) exit 0;; esac; grep -aq stream-json /proc/$p/cmdline 2>/dev/null || { rm -f ${TURN_PID_FILE}; exit 0; }; kill -TERM "$p" 2>/dev/null; i=0; while [ $i -lt 30 ] && [ -e /proc/$p ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "$p" 2>/dev/null; rm -f ${TURN_PID_FILE}; exit 0`,
];

const identity = Object.entries(GIT_IDENTITY).map(([name, value]) => `${name}='${value}'`).join(' ');

const COMMON = [
  `k=$(head -c 4096 "$1" 2>/dev/null | tr -d '\\r\\n') || k=''`,
  `if [ -z "$k" ]; then echo "Cleared: no Cursor login in the session's container." >&2; exit ${EXIT_NO_LOGIN}; fi`,
  'b=$(command -v agent || command -v cursor-agent) || b=\'\'',
  `if [ -z "$b" ]; then echo "Cleared: the Cursor program is not installed in the session's image." >&2; exit ${EXIT_NO_PROGRAM}; fi`,
  'CURSOR_API_KEY=$k; export CURSOR_API_KEY; unset k ANTHROPIC_API_KEY',
  `CURSOR_CONFIG_DIR='${CURSOR_CONFIG_DIR}'; export CURSOR_CONFIG_DIR`,
  `export ${identity}`,
  'mkdir -p "$CURSOR_CONFIG_DIR" 2>/dev/null',
  // Mandatory: without the permissions file the first guard layer is absent
  // (a reviewer's or reader's checkout is read only), so the program never starts.
  `if ! { mkdir -p .cursor && printf '%s' "$2" > .cursor/cli.json; } 2>/dev/null; then echo "Cleared: the Cursor permissions file could not be written in the checkout: the harness does not start without it." >&2; exit ${EXIT_NO_PERMISSIONS}; fi`,
];

// sh, with $1 the login file, $2 the permissions' JSON, $3 the model, $4 the
// chat ('' for the first turn). Reads the prompt on its standard input.
export const TURN_LAUNCH = [
  ...COMMON,
  `echo $$ > ${TURN_PID_FILE}`,
  'p=$(cat)',
  'if [ -n "$4" ]; then exec "$b" -p --output-format stream-json --model "$3" --resume "$4" "$p"; fi',
  'exec "$b" -p --output-format stream-json --model "$3" "$p"',
].join('\n');

// The same for the human: sh, with $1 to $3 as above and $4 the chat.
export const INTERACTIVE_LAUNCH = [
  ...COMMON,
  'exec "$b" --resume "$4" --model "$3"',
].join('\n');

// Cursor's chat ids are its own, not a UUID chosen here: a conservative
// shape, since the id reaches a command line.
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isChatId = (value: unknown): value is string => typeof value === 'string' && CHAT_ID.test(value);

export function turnCommand(permissions: string, model: string, chat: string | undefined): string[] {
  if (!MODEL.test(model)) throw new Error(`not a model name: ${JSON.stringify(model)}`);
  if (chat !== undefined && !isChatId(chat)) throw new Error('not a chat id');
  return ['sh', '-c', TURN_LAUNCH, 'cursor', LOGIN_FILE_MOUNT, permissions, model, chat ?? ''];
}

export function interactiveCommand(permissions: string, model: string, chat: string): string[] {
  if (!MODEL.test(model)) throw new Error(`not a model name: ${JSON.stringify(model)}`);
  if (!isChatId(chat)) throw new Error('not a chat id');
  return ['sh', '-c', INTERACTIVE_LAUNCH, 'cursor', LOGIN_FILE_MOUNT, permissions, model, chat];
}
