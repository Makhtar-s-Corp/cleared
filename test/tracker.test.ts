import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, symlinkSync, mkdtempSync, readFileSync as readFile, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ORCH_HOME } from '../lib/conf.ts';
import { openLedger } from '../lib/ledger.ts';
import { LocalTracker } from '../lib/tracker/adapters/local.ts';
import { GithubTracker } from '../lib/tracker/adapters/github.ts';
import { GithubAppTokens, mintInstallationToken } from '../lib/tracker/adapters/github-auth.ts';
import { checkedImage } from '../lib/tracker/images.ts';
import { changes } from '../lib/wake.ts';
import { fixtureProject, reviewedPull, sandbox, scratch } from './support.ts';

// What the fake GitHub API is sent: the labels to add, and a GraphQL query with its variables.
type LabelsInput = { labels: string[] };
type GraphqlInput = { query: string; variables: { option: string } };

test('runtime and provider-neutral tests contain no provider name or query', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ORCH_HOME, encoding: 'utf8' }).trim().split('\n');
  const checked = files.filter((file) => {
    if (file.startsWith('lib/tracker/adapters/') || (/^(v2|examples)\//.test(file) && file.endsWith('.ts')) || file.startsWith('docs/') || file.startsWith('prompts/')
      || file === 'agents.example.conf' || file.startsWith('test/')) return false;
    // npm's lock files list registry packages by name: v2's names graphql (a package CopilotKit pulls in), not a tracker.
    if (file.endsWith('package-lock.json')) return false;
    return file === 'cleared' || /\.(?:sh|mjs|ts|jq|json|service|timer|yml|yaml)$/.test(file);
  });
  for (const file of checked) {
    const contents = readFileSync(join(ORCH_HOME, file), 'utf8');
    assert.doesNotMatch(contents, /linear|graphql|api\.linear\.app/i, file);
  }
  for (const file of files.filter((name) => name.startsWith('test/') && name.endsWith('.ts') && name !== 'test/tracker.test.ts')) {
    const contents = readFileSync(join(ORCH_HOME, file), 'utf8');
    const blocks = contents.split(/(?=^test\()/m);
    for (const block of blocks) {
      if (block.startsWith("test('[Linear adapter] ")) continue;
      assert.doesNotMatch(block, /linear|graphql|api\.linear\.app/i, `${file}: core test`);
    }
  }
});

test('local approval requires a signed human move after the request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-local-tracker-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = join(dir, 'human.key');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const conf = { sections: { tracker: { todo_state: 'Todo', validate_state: 'Review', review_state: 'Review', go_state: 'Approved',
    owner_id: 'alice', agents_uid: '99999', human_private_key: key,
    human_public_key: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64') } } };
  const db = openLedger(':memory:');
  try {
    const agents = new LocalTracker({ conf, db, actor: { kind: 'agents', id: 'cleared' } });
    const human = new LocalTracker({ conf, db, actor: { kind: 'human', id: 'alice' } });
    const ticket = agents.createTicket({ title: 'Test ticket', body: 'Test body', labels: ['test'] })!;
    assert.equal(ticket.identifier, 'LOCAL-1');
    assert.throws(() => agents.moveTicket(ticket.identifier, 'Approved'), /Only the configured human/);
    human.moveTicket(ticket.identifier, 'Approved');
    const first = agents.history(ticket.identifier).at(-1)!;
    assert.deepEqual(first.by, { kind: 'human', id: 'alice' });
    const requested = new Date(Date.parse(first.at) + 1000).toISOString();
    assert.ok(Date.parse(first.at) < Date.parse(requested));
    agents.moveTicket(ticket.identifier, 'Review');
    human.moveTicket(ticket.identifier, 'Approved');
    assert.equal(agents.history(ticket.identifier).at(-1)!.by.kind, 'human');
    db.prepare('UPDATE tracker_history SET proof = ? WHERE id = (SELECT MAX(id) FROM tracker_history)').run('forged');
    assert.equal(agents.history(ticket.identifier).at(-1)!.by.kind, 'other');
    human.comment(ticket.identifier, 'I agree');
    assert.equal(agents.comments(ticket.identifier)[0]!.byOwner, true);
    db.prepare('UPDATE tracker_comments SET body = ? WHERE id = 1').run('Forged approval');
    assert.equal(agents.comments(ticket.identifier)[0]!.byOwner, false);
    const owned = human.createTicket({ title: 'Owner title', body: 'Owner body', labels: ['work'] })!;
    assert.equal(agents.history(owned.identifier)[0]!.by.kind, 'human');
    db.prepare('UPDATE tracker_tickets SET body = ? WHERE id = 2').run('Injected instructions');
    assert.equal(agents.history(owned.identifier)[0]!.by.kind, 'other');
    assert.equal(agents.changesSince('2000-01-01T00:00:00Z').events.find((event) => event.id === '2')!.agent, true);
    db.prepare('UPDATE tracker_tickets SET body = ?, title = ? WHERE id = 2').run('Owner body', 'Injected title');
    assert.equal(agents.history(owned.identifier)[0]!.by.kind, 'other');
    chmodSync(key, 0o644);
    assert.throws(() => human.moveTicket(ticket.identifier, 'Review'), /mode 0600/);
    chmodSync(key, 0o600);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('local comment creation and editing remain visible to later wakes', () => {
  const db = openLedger(':memory:');
  const tracker = new LocalTracker({ conf: { sections: { tracker: { todo_state: 'Todo' } } }, db,
    actor: { kind: 'agents', id: 'cleared' } });
  try {
    const ticket = tracker.createTicket({ title: 'Comment updates' })!;
    db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = 1').run('2026-01-01T00:00:00Z');
    const comment = tracker.comment(ticket.identifier, 'First version')!;
    assert.equal(tracker.changesSince('2026-01-02T00:00:00Z').events.length, 1);
    db.prepare('UPDATE tracker_comments SET created_at = ? WHERE id = 1').run('2026-01-01T00:00:00Z');
    db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = 1').run('2026-01-01T00:00:00Z');
    tracker.editComment(ticket.identifier, comment.id, 'Edited version');
    const changed = tracker.changesSince('2026-01-02T00:00:00Z').events;
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.comments[0]!.body, 'Edited version');
    assert.equal(tracker.comments(ticket.identifier, { since: '2026-01-02T00:00:00Z' })[0]!.id, comment.id);
  } finally { db.close(); }
});

test('the local ticket CLI creates, reads, comments, and moves without a network service', () => {
  const box = sandbox();
  copyFileSync(join(ORCH_HOME, 'cleared.ts'), join(box.home, 'cleared.ts'));
  symlinkSync('cleared.ts', join(box.home, 'cleared'));
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFile(confPath, 'utf8').replace('adapter = local',
    `adapter = local\nowner_id = alice\nagents_uid = ${process.getuid!()}`));
  const run = (...args: string[]) => {
    const result = execFileSync(join(box.home, 'cleared'), ['ticket', ...args], { env: box.env, encoding: 'utf8' });
    return JSON.parse(result);
  };
  const ticket = run('new', 'Try local tracking');
  const wrongState: NodeJS.ProcessEnv = { ...box.env };
  delete wrongState.ORCH_STATE_DIR;
  delete wrongState.CLEARED_STATE_DIR;
  const missingState = spawnSync(join(box.home, 'cleared'), ['ticket', 'show', 'LOCAL-1'], { env: wrongState, encoding: 'utf8' });
  assert.notEqual(missingState.status, 0);
  assert.match(missingState.stderr, /CLEARED_STATE_DIR/);
  assert.equal(ticket.identifier, 'LOCAL-1');
  assert.equal(run('show', 'LOCAL-1').title, 'Try local tracking');
  const missing = spawnSync(join(box.home, 'cleared'), ['ticket', 'show', 'LOCAL-999'], { env: box.env, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No such ticket/);
  const body = join(box.home, 'comment.md');
  writeFileSync(body, 'Agent note.');
  assert.equal(run('comment', 'LOCAL-1', body).body, 'Agent note.');
  assert.equal(run('move', 'LOCAL-1', 'In Review').status, 'In Review');
  const refused = spawnSync(join(box.home, 'cleared'), ['ticket', 'move', 'LOCAL-1', 'Go MEP'], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Only the configured human/);
});

test('generic tracker comments keep the agent marker and hourly limit', () => {
  const box = sandbox();
  copyFileSync(join(ORCH_HOME, 'cleared.ts'), join(box.home, 'cleared.ts'));
  symlinkSync('cleared.ts', join(box.home, 'cleared'));
  copyFileSync(join(ORCH_HOME, 'tracker.ts'), join(box.home, 'tracker.ts'));
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFile(confPath, 'utf8').replace('adapter = local',
    `adapter = local\nowner_id = alice\nagents_uid = ${process.getuid!()}\ncomments_per_hour = 1`));
  execFileSync(join(box.home, 'cleared'), ['ticket', 'new', 'Comment limit'], { env: box.env });
  const file = join(box.home, 'note.md');
  writeFileSync(file, 'A useful update.');
  const post = () => spawnSync(join(box.home, 'tracker.ts'), ['comment', 'LOCAL-1', file, 'tester'], { env: box.env, encoding: 'utf8' });
  const first = post();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /local:\/\/ticket\/LOCAL-1/);
  const comments = JSON.parse(execFileSync(join(box.home, 'tracker.ts'), ['comments', 'LOCAL-1'], { env: box.env, encoding: 'utf8' }));
  assert.match(comments[0].body, /^> Written by an agent \(tester\)/);
  assert.equal(post().status, 4);
  assert.match(readFile(join(box.state, 'tracker-comments.jsonl'), 'utf8'), /"id":"1"/);
});

test('the shell facade reports each adapter ticket prefix for lane cleanup', () => {
  const box = sandbox();
  copyFileSync(join(ORCH_HOME, 'tracker.ts'), join(box.home, 'tracker.ts'));
  for (const [adapter, expected] of [['local', 'LOCAL'], ['github', 'GH'], ['linear', 'X']]) {
    const config = join(box.home, 'agents.conf');
    writeFileSync(config, readFile(config, 'utf8').replace(/adapter = (?:local|github|linear)/, `adapter = ${adapter}`));
    const result = spawnSync(join(box.home, 'tracker.ts'), ['ticket-prefix'], { env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test('capture roots accept a nested lane wildcard and skip absent roots', () => {
  const dir = scratch('cleared-captures-');
  const lane = join(dir, 'lanes', 'dev-1', '.local', 'captures');
  execFileSync('mkdir', ['-p', lane]);
  const file = join(lane, 'screen.png');
  writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(checkedImage(file, `${join(dir, 'missing')}, ${join(dir, 'lanes', '*', '.local', 'captures')}`).mime, 'image/png');
  assert.throws(() => checkedImage(file, join(dir, 'lanes', 'other', '.local', 'captures')), /outside/);
});

test('GitHub status labels preserve the actor from the issue timeline', () => {
  const issue = { number: 12, title: 'Test ticket', body: 'Body', labels: [{ name: 'status:Todo' }],
    html_url: 'https://example.test/issues/12', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const timeline: unknown[] = [];
  let identity = 'app';
  const api = (path: string, method?: string, body?: unknown) => {
    if (path === '/installation/repositories') { if (identity === 'app') return { repositories: [] }; throw new Error('not an installation'); }
    if (path === '/user') return { login: 'alice' };
    if (path.endsWith('/issues/12/timeline?per_page=100')) return timeline;
    if (path.endsWith('/issues/12/labels') && method === 'POST') {
      issue.labels.push(...(body as LabelsInput).labels.map((name) => ({ name })));
      timeline.push({ event: 'labeled', label: { name: (body as LabelsInput).labels[0] },
        actor: { login: identity === 'app' ? 'cleared[bot]' : 'alice', type: identity === 'app' ? 'Bot' : 'User' },
        created_at: new Date().toISOString() });
      return issue;
    }
    if (path.includes('/issues/12/labels/') && method === 'DELETE') {
      issue.labels = issue.labels.filter((label) => label.name !== decodeURIComponent(path.split('/').at(-1)!));
      return {};
    }
    if (path.endsWith('/issues/12')) return issue;
    throw new Error(`Unexpected request: ${path}`);
  };
  const conf = { sections: { tracker: { repository: 'example/project', review_state: 'Review', go_state: 'Approved', owner_id: 'alice', app_login: 'cleared[bot]' } } };
  const tracker = new GithubTracker({ conf, api });
  assert.throws(() => tracker.moveTicket('GH-12', 'Approved'), /Only the configured human/);
  tracker.moveTicket('GH-12', 'Review');
  assert.deepEqual(tracker.history('GH-12').at(-1)!.by, { kind: 'agents', id: 'cleared[bot]' });
  identity = 'human';
  tracker.moveTicket('GH-12', 'Approved');
  assert.deepEqual(tracker.history('GH-12').at(-1)!.by, { kind: 'human', id: 'alice' });
});

test('a failed GitHub status change restores its old label without replacing unrelated labels', () => {
  const issue = { number: 5, title: 'Ticket', body: '', labels: [{ name: 'status:Todo' }, { name: 'priority:high' }],
    html_url: 'https://example.test/issues/5', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  let failNextAdd = true;
  const api = (path: string, method?: string, body?: unknown) => {
    if (path === '/installation/repositories') return { repositories: [] };
    if (path.endsWith('/issues/5') && method === 'GET') return issue;
    if (path.includes('/issues/5/labels/') && method === 'DELETE') {
      issue.labels = issue.labels.filter((label) => label.name !== decodeURIComponent(path.split('/').at(-1)!));
      return {};
    }
    if (path.endsWith('/issues/5/labels') && method === 'POST') {
      if (failNextAdd) { failNextAdd = false; throw new Error('GitHub rejected the status update'); }
      issue.labels.push(...(body as LabelsInput).labels.map((name) => ({ name })));
      return issue.labels;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const tracker = new GithubTracker({ conf: { sections: { tracker: {
    repository: 'example/project', owner_id: 'alice', app_login: 'cleared[bot]', review_state: 'Review' } } }, api });
  assert.throws(() => tracker.moveTicket('GH-5', 'Review'), /GitHub rejected/);
  assert.deepEqual(issue.labels.map((label) => label.name).sort(), ['priority:high', 'status:Todo']);
});

test('an unclassified GitHub issue does not stop other tickets from waking', () => {
  const issue = (number: number, labels: { name: string }[]) => ({ number, title: `Ticket ${number}`, body: '', labels,
    html_url: `https://example.test/issues/${number}`, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-10-12T00:00:00Z', user: { login: 'alice', type: 'User' } });
  const api = (path: string) => {
    if (path.includes('/issues?')) return [issue(1, []), issue(2, [{ name: 'status:Todo' }])];
    if (path.endsWith('/issues/2/comments?per_page=100')) return [];
    if (path.endsWith('/issues/1')) return issue(1, []);
    throw new Error(`Unexpected request: ${path}`);
  };
  const conf = { sections: { tracker: { repository: 'example/project', owner_id: 'alice', app_login: 'cleared[bot]' } } };
  const tracker = new GithubTracker({ conf, api });
  assert.deepEqual(tracker.listTickets({ status: 'Todo' }).map((ticket) => ticket.identifier), ['GH-2']);
  assert.deepEqual(tracker.changesSince('2026-10-01T00:00:00Z').events.map((ticket) => ticket.identifier), ['GH-2']);
  assert.throws(() => tracker.getTicket('GH-1'), /exactly one status label/);
});

test('an edited GitHub human comment cannot authorize a team choice', () => {
  const conf = { sections: { tracker: { repository: 'example/project', owner_id: 'alice', app_login: 'cleared[bot]' } } };
  const api = (path: string) => {
    if (path.endsWith('/issues/12/comments?per_page=100')) return [{ id: 1, body: 'Teams: both',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z', user: { login: 'alice', type: 'User' } }];
    throw new Error(`Unexpected request: ${path}`);
  };
  const comment = new GithubTracker({ conf, api }).comments('GH-12')[0]!;
  assert.equal(comment.byOwner, false);
  assert.equal(comment.by.kind, 'other');
});

test('a ticket classified after creation and its earlier comments reach the next wake', () => {
  const issue = { number: 30, title: 'Older ticket', body: 'Please implement it', labels: [{ name: 'status:Todo' }],
    html_url: 'https://example.test/issues/30', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-12T10:59:00Z', user: { login: 'alice', type: 'User' } };
  const api = (path: string) => {
    if (path.includes('/issues?')) return [issue];
    if (path.endsWith('/issues/30/comments?per_page=100')) return [{ id: 9, body: 'The acceptance criteria',
      created_at: '2026-10-01T00:01:00Z', updated_at: '2026-10-01T00:01:00Z',
      user: { login: 'alice', type: 'User' }, html_url: 'https://example.test/comment/9' }];
    throw new Error(`Unexpected request: ${path}`);
  };
  const tracker = new GithubTracker({ conf: { sections: { tracker: {
    repository: 'example/project', owner_id: 'alice', app_login: 'cleared[bot]' } } }, api });
  const found = tracker.changesSince('2026-10-12T10:50:00Z').events;
  const result = changes({ at: '2026-10-12T10:50:00Z', seen: [], pulls: {}, states: {} }, found, [],
    new Set(), '2026-10-12T11:00:00Z');
  assert.deepEqual(result.events.map((event) => event.kind), ['ticket_new', 'comment']);
});

test('GitHub bot comments use the configured agent identity with either login form', () => {
  const conf = { sections: { tracker: { repository: 'example/project', owner_id: 'alice', app_login: 'cleared' } } };
  const api = (path: string) => {
    if (path.endsWith('/issues/12/comments?per_page=100')) return [{ id: 1, body: 'Agent update',
      created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
      user: { login: 'cleared[bot]', type: 'Bot' } }];
    if (path === '/installation/repositories') return { repositories: [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const tracker = new GithubTracker({ conf, api });
  assert.deepEqual(tracker.comments('GH-12')[0]!.by, { kind: 'agents', id: 'cleared' });
});

test('GitHub App token is renewed when fewer than five minutes remain', () => {
  let clock = Date.parse('2026-10-12T12:00:00Z');
  let requested = 0;
  const tokens = new GithubAppTokens({}, { now: () => clock, mint: () => ({
    token: `installation-${++requested}`, expiresAt: new Date(clock + 60 * 60_000).toISOString() }) });
  assert.equal(tokens.get(), 'installation-1');
  clock += 54 * 60_000;
  assert.equal(tokens.get(), 'installation-1');
  clock += 2 * 60_000;
  assert.equal(tokens.get(), 'installation-2');
  assert.equal(requested, 2);
  tokens.current!.expiresAt = new Date(clock - 1000).toISOString();
  assert.equal(tokens.get(), 'installation-3', 'an expired token is never sent to GitHub');
});

test('GitHub tracker does not reuse a static ambient installation token', () => {
  const tracker = new GithubTracker({ conf: { sections: { tracker: {
    repository: 'example/project', owner_id: 'alice', app_login: 'cleared[bot]' } } } });
  assert.throws(() => tracker.whoAmI(), /app_id and installation_id/);
});

test('GitHub App installation request signs a short-lived JWT and rejects an expired response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-github-app-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = join(dir, 'app.pem');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const clock = Date.parse('2026-10-12T12:00:00Z');
  const settings = { app_id: '123', installation_id: '456', app_private_key_file: key };
  try {
    const request = (endpoint: string, jwt: string) => {
      assert.equal(endpoint, 'https://api.github.com/app/installations/456/access_tokens');
      const [header, payload, signature] = jwt.split('.');
      assert.equal(JSON.parse(Buffer.from(header!, 'base64url') as unknown as string).alg, 'RS256');
      assert.equal(JSON.parse(Buffer.from(payload!, 'base64url') as unknown as string).iss, '123');
      assert.equal(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, 'base64url')), true);
      return { token: 'fresh', expires_at: new Date(clock + 60 * 60_000).toISOString() };
    };
    assert.equal(mintInstallationToken(settings, { now: () => clock, request }).token, 'fresh');
    assert.throws(() => mintInstallationToken(settings, { now: () => clock,
      request: () => ({ token: 'expired', expires_at: new Date(clock - 1000).toISOString() }) }), /nearly expired/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub Project v2 uses the configured single-select status and event actor', () => {
  let status = 'Todo';
  let identity = 'app';
  const events: unknown[] = [];
  const issue = { number: 12, title: 'Test', body: '', labels: [], html_url: 'https://example.test/12',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const api = (path: string, method?: string, input?: unknown) => {
    if (path === '/installation/repositories') { if (identity === 'app') return { repositories: [] }; throw new Error('not app'); }
    if (path === '/user') return { login: 'alice' };
    if (path.includes('/issues?state=all&since=')) return [];
    if (path.endsWith('/issues?state=all&per_page=100')) return [issue];
    if (path.endsWith('/issues/12/comments?per_page=100')) return [];
    if (path.endsWith('/issues/12')) return issue;
    if (path !== 'graphql') throw new Error(`Unexpected request: ${path}`);
    const q = (input as GraphqlInput).query;
    if (q.includes('items(first:100')) return { data: { node: { items: { nodes: [{ updatedAt: new Date().toISOString(),
      content: { number: 12, repository: { nameWithOwner: 'example/project' } }, fieldValueByName: { name: status } }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } };
    if (q.includes('projectItems(')) return { data: { repository: { issue: { projectItems: { nodes: [
      { id: 'item1', project: { id: 'project1' }, fieldValueByName: { name: status } },
    ] } } } } };
    if (q.includes('field(name:')) return { data: { node: { field: { id: 'field1', options: [
      { id: 'o1', name: 'Todo' }, { id: 'o2', name: 'Review' }, { id: 'o3', name: 'Approved' },
    ] } } } };
    if (q.includes('updateProjectV2ItemFieldValue')) {
      status = (input as GraphqlInput).variables.option === 'o2' ? 'Review' : 'Approved';
      events.push({ status, createdAt: new Date().toISOString(), actor: { login: identity === 'app' ? 'cleared' : 'alice',
        __typename: identity === 'app' ? 'Bot' : 'User' },
        project: { id: 'project1' }, wasAutomated: false });
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item1' } } } };
    }
    if (q.includes('timelineItems(')) return { data: { repository: { issue: { timelineItems: { nodes: events } } } } };
    throw new Error(`Unexpected query: ${q}`);
  };
  const conf = { sections: { tracker: { repository: 'example/project', project_v2_id: 'project1', review_state: 'Review',
    go_state: 'Approved', owner_id: 'alice', app_login: 'cleared[bot]' } } };
  const tracker = new GithubTracker({ conf, api });
  assert.throws(() => tracker.moveTicket('GH-12', 'Approved'), /Only the configured human/);
  tracker.moveTicket('GH-12', 'Review');
  assert.equal(tracker.getTicket('GH-12')!.status, 'Review');
  identity = 'human';
  tracker.moveTicket('GH-12', 'Approved');
  assert.equal(tracker.history('GH-12').at(-1)!.by.kind, 'human');
  assert.equal(tracker.listTickets({ status: 'Approved' })[0]!.identifier, 'GH-12');
  const changed = tracker.changesSince('2026-10-01T00:00:00Z');
  assert.equal(changed.events[0]!.status, 'Approved');
  assert.ok(Date.parse(changed.events[0]!.updatedAt) > Date.parse('2026-10-01T00:00:00Z'),
    'a field-only move must be visible to the next wake');
});

test('a GitHub capture passes OCR and the text guard before any image bytes reach the API', () => {
  const dir = scratch('cleared-capture-');
  const file = join(dir, 'capture.png');
  writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const bin = scratch('cleared-ocr-bin-');
  writeFileSync(join(bin, 'tesseract'), `#!${process.execPath}\nprocess.stdout.write(process.env.FAKE_OCR_TEXT ?? '');\n`, { mode: 0o755 });
  const old = { PATH: process.env.PATH, ORCH_REPO: process.env.ORCH_REPO,
    ORCH_GUARD_REF: process.env.ORCH_GUARD_REF, FAKE_OCR_TEXT: process.env.FAKE_OCR_TEXT };
  process.env.PATH = `${bin}:${old.PATH}`;
  process.env.ORCH_REPO = fixtureProject();
  process.env.ORCH_GUARD_REF = 'HEAD';
  const calls: [string, string | undefined, unknown][] = [];
  const api = (path: string, method?: string, body?: unknown) => {
    calls.push([path, method, body]);
    if (path === '/installation/repositories') return { repositories: [] };
    if (path.endsWith('/git/ref/heads/cleared-captures')) return { object: { sha: 'base' } };
    if (path.endsWith('/git/commits/base')) return { tree: { sha: 'tree' } };
    if (path.endsWith('/git/blobs')) return { sha: 'blob' };
    if (path.endsWith('/git/trees')) return { sha: 'tree2' };
    if (path.endsWith('/git/commits')) return { sha: 'next' };
    if (path.endsWith('/git/refs/heads/cleared-captures')) return {};
    throw new Error(`Unexpected request: ${path}`);
  };
  const tracker = new GithubTracker({ conf: { sections: { tracker: { repository: 'example/project',
    capture_roots: dir, owner_id: 'alice', app_login: 'cleared[bot]' } } }, api });
  try {
    process.env.FAKE_OCR_TEXT = 'Demo screenshot';
    assert.match(tracker.upload(file), /\/raw\/next\/captures\//);
    assert.ok(calls.some(([path]) => path.endsWith('/git/blobs')));
    calls.length = 0;
    process.env.FAKE_OCR_TEXT = `sk-proj-${'A'.repeat(24)}`;
    assert.throws(() => tracker.upload(file));
    assert.equal(calls.some(([path]) => path.endsWith('/git/blobs')), false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('local ticket moves through request, verified approval, guarded merge, and done', () => {
  const pull = reviewedPull(['server/core.mjs'], { ticket: 'LOCAL-1' });
  const { box } = pull;
  copyFileSync(join(ORCH_HOME, 'tracker.ts'), join(box.home, 'tracker.ts'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = join(box.home, 'human.key');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const settings = { todo_state: 'Todo', validate_state: 'À valider', go_state: 'Go MEP',
    done_state: 'Done', progress_state: 'In Progress', review_state: 'In Review', owner_id: 'alice',
    agents_uid: String(process.getuid!()), human_private_key: key,
    human_public_key: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64') };
  const confPath = join(box.home, 'agents.conf');
  const lines = Object.entries(settings).map(([name, value]) => `${name} = ${value}`).join('\n');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('adapter = local', `adapter = local\n${lines}`));
  const db = openLedger(join(box.state, 'ledger.db'));
  const conf = { sections: { tracker: settings } };
  const approvalDir = join(box.state, 'validations');
  const agents = new LocalTracker({ conf, db, actor: { kind: 'agents', id: 'cleared' }, approvalDir });
  const human = new LocalTracker({ conf, db, actor: { kind: 'human', id: 'alice' }, approvalDir });
  try {
    assert.equal(human.createTicket({ title: 'Test ticket', body: 'Body' })!.identifier, 'LOCAL-1');
    assert.ok(agents.getTicket('LOCAL-1'));
    human.moveTicket('LOCAL-1', 'Go MEP');
    const earlier = db.prepare('SELECT status, actor_kind, actor_id, at, proof FROM tracker_history ORDER BY id DESC LIMIT 1').get() as { status: string; actor_kind: string; actor_id: string; at: string; proof: string | null };
    const asked = pull.ask();
    assert.equal(asked.status, 0, asked.stderr);
    assert.equal(agents.getTicket('LOCAL-1')!.status, 'À valider');
    assert.equal(pull.merge(['-', '--dry-run'], {}, 'Announcement.').status, 6);
    assert.throws(() => agents.moveTicket('LOCAL-1', 'Go MEP'), /Only the configured human/);
    db.prepare('UPDATE tracker_tickets SET status = ? WHERE id = 1').run('Go MEP');
    db.prepare('INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at, proof) VALUES (1, ?, ?, ?, ?, ?)')
      .run(earlier.status, earlier.actor_kind, earlier.actor_id, earlier.at, earlier.proof);
    assert.equal(pull.merge(['-'], {}, 'Announcement.').status, 6, 'an old signed move is not approval of the later request');
    assert.equal(agents.getTicket('LOCAL-1')!.status, 'À valider');
    db.prepare('UPDATE tracker_tickets SET status = ? WHERE id = 1').run('Go MEP');
    db.prepare('INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at) VALUES (1, ?, ?, ?, ?)')
      .run('Go MEP', 'agents', 'cleared', new Date().toISOString());
    assert.equal(pull.merge(['-'], {}, 'Announcement.').status, 6, 'an agent status change is not a human approval');
    assert.equal(agents.getTicket('LOCAL-1')!.status, 'À valider');
    human.moveTicket('LOCAL-1', 'Go MEP');
    const validationFile = join(approvalDir, 'LOCAL-1.json');
    const authenticRequest = readFile(validationFile, 'utf8');
    const forgedRequest = JSON.parse(authenticRequest);
    forgedRequest.at = '2020-01-01T00:00:00Z';
    forgedRequest.pulls[0].head = 'f'.repeat(40);
    writeFileSync(validationFile, JSON.stringify(forgedRequest));
    assert.equal(pull.merge(['-', '--dry-run'], {}, 'Announcement.').status, 6,
      'altering the request timestamp and presented head cannot reuse a human signature');
    writeFileSync(validationFile, authenticRequest);
    const approved = pull.merge(['-', '--dry-run'], {}, 'Announcement.');
    assert.equal(approved.status, 0, approved.stderr);
    const shipped = pull.merge(['-'], {}, 'Announcement.');
    assert.equal(shipped.status, 0, shipped.stderr);
    assert.equal(agents.getTicket('LOCAL-1')!.status, 'Done');
  } finally { db.close(); }
});

test('GitHub Issues ticket moves through request, actor checks, guarded merge, and done', () => {
  const pull = reviewedPull(['server/core.mjs'], { ticket: 'GH-12' });
  const { box } = pull;
  copyFileSync(join(ORCH_HOME, 'tracker.ts'), join(box.home, 'tracker.ts'));
  const appKey = join(box.home, 'github-app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(appKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(box.home, 'bin', 'curl'), `#!${process.execPath}
try { process.getBuiltinModule('node:fs').readFileSync(0); } catch { /* no input */ }
process.stdout.write('{"token":' + '"fake-installation-token","expires_at":"' + new Date(Date.now() + 3_600_000).toISOString().replace(/\\.\\d{3}Z$/, 'Z') + '"}\\n');
`, { mode: 0o755 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFile(confPath, 'utf8').replace('adapter = local',
    `adapter = github\nrepository = example/project\nowner_id = alice\napp_login = cleared[bot]\napp_id = 123\ninstallation_id = 456\napp_private_key_file = ${appKey}`));
  box.env.GH_TOKEN = 'stale-token';
  const stateFile = join(box.home, 'fake-issue.json');
  const state = { issue: { number: 12, title: 'Test ticket', body: 'Body', node_id: 'node12',
    labels: [{ name: 'status:Todo' }], html_url: 'https://example.test/issues/12',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    timeline: [{ event: 'labeled', label: { name: 'status:Todo' }, actor: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z' }], comments: [] };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();
  const original = join(box.home, 'bin', 'gh-original');
  renameSync(join(box.home, 'bin', 'gh'), original);
  const fake = join(box.home, 'fake-api.mjs');
  writeFileSync(fake, `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const path = args.find((part) => part.startsWith('/'));
const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : null;
const state = JSON.parse(readFileSync(file, 'utf8'));
let result;
if (path === '/installation/repositories') result = {repositories: []};
else if (path.endsWith('/issues/12') && method === 'GET') result = state.issue;
else if (path.endsWith('/issues/12/timeline?per_page=100')) result = state.timeline;
else if (path.endsWith('/issues/12/comments?per_page=100')) result = state.comments;
else if (path.endsWith('/issues/12/comments') && method === 'POST') {
  result = {id: state.comments.length + 1, body: input.body, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), html_url: 'https://example.test/comment', user: {login: 'cleared[bot]', type: 'Bot'}};
  state.comments.push(result);
} else if (path.endsWith('/issues/12/labels') && method === 'POST') {
  state.issue.labels.push(...input.labels.map((name) => ({name})));
  state.timeline.push({event: 'labeled', label: {name: input.labels[0]}, actor: {login: 'cleared[bot]', type: 'Bot'}, created_at: new Date().toISOString()});
  result = state.issue.labels;
} else if (path.includes('/issues/12/labels/') && method === 'DELETE') {
  state.issue.labels = state.issue.labels.filter((label) => label.name !== decodeURIComponent(path.split('/').at(-1)));
  result = {};
} else process.exit(91);
writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify(result));
`);
  writeFileSync(join(box.home, 'bin', 'gh'), `#!${process.execPath}
const { spawnSync } = process.getBuiltinModule('node:child_process');
const args = process.argv.slice(2);
const line = ' ' + args.join(' ') + ' ';
if (args[0] === 'api' && (line.includes('/repos/example/project/issues/12') || line.includes('/installation/repositories'))) {
  if (process.env.GH_TOKEN !== 'fake-installation-token') process.exitCode = 97;
  else process.exitCode = spawnSync('node', [${JSON.stringify(fake)}, ...args.slice(1)], { stdio: 'inherit' }).status ?? 1;
} else process.exitCode = spawnSync(${JSON.stringify(original)}, args, { stdio: 'inherit' }).status ?? 1;
`, { mode: 0o755 });
  const externalMove = (who: string, at: string) => {
    const data = JSON.parse(readFile(stateFile, 'utf8'));
    data.issue.labels = [{ name: 'status:Go MEP' }];
    data.timeline.push({ event: 'labeled', label: { name: 'status:Go MEP' },
      actor: { login: who, type: who === 'alice' ? 'User' : 'Bot' }, created_at: at });
    writeFileSync(stateFile, JSON.stringify(data));
  };
  const asked = pull.ask();
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).issue.labels[0].name, 'status:À valider');
  externalMove('cleared[bot]', new Date().toISOString());
  assert.equal(pull.merge(['-'], {}, 'Announcement.').status, 6, 'the app cannot approve its own work');
  const requested = JSON.parse(readFile(join(box.state, 'validations', 'GH-12.json'), 'utf8')).at;
  externalMove('alice', new Date(Date.parse(requested) - 60_000).toISOString());
  assert.equal(pull.merge(['-'], {}, 'Announcement.').status, 6, 'an older human move cannot approve the request');
  externalMove('alice', new Date(Date.parse(requested) + 60_000).toISOString());
  const approved = pull.merge(['-', '--dry-run'], {}, 'Announcement.');
  assert.equal(approved.status, 0, approved.stderr);
  const shipped = pull.merge(['-'], {}, 'Announcement.');
  assert.equal(shipped.status, 0, shipped.stderr);
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).issue.labels[0].name, 'status:Done');
});

test('Linear ticket moves through request, actor checks, guarded merge, and done', () => {
  const pull = reviewedPull(['server/core.mjs']);
  const { box } = pull;
  copyFileSync(join(ORCH_HOME, 'tracker.ts'), join(box.home, 'tracker.ts'));
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFile(confPath, 'utf8').replace('adapter = local', 'adapter = linear\nowner_id = alice'));
  const stateFile = join(box.home, 'fake-linear.json');
  const state = { status: 'Todo', history: [], comments: [] };
  writeFileSync(stateFile, JSON.stringify(state));
  const fake = join(box.home, 'fake-curl.mjs');
  writeFileSync(fake, `import { readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(stateFile)};
const input = readFileSync(0, 'utf8');
if (input.startsWith('grant_type=')) { console.log(JSON.stringify({access_token: 'token'})); process.exit(0); }
const {query, variables} = JSON.parse(input);
const state = JSON.parse(readFileSync(file, 'utf8'));
let data;
if (query.includes('commentCreate')) {
  const comment = {id: 'c' + (state.comments.length + 1), url: 'https://example.test/comment',
    createdAt: new Date().toISOString(), editedAt: null, body: variables.input.body,
    user: {id: 'agent', app: true}, botActor: null, externalUser: null};
  state.comments.push(comment);
  data = {commentCreate: {success: true, comment}};
} else if (query.includes('issueUpdate')) {
  state.status = variables.input.stateId.slice(7);
  state.history.push({createdAt: new Date().toISOString(), actorId: 'agent', actor: {id: 'agent', app: true},
    botActor: null, fromState: null, toState: {name: state.status}});
  data = {issueUpdate: {success: true}};
} else if (query.includes('history(')) {
  data = {viewer: {id: 'agent'}, issue: {state: {name: state.status}, createdAt: '2026-01-01T00:00:00Z',
    creator: {id: 'alice', app: false}, history: {nodes: state.history}}};
} else if (query.includes('comments(')) {
  data = {viewer: {id: 'agent'}, issue: {comments: {nodes: state.comments}}};
} else if (query.includes('teams(filter:')) {
  data = {issue: {id: 'issue1'}, teams: {nodes: [{states: {nodes: ['Todo', 'À valider', 'Go MEP', 'Done', 'In Progress', 'In Review'].map((name) => ({id: 'status-' + name, name}))}}]}};
} else if (query.includes('issue(id:')) {
  data = {issue: {id: 'issue1', identifier: 'X-5', title: 'Test ticket', url: 'https://example.test/X-5',
    description: 'Body', createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date().toISOString(),
    state: {name: state.status}, project: {name: 'Example'}, labels: {nodes: []}}};
} else throw new Error('Unexpected query: ' + query);
writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify({data}));
`);
  writeFileSync(join(box.home, 'bin', 'curl'), `#!${process.execPath}
const { spawnSync } = process.getBuiltinModule('node:child_process');
process.exitCode = spawnSync('node', [${JSON.stringify(fake)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1;
`, { mode: 0o755 });
  const env = { LINEAR_APP_CLIENT_ID: 'app', LINEAR_APP_CLIENT_SECRET: 'secret' };
  const asked = pull.ask('Please approve this version.', env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).status, 'À valider');
  const requested = JSON.parse(readFile(join(box.state, 'validations', 'X-5.json'), 'utf8')).at;
  const externalMove = (who: string, at: string) => {
    const next = JSON.parse(readFile(stateFile, 'utf8'));
    next.status = 'Go MEP';
    next.history.push({ createdAt: at, actorId: who, actor: { id: who, app: who === 'agent' },
      botActor: null, fromState: null, toState: { name: 'Go MEP' } });
    writeFileSync(stateFile, JSON.stringify(next));
  };
  externalMove('alice', new Date(Date.parse(requested) - 60_000).toISOString());
  assert.equal(pull.merge(['-'], env, 'Announcement.').status, 6, 'an older human move is not approval');
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).status, 'À valider');
  externalMove('agent', new Date().toISOString());
  assert.equal(pull.merge(['-'], env, 'Announcement.').status, 6, 'an app move is not approval');
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).status, 'À valider');
  externalMove('alice', new Date(Date.parse(requested) + 60_000).toISOString());
  const approved = pull.merge(['-', '--dry-run'], env, 'Announcement.');
  assert.equal(approved.status, 0, approved.stderr);
  const shipped = pull.merge(['-'], env, 'Announcement.');
  assert.equal(shipped.status, 0, shipped.stderr);
  assert.equal(JSON.parse(readFile(stateFile, 'utf8')).status, 'Done');
});

test('GitHub private captures use the installation token and repository contents API', () => {
  const dir = scratch('cleared-capture-api-');
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const marker = join(dir, 'request');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$GH_TOKEN" "$*" > '${marker}'\nprintf '\\211PNG\\r\\n\\032\\n'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const tracker = new GithubTracker({ conf: { sections: { tracker: {
      repository: 'owner/repo', owner_id: 'person', app_login: 'bot',
    } } }, tokens: { get: () => 'installation-token' } });
    const bytes = tracker.downloadCapture('https://github.com/owner/repo/raw/' + 'a'.repeat(40) + '/captures/a.png');
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    const request = readFileSync(marker, 'utf8');
    assert.match(request, /^installation-token\n/);
    assert.match(request, /api \/repos\/owner\/repo\/contents\/captures\/a\.png\?ref=/);
    assert.throws(() => tracker.downloadCapture('https://github.com/other/repo/raw/' + 'a'.repeat(40) + '/captures/a.png'), /configured repository/);
  } finally { process.env.PATH = oldPath; }
});

test('[Linear adapter] private capture download uses the tracker authorization header', () => {
  const box = sandbox();
  const marker = join(box.home, 'capture-header');
  writeFileSync(join(box.home, 'bin', 'curl'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const args = process.argv.slice(2);
args.forEach((arg, i) => {
  if (args[i - 1] !== '-H') return;
  const file = arg.replace(/^@/, '');
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  try { fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync(file)); } catch (error) { process.stderr.write('cat: ' + file + ': ' + (error.code === 'ENOENT' ? 'No such file or directory' : error.message) + '\\n'); }
});
process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
`, { mode: 0o755 });
  const run = (url: string) => spawnSync(join(box.home, 'lib', 'tracker', 'adapters', 'linear.ts'), ['download-capture', url],
    { env: { ...box.env, LINEAR_API_KEY: 'test-key' } });
  const ok = run('https://uploads.linear.app/workspace/asset');
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.deepEqual(ok.stdout.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(readFileSync(marker, 'utf8'), 'Authorization: test-key');
  assert.notEqual(run('https://uploads.linear.app.evil.test/asset').status, 0);
});
