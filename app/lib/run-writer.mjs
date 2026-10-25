// Starts app/human-write.mjs for one gesture. An agreement is written under the
// same lock as ask-validation.ts and merge-pr.ts (state/merge.lock), so the
// version checked is still the version on record when the move is made.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../../lib/conf.mjs';

const writer = join(dirname(fileURLToPath(import.meta.url)), '..', 'human-write.mjs');

export function runWriter(request, { state = stateDir(), env = process.env, timeoutMs = 90000 } = {}) {
  const command = request.op !== 'answer'
    ? ['flock', ['-x', '-w', '30', join(state, 'merge.lock'), process.execPath, writer]]
    : [process.execPath, [writer]];
  return new Promise((resolve) => {
    const child = spawn(command[0], command[1], { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    let out = '';
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (out.length < 20000) out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'failed', message: 'the writer could not start' }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').at(-1))); }
      catch { resolve({ ok: false, code: 'failed', message: 'the writer gave no answer (a lock may be held: try again)' }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
