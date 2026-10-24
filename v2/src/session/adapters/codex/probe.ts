// Is Codex usable on this machine? A probe that never logs in, never creates
// an account and never spends: it runs `codex --version`, then `codex login
// status` (Codex's read-only report of its stored login), and says one of
// three things. Only the state is reported, never a word of the program's
// output.
//   not_installed   `codex` is not on the PATH
//   not_signed_in   installed, but `login status` does not report a login
//                   and CODEX_API_KEY is not set
//   ready           installed and signed in (or an API key is set)
// The sessions themselves use the key file (CLEARED_CODEX_API_KEY_FILE),
// never this machine's login: `ready` says the program runs here.
import { runProgram, type ProbeRun } from '../cursor/probe.ts';

export type CodexProbe =
  | { readonly state: 'not_installed' }
  | { readonly state: 'not_signed_in'; readonly version: string }
  | { readonly state: 'ready'; readonly version: string; readonly via: 'login' | 'api_key' };

const SIGNED_OUT = /not\s+(?:logged|signed)\s+in|no\s+(?:active\s+)?(?:account|session|login|credentials)|log\s*in\s+required/i;
const SIGNED_IN = /logged\s+in|signed\s+in/i;
const VERSION = /\d+(?:\.\d+){1,3}/;

export async function probeCodex(options: { readonly run?: ProbeRun; readonly env?: NodeJS.ProcessEnv } = {}): Promise<CodexProbe> {
  const run = options.run ?? runProgram;
  const env = options.env ?? process.env;
  const version = await run('codex', ['--version']);
  if (version === 'missing') return { state: 'not_installed' };
  const number = VERSION.exec(version.stdout + version.stderr)?.[0] ?? 'unknown';
  if (env.CODEX_API_KEY) return { state: 'ready', version: number, via: 'api_key' };
  const status = await run('codex', ['login', 'status']);
  if (status === 'missing') return { state: 'not_installed' };
  const text = status.stdout + status.stderr;
  if (status.code === 0 && !SIGNED_OUT.test(text) && SIGNED_IN.test(text)) return { state: 'ready', version: number, via: 'login' };
  return { state: 'not_signed_in', version: number };
}

// One line for a person, in the doctor's style.
export function describeCodexProbe(probe: CodexProbe): string {
  switch (probe.state) {
    case 'not_installed': return 'Codex is not installed here (codex is not on the PATH).';
    case 'not_signed_in': return `Codex ${probe.version} is installed but not signed in. Sign in once yourself with \`codex login\`, or set CODEX_API_KEY; Cleared never does it.`;
    case 'ready': return `Codex ${probe.version} is installed and signed in${probe.via === 'api_key' ? ' with an API key' : ''}.`;
  }
}
