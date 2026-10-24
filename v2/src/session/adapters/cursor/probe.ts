// Is Cursor usable on this machine? A probe that never logs in, never
// creates an account and never spends: it runs `--version`, then `status`
// (Cursor's read-only authentication report), and says one of three things.
// Only the state is reported, never a word of the program's output.
//   not_installed   neither `agent` nor `cursor-agent` is on the PATH
//   not_signed_in   installed, but `status` does not report a signed-in
//                   account and CURSOR_API_KEY is not set
//   ready           installed and signed in (or an API key is set)
import { spawn } from 'node:child_process';

export type CursorProbe =
  | { readonly state: 'not_installed' }
  | { readonly state: 'not_signed_in'; readonly program: string; readonly version: string }
  | { readonly state: 'ready'; readonly program: string; readonly version: string; readonly via: 'login' | 'api_key' };

export type ProbeRun = (program: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string } | 'missing'>;

export const PROGRAMS: readonly string[] = ['agent', 'cursor-agent'];

export const runProgram: ProbeRun = (program, args) => new Promise((resolve) => {
  const child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  timer.unref();
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 8192) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
  child.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code === 'ENOENT' ? 'missing' : { code: 127, stdout, stderr }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
});

const SIGNED_OUT = /not\s+(?:logged|signed)\s+in|no\s+(?:active\s+)?(?:account|session|login)|log\s*in\s+required|unauthori[sz]ed|run\s+['"`]?\S*\s*login/i;
const SIGNED_IN = /logged\s+in|signed\s+in|authenticated|account/i;
const VERSION = /\d+(?:\.\d+){1,3}/;

export async function probeCursor(options: { readonly run?: ProbeRun; readonly env?: NodeJS.ProcessEnv } = {}): Promise<CursorProbe> {
  const run = options.run ?? runProgram;
  const env = options.env ?? process.env;
  for (const program of PROGRAMS) {
    const version = await run(program, ['--version']);
    if (version === 'missing') continue;
    const number = VERSION.exec(version.stdout + version.stderr)?.[0] ?? 'unknown';
    if (env.CURSOR_API_KEY) return { state: 'ready', program, version: number, via: 'api_key' };
    const status = await run(program, ['status']);
    if (status === 'missing') continue;
    const text = status.stdout + status.stderr;
    if (status.code === 0 && !SIGNED_OUT.test(text) && SIGNED_IN.test(text)) return { state: 'ready', program, version: number, via: 'login' };
    return { state: 'not_signed_in', program, version: number };
  }
  return { state: 'not_installed' };
}

// One line for a person, in the doctor's style.
export function describeProbe(probe: CursorProbe): string {
  switch (probe.state) {
    case 'not_installed': return 'Cursor is not installed here (neither agent nor cursor-agent is on the PATH). Install it from cursor.com/cli.';
    case 'not_signed_in': return `Cursor ${probe.version} is installed but not signed in. Sign in once yourself with \`${probe.program} login\`, or set CURSOR_API_KEY; Cleared never does it.`;
    case 'ready': return `Cursor ${probe.version} is installed and signed in${probe.via === 'api_key' ? ' with an API key' : ''}.`;
  }
}
