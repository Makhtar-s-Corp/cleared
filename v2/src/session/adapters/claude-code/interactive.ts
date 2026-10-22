// Claude Code for a human, at the web terminal of a session taken over
// (owner request of 2026-10-22 17:26): the session's own harness, resumed
// on the same session (`claude --resume <id>`, no fork, so the transcript
// the runner takes back at Give back holds what the human did), on the
// session's model, in its container, as its user, in its checkout.
//
// The login is the session's: the file the runner reads, mounted read only
// at LOGIN_FILE_MOUNT, a token or a credentials file of which only the
// access token is given, as the runner gives it (images/session/runner/
// main.ts). The launcher reads it inside the container into the harness's
// environment only: it is never a word of a command line (the host's `ps`
// and `docker inspect` would show it), never printed, never journaled. The
// harness's own tools then see it in their environment, as the runner's
// harness's do (issue 147).
//
// The command is fixed words, the session id, its model, the program that
// reads the login and the login file's mount point; the terminal wraps it
// so that its close finds it (terminal/container.ts).
import { LOGIN_FILE_MOUNT } from '../../../container/session-runtime.ts';
import { GIT_IDENTITY } from '../../../../images/session/runner/main.ts';

export const INTERACTIVE_NAME = 'Claude Code';

// Prints the login's token to its standard output, which the launcher reads
// through a pipe; exits 3 when there is none. The same reading as the
// runner's loginToken.
export const LOGIN_TOKEN_PROGRAM = String.raw`
const fs = require('node:fs');
let text = '';
try { text = fs.readFileSync(process.argv[1], 'utf8').trim(); } catch {}
let token = text;
if (text.startsWith('{')) {
  try { const oauth = JSON.parse(text).claudeAiOauth; token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : ''; } catch { token = ''; }
}
if (!token) process.exit(3);
process.stdout.write(token);
`;

const identity = Object.entries(GIT_IDENTITY).map(([name, value]) => `${name}='${value}'`).join(' ');

// sh, with $1 the session, $2 its model, $3 the program above, $4 the login file.
export const INTERACTIVE_LAUNCH = [
  't=$(node -e "$3" -- "$4") || t=\'\'',
  'if [ -z "$t" ]; then echo "Cleared: no login in the session\'s container: the harness cannot start. Open the Shell instead." >&2; exit 3; fi',
  'CLAUDE_CODE_OAUTH_TOKEN=$t; export CLAUDE_CODE_OAUTH_TOKEN; unset t ANTHROPIC_API_KEY',
  `export ${identity}`,
  'exec claude --resume "$1" --model "$2"',
].join('\n');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]*$/;

export function interactiveCommand(session: string, model: string): string[] {
  if (!SESSION_ID.test(session)) throw new Error(`not a session id: ${JSON.stringify(session)}`);
  if (!MODEL.test(model)) throw new Error(`not a model name: ${JSON.stringify(model)}`);
  return ['sh', '-c', INTERACTIVE_LAUNCH, 'claude-code', session, model, LOGIN_TOKEN_PROGRAM, LOGIN_FILE_MOUNT];
}
