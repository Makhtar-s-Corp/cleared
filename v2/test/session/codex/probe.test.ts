// The Codex probe never logs in, never runs a turn and never spends:
// stand-in programs only, this machine's own Codex is never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCodexProbe, probeCodex } from '../../../src/session/adapters/codex/probe.ts';
import type { ProbeRun } from '../../../src/session/adapters/cursor/probe.ts';

const script = (table: Record<string, { code: number; out: string }>): { run: ProbeRun; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: async (program, args) => {
      calls.push(`${program} ${args.join(' ')}`);
      const answer = program === 'codex' ? table[args.join(' ')] : undefined;
      return answer ? { code: answer.code, stdout: answer.out, stderr: '' } : 'missing';
    },
  };
};

test('not installed: said so, and nothing else is run', async () => {
  const fake = script({});
  const probe = await probeCodex({ run: fake.run, env: {} });
  assert.deepEqual(probe, { state: 'not_installed' });
  assert.deepEqual(fake.calls, ['codex --version']);
  assert.match(describeCodexProbe(probe), /not installed/);
});

test('installed, not signed in: reported as such; only --version and `login status` are run, never a login or a turn', async () => {
  const fake = script({ '--version': { code: 0, out: 'codex-cli 0.163.0\n' }, 'login status': { code: 1, out: 'Not logged in\n' } });
  const probe = await probeCodex({ run: fake.run, env: {} });
  assert.deepEqual(probe, { state: 'not_signed_in', version: '0.163.0' });
  assert.deepEqual(fake.calls, ['codex --version', 'codex login status']);
  assert.match(describeCodexProbe(probe), /not signed in.*codex login.*never does it/);
});

test('signed in by a login, or an API key set (its value never in the answer, `login status` not even run)', async () => {
  const login = script({ '--version': { code: 0, out: 'codex-cli 0.163.0' }, 'login status': { code: 0, out: 'Logged in using ChatGPT\n' } });
  assert.deepEqual(await probeCodex({ run: login.run, env: {} }), { state: 'ready', version: '0.163.0', via: 'login' });
  const key = script({ '--version': { code: 0, out: 'codex-cli 0.163.0' } });
  const value = ['sk', 'never', 'shown'].join('-');
  const probe = await probeCodex({ run: key.run, env: { CODEX_API_KEY: value } });
  assert.deepEqual(probe, { state: 'ready', version: '0.163.0', via: 'api_key' });
  assert.deepEqual(key.calls, ['codex --version']);
  assert.ok(!describeCodexProbe(probe).includes(value));
});

test('a status that exits 0 but says nothing known is not a login', async () => {
  const fake = script({ '--version': { code: 0, out: '0.163.0' }, 'login status': { code: 0, out: 'Run codex login to continue' } });
  assert.equal((await probeCodex({ run: fake.run, env: {} })).state, 'not_signed_in');
});
