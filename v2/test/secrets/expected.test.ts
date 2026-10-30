// The test secrets' names read from a repository (the owner's request of
// 2026-10-30): the step prefills them; with none it skips itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asked, expectedSecrets, namesIn } from '../../src/secrets/expected.ts';

test('each kind of file gives its names; a source file outside the tests gives none', () => {
  assert.deepEqual(namesIn('.env.example', 'PORT=3000\n# a comment\nexport STRIPE_TEST_KEY=\nMAIL_TOKEN=abc\n'), ['PORT', 'STRIPE_TEST_KEY', 'MAIL_TOKEN']);
  assert.deepEqual(namesIn('test/pay.test.ts', 'const a = process.env.STRIPE_KEY; const b = process.env["MAIL_TOKEN"];'), ['STRIPE_KEY', 'MAIL_TOKEN']);
  assert.deepEqual(namesIn('tests/test_pay.py', 'os.environ["PAY_SECRET"]; os.getenv("PAY_PASSWORD")'), ['PAY_SECRET', 'PAY_PASSWORD']);
  assert.deepEqual(namesIn('.github/workflows/ci.yml', 'env:\n  KEY: ${{ secrets.SANDBOX_API_KEY }}'), ['SANDBOX_API_KEY']);
  assert.deepEqual(namesIn('src/pay.ts', 'process.env.STRIPE_KEY'), []);
});

test('a name counts when it looks like a secret and the platform does not give it', () => {
  assert.equal(asked('STRIPE_TEST_KEY'), true);
  assert.equal(asked('PORT'), false);
  assert.equal(asked('NODE_ENV'), false);
  assert.equal(asked('GITHUB_TOKEN'), false);
  assert.equal(asked('CLEARED_V2_TOKEN'), false);
});

test('read from the base branch: names and where they came from, never a value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-expected-'));
  try {
    const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    const put = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
    put('.env.example', 'STRIPE_TEST_KEY=value-in-the-example\nPORT=1\n');
    put('test/mail.test.ts', 'process.env.MAILER_SANDBOX_TOKEN');
    put('src/app.ts', 'process.env.PROD_ONLY_KEY');
    run('add', '-A');
    run('commit', '-qm', 'one');
    run('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const names = await expectedSecrets({ dir, base: 'main' });
    assert.deepEqual(names, [{ name: 'STRIPE_TEST_KEY', from: '.env.example' }, { name: 'MAILER_SANDBOX_TOKEN', from: 'test/mail.test.ts' }]);
    assert.ok(!JSON.stringify(names).includes('value-in-the-example'));
    assert.deepEqual(await expectedSecrets({ dir, base: 'missing' }), [], 'a base not fetched yet reads as nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
