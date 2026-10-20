// #116: what a session leaves uncommitted in its lane is committed by the dispatcher after it, in every mode (shared
// uid or [security] agent_user), with the dispatcher's identity; never in the project's main checkout, never for a
// role whose work is not pushed, and what a model committed by itself keeps its authorship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { laneWithRemote, scratch } from './support.mjs';

const HANDOVER = '## Done\nThe glossary\n## Tried and failed, and why\nNothing\n## Left to do\nNothing\n## Where the artifacts are (screenshots, logs, branches)\nNone\n## Open questions\nNone\n';

// A lane dev/X-1 with a remote, in shared-uid mode (the sandbox's: allow_shared_uid = true, no agent_user), or under
// [security] agent_user. No git identity of the account: HOME is the sandbox's.
function lane({ agentUser = false, memory = false } = {}) {
  const l = laneWithRemote('dev/X-1', null);
  const { box } = l;
  const confPath = join(box.home, 'agents.conf');
  let conf = readFileSync(confPath, 'utf8');
  if (agentUser) conf = conf.replace('[security]\nallow_shared_uid = true\n', '[security]\nallow_shared_uid = true\nagent_user = nobody\n');
  if (memory) conf += '\n[memory]\nenabled = true\n';
  writeFileSync(confPath, conf);
  if (memory) {
    // As spawn-lane.sh leaves it when memory is on.
    const common = execFileSync('git', ['-C', l.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    mkdirSync(join(common, 'info'), { recursive: true });
    writeFileSync(join(common, 'info', 'exclude'), '/HANDOVER.md\n', { flag: 'a' });
  }
  const env = { ...box.env, HOME: box.home };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const base = git(l.path, 'rev-parse', 'HEAD');
  // One session of the lane: the fake model runs FAKE_LEAVES in its worktree (or wherever it is started).
  const session = (leaves, { role = 'dev', cwd = l.path, exit = 0 } = {}) => {
    const runDir = scratch('cleared-lane-commit-run-');
    writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
    writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
    writeFileSync(join(runDir, 'lane.env'), `ORCH_LANE=${role}/X-1\nORCH_TICKET=X-1\nORCH_ROLE=${role}\nORCH_RUN_BASE=X-1-commit\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n`);
    const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd, env: { ...env, FAKE_LEAVES: leaves, FIRST_EXIT: String(exit) }, encoding: 'utf8' });
    return { ...run, comment: readFileSync(join(runDir, 'comment.md'), 'utf8') };
  };
  const files = (ref = 'HEAD') => git(l.path, 'show', '--format=', '--name-only', ref).split('\n').filter(Boolean).sort();
  return { ...l, env, git, base, session, files };
}

// What the light author of #116 did: its change staged, another left as it is, no commit (no identity).
const STAGED_NOT_COMMITTED = 'mkdir -p docs; echo "Glossary" > docs/glossary.md; git add docs/glossary.md; echo "a note" > notes.txt';

for (const agentUser of [false, true]) {
  test(`${agentUser ? 'under [security] agent_user' : 'in shared-uid mode'}, what a session leaves uncommitted is committed after it with the dispatcher's identity, and sent`, () => {
    const l = lane({ agentUser });
    const run = l.session(STAGED_NOT_COMMITTED);
    assert.equal(run.status, 0, run.stderr);
    assert.notEqual(l.git(l.path, 'rev-parse', 'HEAD'), l.base);
    assert.equal(l.git(l.path, 'log', '-1', '--format=%s|%an <%ae>|%cn <%ce>'), 'chore: the work of a on X-1|dispatcher <dispatcher@localhost>|dispatcher <dispatcher@localhost>');
    assert.deepEqual(l.files(), ['docs/glossary.md', 'notes.txt']);
    assert.equal(l.git(l.path, 'status', '--porcelain'), '');
    assert.equal(l.git(l.path, 'rev-list', '--count', 'main..HEAD'), '1');
    // The branch left with it.
    assert.match(run.comment, /Pull request opened or updated: #41/);
    assert.ok(l.onRemote().includes(`dev/X-1 ${l.git(l.path, 'rev-parse', '--short', 'HEAD')}`), l.onRemote().join('\n'));
  });
}

test('a clean worktree gets no commit: nothing to do, nothing to push', () => {
  const l = lane();
  const run = l.session('true');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(l.git(l.path, 'rev-parse', 'HEAD'), l.base);
  assert.match(run.comment, /Nothing to push: the team has no commit/);
});

test('a model that committed by itself is left alone: its commit keeps its author and is not amended, and nothing is added', () => {
  const l = lane();
  const run = l.session('echo "Glossary" > glossary.md; git add -A; git -c user.name=Model -c user.email=model@example.invalid commit -qm "docs: the glossary"');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(l.git(l.path, 'rev-list', '--count', 'main..HEAD'), '1');
  assert.equal(l.git(l.path, 'log', '-1', '--format=%s|%an <%ae>|%cn <%ce>'), 'docs: the glossary|Model <model@example.invalid>|Model <model@example.invalid>');
});

test('the project\'s main checkout, where the acting lead works, is never committed, whatever is left in it', () => {
  const l = lane();
  const before = l.git(l.box.repo, 'rev-parse', 'HEAD');
  const run = l.session('echo "left" > stray.txt; git add stray.txt', { cwd: l.box.repo });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(l.git(l.box.repo, 'rev-parse', 'HEAD'), before);
  assert.match(l.git(l.box.repo, 'status', '--porcelain'), /^A {2}stray\.txt$/m);
});

test('a role whose work is not pushed ([lanes] push_roles) is not committed for; nor is a session that failed', () => {
  const l = lane();
  const review = l.session('echo "left" > review-notes.txt', { role: 'review' });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(l.git(l.path, 'rev-parse', 'HEAD'), l.base);
  assert.match(l.git(l.path, 'status', '--porcelain'), /review-notes\.txt/);
  const failed = l.session('echo "half" > half.txt', { exit: 1 });
  assert.equal(failed.status, 1);
  assert.equal(l.git(l.path, 'rev-parse', 'HEAD'), l.base);
});

test('what is swept into the dispatcher\'s commit is the same in both modes: never HANDOVER.md nor .commit-message, the message the model wrote', () => {
  const leaves = `printf "${HANDOVER.replaceAll('\n', '\\n')}" > HANDOVER.md; printf 'docs: the glossary\\n\\nAs the ticket asks.\\n' > .commit-message; echo "Glossary" > glossary.md; mkdir -p .dashboard; echo "<p>" > .dashboard/index.html`;
  const seen = [false, true].map((agentUser) => {
    const l = lane({ agentUser, memory: true });
    const run = l.session(leaves);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(l.git(l.path, 'log', '-1', '--format=%B'), 'docs: the glossary\n\nAs the ticket asks.');
    assert.equal(l.git(l.path, 'status', '--porcelain', '--ignored', '--', 'HANDOVER.md', '.commit-message'), '', 'the handover was taken by the memory, the message file removed');
    return l.files();
  });
  assert.deepEqual(seen[0], seen[1], 'shared-uid mode commits exactly what agent_user mode commits');
  for (const files of seen) {
    assert.ok(files.includes('glossary.md'));
    assert.ok(!files.includes('HANDOVER.md'));
    assert.ok(!files.includes('.commit-message'));
  }
});
