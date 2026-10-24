// Cursor's permissions file, compiled from the policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_FILE_MOUNT } from '../../../src/container/session-runtime.ts';
import { cursorPermissions } from '../../../src/session/adapters/cursor/permissions.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../../../src/session/policy.ts';

const policy = (extra: Partial<Policy> = {}): Policy => ({
  role: 'author', base: 'main', workdir: '/workspace', scripts: ['test', 'build'], credentialFile: LOGIN_FILE_MOUNT, safeCommands: DEFAULT_SAFE_COMMANDS,
  allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [], ...extra,
});

test('an author: reads and writes in the checkout, the safe commands word by word, and a deny list that wins', () => {
  const { permissions } = cursorPermissions(policy());
  assert.ok(permissions.allow.includes('Read(/workspace/**)'));
  assert.ok(permissions.allow.includes('Write(/workspace/**)'));
  assert.ok(permissions.allow.includes('Shell(npm:test)'));
  assert.ok(permissions.allow.includes('Shell(npm:run build)'));
  assert.ok(permissions.allow.includes('Shell(git:commit *)'));
  assert.ok(permissions.allow.includes('Shell(pwd)'));
  for (const denied of ['Read(**/.env)', 'Read(/proc/*/environ)', `Read(${LOGIN_FILE_MOUNT})`, 'Write(**/.git/**)', 'Write(**/.cursor/**)', 'Write(**/CLAUDE.md)', 'Shell(printenv)', 'Shell(curl)', 'Shell(sudo)']) {
    assert.ok(permissions.deny.includes(denied), denied);
    assert.ok(!permissions.allow.includes(denied));
  }
});

test('a reviewer or a reader writes nothing; an author whose plan waits writes only HANDOVER.md; the lead runs no command', () => {
  assert.ok(!cursorPermissions(policy({ role: 'reviewer' })).permissions.allow.includes('Write(/workspace/**)'));
  assert.ok(!cursorPermissions(policy({ role: 'reader' })).permissions.allow.some((token) => token.startsWith('Write(')));
  const planning = cursorPermissions(policy({ planning: true })).permissions.allow;
  assert.ok(planning.includes('Write(/workspace/HANDOVER.md)') && !planning.includes('Write(/workspace/**)'));
  assert.ok(!cursorPermissions(policy({ role: 'lead' })).permissions.allow.some((token) => token.startsWith('Shell(')));
});

test('nothing is allowed that is also denied, and the file is plain JSON', () => {
  const value = cursorPermissions(policy({ safeCommands: ['curl *', 'env', 'ls'] }));
  assert.ok(!value.permissions.allow.some((token) => value.permissions.deny.includes(token)));
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('the policy denies a session\'s own write to the folder where its Cursor permissions live, and the checkout keeps it out of git', async () => {
  const { evaluate } = await import('../../../src/session/policy.ts');
  const { EXCLUDED } = await import('../../../src/workspace/checkout.ts');
  const verdict = evaluate({ tool: 'Write', input: { file_path: '/workspace/.cursor/cli.json', content: '{}' } }, policy());
  assert.notEqual(verdict.decision, 'allow');
  assert.ok(EXCLUDED.includes('/.cursor/'));
});

test('a shell read of the credential file is refused by the policy, the second layer, since `cat` is not denied in the first', async () => {
  const { evaluate } = await import('../../../src/session/policy.ts');
  for (const command of [`cat ${LOGIN_FILE_MOUNT}`, `head -c 10 ${LOGIN_FILE_MOUNT}`, 'cat /proc/self/environ', 'printenv']) {
    assert.equal(evaluate({ tool: 'Bash', input: { command } }, policy()).decision, 'deny', command);
  }
});
