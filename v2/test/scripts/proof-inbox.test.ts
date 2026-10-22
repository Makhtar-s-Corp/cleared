// What the proofs do in the inbox, as the owner would: run 6 of the
// milestone 1 proof gave up because the request the message asked for was
// not there yet, behind another request of the same session; issue 157
// (item 4) found that the proof allowed once almost every request. The
// milestone 2 proof works the inbox in the morning: permissions, then the
// plan, then the releases whose checks are green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerFor, inboxAction, insideCheckout, morningAction, type InboxEntry } from '../../scripts/proof-inbox.ts';

const target = 'rm -r /tmp/cleared-proof-scratch';

test('the request the message asked for is allowed once when it waits', () => {
  assert.deepEqual(inboxAction([{ detail: 'Wants to run npm test' }, { detail: `Wants to run ${target}` }], target), { kind: 'target', index: 1 });
});

test('before it comes, another request of the ticket is answered from the inbox, and the run waits', () => {
  // Run 6: only "npm test" waited when the inbox was read; the target came 5 seconds later.
  assert.deepEqual(inboxAction([{ detail: 'Wants to run npm test 2>&1 | tail -15; npm run typecheck', command: 'npm test 2>&1 | tail -15; npm run typecheck' }], target), { kind: 'other', index: 0, decision: 'allow_once' });
  assert.deepEqual(inboxAction([{ detail: 'Wants to run npm view embedded-postgres version', command: 'npm view embedded-postgres version' }], target), { kind: 'other', index: 0, decision: 'reject_once' });
  assert.deepEqual(inboxAction([], target), { kind: 'wait' });
});

test('work inside the checkout is allowed once; everything else is denied (issue 157, item 4)', () => {
  for (const command of [
    'npm test', 'npm test 2>&1 | tail -20', 'npm run typecheck; npm test', 'npm ci', 'node --test test/entries.test.ts',
    'npx tsc --noEmit', 'git status', 'git add src/store.ts && git commit -m "Trim names"', 'git diff HEAD~1 -- src/',
    'ls -la src', 'cat src/page.ts | head -50', 'grep -rn entries src test', 'sed -n 1,40p src/server.ts', 'mkdir -p test/fixtures',
    'touch test/fixtures/entries.json', 'rm -r test/tmp', 'cp README.md /workspace/notes.md', 'npm test > /dev/null 2>&1',
    'NODE_ENV=test npm test', 'cd /workspace && npm test',
  ]) assert.equal(insideCheckout(command), true, command);
  for (const command of [
    'npm install date-fns', 'npm i -D vitest', 'npm view embedded-postgres version', 'npx prettier --write .', 'curl https://example.invalid',
    'wget x', 'sudo apt-get install jq', 'pip install x', 'ssh host', 'git push origin main', 'git fetch origin', 'git config user.name x',
    'rm -r /tmp/cleared-proof-scratch', 'cat ../other/secret', 'cat ~/.ssh/id_ed25519', 'ls /etc', 'npm test > /tmp/out',
    'echo $(id) | tail', 'echo `id`', 'bash -c "npm test"', 'python3 -c "print(1)"', 'docker ps', 'env', '',
    'cp README.md /workspace/../etc/x',
  ]) assert.equal(insideCheckout(command), false, command);
  assert.equal(answerFor('npm test'), 'allow_once');
  assert.equal(answerFor('npm install x'), 'reject_once');
});

const release = (id: string, checks: 'pending' | 'passed' | 'failed', ticket = 'LOCAL-1'): InboxEntry => ({ id, kind: 'release', ticket, checks });

test('in the morning: permissions first, then the plan, then releases whose checks passed, oldest first', () => {
  const entries: InboxEntry[] = [
    release('release:1', 'passed'),
    { id: 'permission:s1:r1', kind: 'permission', ticket: 'LOCAL-2', command: 'npm view x' },
    { id: 'plan:p1', kind: 'plan', ticket: 'lead' },
  ];
  assert.deepEqual(morningAction(entries, { releases: true, plan: true }), { kind: 'permission', id: 'permission:s1:r1', decision: 'reject_once' });
  assert.deepEqual(morningAction(entries.slice(0, 1).concat(entries.slice(2)), { releases: true, plan: true }), { kind: 'plan', id: 'plan:p1' });
  assert.deepEqual(morningAction([release('release:1', 'pending'), release('release:2', 'passed', 'LOCAL-2')], { releases: true, plan: true }), { kind: 'release', id: 'release:2' });
});

test('what the morning leaves: pending or failed checks, questions, and the releases the owner approves', () => {
  assert.deepEqual(morningAction([release('release:1', 'pending')], { releases: true, plan: true }), { kind: 'wait', left: ['release:1 (checks pending)'] });
  assert.deepEqual(morningAction([release('release:1', 'failed')], { releases: true, plan: true }), { kind: 'wait', left: ['release:1 (checks failed)'] });
  assert.deepEqual(morningAction([{ id: 'question:s1:q1', kind: 'question', ticket: 'LOCAL-3' }], { releases: true, plan: true }), { kind: 'wait', left: ['question:s1:q1 (a question, for the owner)'] });
  // PROOF_OWNER_APPROVES=1: the owner approves the releases; the proof still answers nothing else for them.
  assert.deepEqual(morningAction([release('release:1', 'passed')], { releases: false, plan: true }), { kind: 'wait', left: ['release:1 (the owner approves)'] });
  assert.deepEqual(morningAction([{ id: 'plan:p1', kind: 'plan', ticket: 'lead' }], { releases: true, plan: false }), { kind: 'wait', left: ['plan:p1 (the owner approves)'] });
  assert.deepEqual(morningAction([], { releases: true, plan: true }), { kind: 'wait', left: [] });
});
