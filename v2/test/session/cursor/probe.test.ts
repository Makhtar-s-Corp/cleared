// The probe never logs in and never spends: stand-in programs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeProbe, probeCursor, runProgram, type ProbeRun } from '../../../src/session/adapters/cursor/probe.ts';

const script = (table: Record<string, Record<string, { code: number; out: string }>>): { run: ProbeRun; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: async (program, args) => {
      calls.push(`${program} ${args.join(' ')}`);
      const answer = table[program]?.[args.join(' ')];
      return answer ? { code: answer.code, stdout: answer.out, stderr: '' } : 'missing';
    },
  };
};

test('neither program installed: not installed, and the sentence says how', async () => {
  const probe = await probeCursor({ run: script({}).run, env: {} });
  assert.deepEqual(probe, { state: 'not_installed' });
  assert.match(describeProbe(probe), /not installed.*agent nor cursor-agent/);
});

test('installed, not signed in: reported as such, and `login` is never run', async () => {
  const fake = script({ agent: { '--version': { code: 0, out: '2026.10.20-abc\n' }, status: { code: 1, out: 'Not logged in\n' } } });
  const probe = await probeCursor({ run: fake.run, env: {} });
  assert.deepEqual(probe, { state: 'not_signed_in', program: 'agent', version: '2026.10.20' });
  assert.match(describeProbe(probe), /not signed in.*login.*never does it/);
  assert.ok(fake.calls.every((call) => !/login( |$)/.test(call.replace('agent status', ''))), fake.calls.join('; '));
});

test('a status that exits 0 but says nothing known is not a signed-in account', async () => {
  const fake = script({ 'cursor-agent': { '--version': { code: 0, out: '1.2.3' }, status: { code: 0, out: 'Run login to continue' } } });
  assert.equal((await probeCursor({ run: fake.run, env: {} })).state, 'not_signed_in');
});

test('signed in by a login or by an API key (its value is never read into the answer)', async () => {
  const table = { agent: { '--version': { code: 0, out: '3.4.5' }, status: { code: 0, out: 'Logged in as someone@example.com' } } };
  const login = await probeCursor({ run: script(table).run, env: {} });
  assert.deepEqual(login, { state: 'ready', program: 'agent', version: '3.4.5', via: 'login' });
  const keyed = await probeCursor({ run: script({ agent: { '--version': { code: 0, out: '3.4.5' } } }).run, env: { CURSOR_API_KEY: ['crsr', 'test', 'value'].join('_') } });
  assert.deepEqual(keyed, { state: 'ready', program: 'agent', version: '3.4.5', via: 'api_key' });
  assert.ok(!JSON.stringify(keyed).includes('crsr_test'));
});

test('the real runner: a missing program is "missing", a present one answers', async () => {
  assert.equal(await runProgram('cleared-no-such-cursor-program', ['--version']), 'missing');
  const dir = mkdtempSync(join(tmpdir(), 'cleared-probe-'));
  try {
    const file = join(dir, 'prog');
    writeFileSync(file, '#!/bin/sh\necho 1.0.0\n');
    chmodSync(file, 0o755);
    const answer = await runProgram(file, ['--version']);
    assert.ok(answer !== 'missing' && answer.code === 0 && answer.stdout.trim() === '1.0.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
