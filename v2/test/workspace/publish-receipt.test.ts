// The proof receipt in the pull request's body (issue #326, P210): first in
// the body, in the project's language ([owner] language of its committed
// agents.conf at the base), kept when the guard refuses the report, and put
// in place of the old one when an open pull request is reused. A fake gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECEIPT_END, RECEIPT_START, type ReceiptData } from '../../src/flow/receipt.ts';
import { publish, type PublishInput } from '../../src/workspace/publish.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import { AGENTS_CONF, commit, remote, tempDir, writeFiles } from './git.ts';

const BRANCH = 'cleared/DEMO-7';
const PR_URL = 'https://github.com/example/guestbook/pull/7';

// gh answers `pr list` with `open`, `pr view --json body` with the body of
// a file, `pr create` with an address, and records `pr edit`'s body.
function fakeGh(root: string, open: unknown[], body: string) {
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  writeFiles(bin, {
    gh: `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--body-file');
const body = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body }) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(open))} + '\\n');
else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify({ body: ${JSON.stringify(body)} }) + '\\n');
else if (args[0] === 'pr' && (args[1] === 'create' || args[1] === 'edit')) process.stdout.write(${JSON.stringify(PR_URL)} + '\\n');
else process.exit(3);
`,
  });
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = (): { args: string[]; body: string | null }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls };
}

async function setup(options: { conf?: string; open?: unknown[]; body?: string } = {}) {
  const root = tempDir('publish-receipt');
  const url = remote({ 'src/app.ts': 'export const order = "oldest";\n', '.cleared/agents.conf': options.conf ?? AGENTS_CONF });
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: BRANCH });
  const gh = fakeGh(root, options.open ?? [], options.body ?? '');
  const input: PublishInput = { project: project.dir, workdir, base: 'main', branch: BRANCH, repo: 'example/guestbook', ticket: 'DEMO-7', gitEnv: process.env, ghEnv: gh.env };
  commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Show the newest entry first');
  return { input, gh };
}

const receipt: ReceiptData = {
  ticket: 'DEMO-7', tests: [{ round: 1, command: 'npm test', outcome: 'passed' }], testsDeclared: true,
  tokens: 4200, costUsd: 0.4, elapsedMs: 30 * 60_000,
  captures: [{ service: 'guestbook', before: 'before.png', after: 'after.png', video: 'flow.webm', videoMs: 20_000, missing: [] }],
  linkBase: 'https://cleared.example.invalid',
};

test('the receipt opens the body, before the report and the commits', async () => {
  const { input, gh } = await setup();
  await publish({ ...input, report: '## Done\nThe list is sorted.\n', receipt });
  const body = gh.calls().find((c) => c.args[1] === 'create')?.body ?? '';
  assert.ok(body.startsWith(`${RECEIPT_START}\n### Proof receipt\n`), body);
  assert.ok(body.indexOf(RECEIPT_END) < body.indexOf('The list is sorted'), body);
  assert.match(body, /Round 1: `npm test` passed/);
  assert.match(body, /4,200 tokens/);
  assert.ok(body.includes('- Show the newest entry first'));
});

test('the receipt is in the project\'s language: [owner] language at the base', async () => {
  const { input, gh } = await setup({ conf: `${AGENTS_CONF}[owner]\nlanguage = fr\n` });
  await publish({ ...input, report: '## Done\nTrié.\n', receipt });
  const body = gh.calls().find((c) => c.args[1] === 'create')?.body ?? '';
  assert.match(body, /^### Reçu de preuve$/m);
  assert.match(body, /Tour 1\u00a0: `npm test` a réussi/);
});

test('a report the guard refuses is left out, the receipt stays', async () => {
  const { input, gh } = await setup();
  const address = ['someone', 'gmail.com'].join('@');
  await publish({ ...input, report: `## Done\nAsked ${address} for the copy.\n`, receipt });
  const body = gh.calls().find((c) => c.args[1] === 'create')?.body ?? '';
  assert.ok(!body.includes('Asked'), 'the report is left out');
  assert.ok(body.startsWith(RECEIPT_START), body);
  assert.ok(body.includes('- Show the newest entry first'));
});

test('an open pull request reused gets the new receipt in place of the old one, the rest of its body kept', async () => {
  const old = `${RECEIPT_START}\n### Proof receipt\n- old\n${RECEIPT_END}\n\nThe first round's report.`;
  const { input, gh } = await setup({ open: [{ number: 5, url: 'https://github.com/example/guestbook/pull/5' }], body: old });
  const result = await publish({ ...input, receipt });
  assert.equal(result.created, false);
  const calls = gh.calls();
  assert.deepEqual(calls.map((c) => c.args[1]), ['list', 'view', 'edit']);
  const edit = calls[2]!;
  assert.equal(edit.args[2], '5');
  assert.ok(edit.body?.startsWith(`${RECEIPT_START}\n### Proof receipt\n`), edit.body ?? '');
  assert.ok(!edit.body?.includes('- old'));
  assert.ok(edit.body?.endsWith("The first round's report."), edit.body ?? '');
});

test('no receipt given: the body is as before, and a reused pull request is not edited', async () => {
  const { input, gh } = await setup({ open: [{ number: 5, url: 'https://github.com/example/guestbook/pull/5' }] });
  await publish(input);
  assert.deepEqual(gh.calls().map((c) => c.args[1]), ['list']);
});
