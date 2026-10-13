// What the app writes to the three trackers, and as whom. Each gesture runs through the real
// writer process (app/human-write.mjs) against the real local tracker, or against a fake
// GitHub or Linear server: the author the tracker records must be the human.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCH_HOME, parseConf } from '../lib/conf.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { LocalTracker } from '../lib/tracker/adapters/local.mjs';
import { privateDir, privateFile, readCredentials } from '../app/lib/credentials.mjs';
import { perform, targetStates } from '../app/lib/human-tracker.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const HEAD = 'a'.repeat(40);
const VERSIONS = [{ pr: 7, head: HEAD }];
const HUMAN_GH = 'ghp_humanhumanhumanhuman1234';
const AGENT_GH = 'ghs_agentsagentsagentsagent99';
const HUMAN_LIN = 'lin_oauth_humanhumanhuman1234';
const APP_LIN = 'lin_oauth_agentsagentsagents99';

function box(adapter, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'cleared-writer-')); dirs.push(root);
  const repo = join(root, 'repo'), state = join(root, 'state'), creds = join(root, 'creds');
  for (const d of [repo, state, creds, join(state, 'validations')]) mkdirSync(d, { recursive: true });
  for (const d of [state, creds]) chmodSync(d, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(creds, 'human-signing.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicB64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
  const ticket = { local: 'LOCAL-1', github: 'GH-12', linear: 'ENG-12' }[adapter];
  const conf = `[tracker]\nadapter = ${adapter}\nowner_id = ${adapter === 'linear' ? 'lin-human' : 'alice'}\nvalidate_state = Needs Approval\ngo_state = Ready to Ship\ndone_state = Done\nprogress_state = In Progress\nreview_state = In Review\ntodo_state = Todo\n`
    + `team = ENG\nrepository = o/r\napp_login = cleared[bot]\nagents_uid = 99999\nhuman_public_key = ${publicB64}\n[app]\nhuman_credentials_dir = ${creds}\n${extra}`;
  const confPath = join(root, 'agents.conf'); writeFileSync(confPath, conf);
  const env = { PATH: process.env.PATH, HOME: root, ORCH_CONF: confPath, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db'), XDG_CONFIG_HOME: join(root, 'cfg') };
  const approvalRecord = (head = HEAD) => writeFileSync(join(state, 'validations', `${ticket}.json`), JSON.stringify({ ticket, at: '2026-10-13T09:00:00.000Z', pulls: [{ pr: 7, head }] }));
  const credentials = (value) => writeFileSync(join(creds, 'credentials.json'), JSON.stringify(value), { mode: 0o600 });
  const write = (request, over = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ORCH_HOME, 'app/human-write.mjs')], { env: { ...env, ...over }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1))));
    child.stdin.end(JSON.stringify(request));
  });
  return { root, repo, state, creds, env, ticket, conf: parseConf(conf), approvalRecord, credentials, write, confPath, publicB64 };
}

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });
const body = (request) => new Promise((resolve) => { let d = ''; request.on('data', (c) => { d += c; }); request.on('end', () => resolve(d)); });
const bearer = (request) => /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];

// ---- GitHub ---------------------------------------------------------------------
async function fakeGithub(t) {
  const state = { labels: ['status:Needs Approval'], timeline: [], comments: [], tokens: new Set() };
  const who = (token) => (token === HUMAN_GH ? { login: 'alice', type: 'User' } : { login: 'cleared[bot]', type: 'Bot' });
  const server = await listen(async (request, response) => {
    const token = bearer(request); state.tokens.add(token);
    const url = new URL(request.url, 'http://x');
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (!token) return reply(401, {});
    const label = /^\/repos\/o\/r\/issues\/12\/labels\/(.+)$/.exec(url.pathname);
    if (url.pathname === '/installation/repositories') return token === AGENT_GH ? reply(200, { repositories: [] }) : reply(403, {});
    if (url.pathname === '/user') return token === HUMAN_GH ? reply(200, who(token)) : reply(403, {});
    if (url.pathname === '/repos/o/r/issues/12' && request.method === 'GET') return reply(200, { number: 12, title: 'Ticket', body: '', labels: state.labels.map((name) => ({ name })), html_url: 'https://github.example/o/r/issues/12', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' });
    if (label && request.method === 'DELETE') { state.labels = state.labels.filter((l) => l !== decodeURIComponent(label[1])); return reply(200, []); }
    if (url.pathname === '/repos/o/r/issues/12/labels' && request.method === 'POST') {
      for (const name of JSON.parse(await body(request)).labels) { state.labels.push(name); state.timeline.push({ event: 'labeled', label: { name }, actor: who(token), created_at: new Date().toISOString() }); }
      return reply(200, []);
    }
    if (url.pathname === '/repos/o/r/issues/12/timeline') return reply(200, url.searchParams.get('page') === '1' ? state.timeline : []);
    if (url.pathname === '/repos/o/r/issues/12/comments' && request.method === 'POST') { state.comments.push({ body: JSON.parse(await body(request)).body, by: who(token).login }); return reply(201, {}); }
    return reply(404, { message: url.pathname });
  });
  t.after(() => server.close());
  return { state, env: { CLEARED_APP_GITHUB_API: `http://127.0.0.1:${server.address().port}` } };
}

// ---- Linear ---------------------------------------------------------------------
async function fakeLinear(t) {
  const state = { state: 'Needs Approval', history: [], comments: [], tokens: new Set() };
  const viewer = (token) => (token === HUMAN_LIN ? { id: 'lin-human', app: false } : { id: 'lin-app', app: true });
  const server = await listen(async (request, response) => {
    const token = bearer(request); state.tokens.add(token);
    const { query, variables } = JSON.parse(await body(request));
    const reply = (data) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    if (!token) return response.writeHead(401).end('{}');
    if (query.includes('history(first')) return reply({ viewer: viewer(token), issue: { history: { nodes: state.history } } });
    if (query.includes('teams(filter')) return reply({ issue: { id: 'iid' }, teams: { nodes: [{ states: { nodes: ['Ready to Ship', 'In Progress', 'Needs Approval'].map((name) => ({ id: `id-${name}`, name })) } }] } });
    if (query.includes('viewer { id app }')) return reply({ viewer: viewer(token) });
    if (query.includes('state { name }')) return reply({ issue: { state: { name: state.state } } });
    if (query.includes('issueUpdate')) {
      const name = variables.input.stateId.replace(/^id-/, '');
      state.state = name; state.history.push({ createdAt: new Date().toISOString(), actorId: viewer(token).id, actor: { id: viewer(token).id, app: viewer(token).app }, botActor: null, toState: { name } });
      return reply({ issueUpdate: { success: true } });
    }
    if (query.includes('commentCreate')) { state.comments.push({ body: variables.input.body, by: viewer(token).id }); return reply({ commentCreate: { success: true } }); }
    return reply({ issue: { id: 'iid' } });
  });
  t.after(() => server.close());
  return { state, env: { CLEARED_APP_LINEAR_API: `http://127.0.0.1:${server.address().port}/graphql` } };
}

test('local tracker: the three gestures are written, signed as the human, and the tracker reads them as his', async () => {
  const b = box('local');
  b.credentials({});
  const agents = new LocalTracker({ conf: b.conf, db: openLedger(b.env.ORCH_LEDGER), actor: { kind: 'agents', id: 'cleared' } });
  try {
    const made = agents.createTicket({ title: 'A change', body: 'x', labels: [] });
    agents.moveTicket(made.identifier, 'Needs Approval');
    b.approvalRecord();
    // An answer: a comment, by the human.
    const answered = await b.write({ op: 'answer', ticket: b.ticket, text: 'Yes, take the charges out first' });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    const comment = agents.comments(b.ticket)[0];
    assert.equal(comment.body, 'Yes, take the charges out first');
    assert.deepEqual(comment.by, { kind: 'human', id: 'alice' }); assert.equal(comment.byOwner, true);
    // A stale version is refused; nothing moves.
    const stale = await b.write({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'b'.repeat(40) }] });
    assert.equal(stale.ok, false); assert.equal(stale.code, 'version');
    assert.equal(agents.getTicket(b.ticket).status, 'Needs Approval');
    // The agreement, for the version on record: the move is the human's, proven by his key.
    const approved = await b.write({ op: 'approve', ticket: b.ticket, versions: VERSIONS });
    assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
    const last = agents.history(b.ticket).at(-1);
    assert.equal(last.status, 'Ready to Ship'); assert.deepEqual(last.by, { kind: 'human', id: 'alice' });
    assert.ok(last.approvalContext, 'the agreement is tied to the request that was on record');
    // Send back: the word, then the move.
    agents.moveTicket(b.ticket, 'Needs Approval'); b.approvalRecord();
    const back = await b.write({ op: 'sendback', ticket: b.ticket, text: 'Round the figure to the cent.' });
    assert.equal(back.ok, true, JSON.stringify(back)); assert.equal(back.verified, true);
    assert.equal(agents.getTicket(b.ticket).status, 'In Progress');
    assert.equal(agents.comments(b.ticket)[0].body, 'Round the figure to the cent.');
    assert.equal(agents.history(b.ticket).at(-1).by.kind, 'human');
    // Not waiting for him any more: refused.
    const late = await b.write({ op: 'approve', ticket: b.ticket, versions: VERSIONS });
    assert.equal(late.code, 'state');
  } finally { agents.close(); }
});

test('local tracker: a move written by anyone else than the human never reads as his agreement, whoever signs it', async () => {
  const b = box('local');
  const db = openLedger(b.env.ORCH_LEDGER);
  const agents = new LocalTracker({ conf: b.conf, db, actor: { kind: 'agents', id: 'cleared' } });
  try {
    const made = agents.createTicket({ title: 'A change', body: 'x', labels: [] });
    assert.throws(() => agents.moveTicket(made.identifier, 'Ready to Ship'), /Only the configured human/, 'an agent cannot write the status of agreement');
    const shared = new LocalTracker({ conf: b.conf, db, actor: { kind: 'shared', id: 'mallory' } });
    assert.throws(() => shared.moveTicket(made.identifier, 'Ready to Ship'), /Only the configured human/, 'nor an account that is not the owner');
    // A row written straight into the ledger, claiming to be the human with a signature of another key.
    const other = generateKeyPairSync('ed25519').privateKey;
    const forger = new LocalTracker({ conf: { ...b.conf, sections: { ...b.conf.sections, tracker: { ...b.conf.sections.tracker, human_private_key: join(b.creds, 'forged.key') } } }, db, actor: { kind: 'human', id: 'alice' } });
    writeFileSync(join(b.creds, 'forged.key'), other.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    forger.moveTicket(made.identifier, 'Ready to Ship');
    assert.equal(agents.history(made.identifier).at(-1).by.kind, 'other', 'the signature does not verify against the human\'s public key');
  } finally { agents.close(); }
});

test('GitHub: the three gestures are written with the human\'s own token, and the timeline shows the human', async (t) => {
  const fake = await fakeGithub(t);
  const b = box('github');
  b.credentials({ github_token: HUMAN_GH }); b.approvalRecord();
  const run = (request) => b.write(request, fake.env);
  assert.equal((await run({ op: 'answer', ticket: b.ticket, text: 'Yes' })).ok, true);
  assert.deepEqual(fake.state.comments, [{ body: 'Yes', by: 'alice' }]);
  const stale = await run({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'c'.repeat(40) }] });
  assert.equal(stale.code, 'version'); assert.deepEqual(fake.state.labels, ['status:Needs Approval']);
  const approved = await run({ op: 'approve', ticket: b.ticket, versions: VERSIONS });
  assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
  assert.deepEqual(fake.state.labels, ['status:Ready to Ship']);
  assert.equal(fake.state.timeline.at(-1).actor.login, 'alice');
  fake.state.labels = ['status:Needs Approval']; b.approvalRecord();
  const back = await run({ op: 'sendback', ticket: b.ticket, text: 'Round it.' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.deepEqual(fake.state.labels, ['status:In Progress']);
  assert.deepEqual(fake.state.comments.at(-1), { body: 'Round it.', by: 'alice' });
  assert.deepEqual([...fake.state.tokens], [HUMAN_GH], 'only the human\'s token was ever presented');
});

test('GitHub: the agents\' installation token is refused as an identity, and nothing is written', async (t) => {
  const fake = await fakeGithub(t);
  const b = box('github');
  b.credentials({ github_token: AGENT_GH }); b.approvalRecord();
  for (const request of [{ op: 'approve', ticket: b.ticket, versions: VERSIONS }, { op: 'sendback', ticket: b.ticket, text: 'x' }, { op: 'answer', ticket: b.ticket, text: 'x' }]) {
    const result = await b.write(request, fake.env);
    assert.equal(result.ok, false); assert.equal(result.code, 'identity');
  }
  assert.deepEqual(fake.state.comments, []); assert.deepEqual(fake.state.labels, ['status:Needs Approval']);
});

test('Linear: the three gestures are written with the human\'s own token, and the history shows the human', async (t) => {
  const fake = await fakeLinear(t);
  const b = box('linear');
  b.credentials({ linear_token: HUMAN_LIN }); b.approvalRecord();
  const run = (request) => b.write(request, fake.env);
  assert.equal((await run({ op: 'answer', ticket: b.ticket, text: 'No' })).ok, true);
  assert.deepEqual(fake.state.comments, [{ body: 'No', by: 'lin-human' }]);
  assert.equal((await run({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'd'.repeat(40) }] })).code, 'version');
  assert.equal(fake.state.state, 'Needs Approval');
  const approved = await run({ op: 'approve', ticket: b.ticket, versions: VERSIONS });
  assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
  assert.equal(fake.state.state, 'Ready to Ship'); assert.equal(fake.state.history.at(-1).actorId, 'lin-human');
  fake.state.state = 'Needs Approval'; b.approvalRecord();
  const back = await run({ op: 'sendback', ticket: b.ticket, text: 'Round it.' });
  assert.equal(back.ok, true, JSON.stringify(back)); assert.equal(fake.state.state, 'In Progress');
  assert.deepEqual([...fake.state.tokens], [HUMAN_LIN]);
});

test('Linear: the application of the agents is refused as an identity, and nothing is written', async (t) => {
  const fake = await fakeLinear(t);
  const b = box('linear');
  b.credentials({ linear_token: APP_LIN }); b.approvalRecord();
  for (const request of [{ op: 'approve', ticket: b.ticket, versions: VERSIONS }, { op: 'sendback', ticket: b.ticket, text: 'x' }, { op: 'answer', ticket: b.ticket, text: 'x' }]) {
    const result = await b.write(request, fake.env);
    assert.equal(result.ok, false); assert.equal(result.code, 'identity');
  }
  assert.deepEqual(fake.state.comments, []); assert.equal(fake.state.state, 'Needs Approval');
});

test('the writer cannot be pointed at another place by the project settings, and takes only plain https or this machine', async () => {
  const b = box('github', 'github_api_url = https://evil.example\nlinear_api_url = https://evil.example\n');
  b.credentials({ github_token: HUMAN_GH });
  // The settings keys are not read; the default address is api.github.com (unreachable here, so it fails, but never reaches evil.example).
  const result = await b.write({ op: 'answer', ticket: b.ticket, text: 'x' }, { CLEARED_APP_GITHUB_API: 'http://evil.example' });
  assert.equal(result.ok, false);
  assert.match(result.message, /must be https|curl|Command failed/);
});

test('the gesture text and the target statuses are checked: no empty text, and a sent-back ticket never lands in agreement or done', () => {
  const conf = parseConf('[tracker]\nadapter = local\nowner_id = alice\nvalidate_state = V\ngo_state = G\ndone_state = D\nprogress_state = P\n');
  assert.equal(targetStates(conf).back, 'P');
  assert.equal(targetStates(conf, { sent_back_state: 'R' }).back, 'R');
  for (const bad of ['G', 'D', 'V']) assert.throws(() => targetStates(conf, { sent_back_state: bad }), /must be a working status/);
});

test('human credentials: a private directory and files outside the project, owned by the app account, closed to every other account', () => {
  const b = box('github');
  b.credentials({ github_token: HUMAN_GH });
  assert.equal(readCredentials(b.creds, { project: b.repo, adapter: 'github' }).github_token, HUMAN_GH);
  // Readable by the group or by others: refused (this is what keeps the agents' account out).
  chmodSync(join(b.creds, 'credentials.json'), 0o640);
  assert.throws(() => readCredentials(b.creds, { project: b.repo, adapter: 'github' }), /private regular file/);
  chmodSync(join(b.creds, 'credentials.json'), 0o600);
  chmodSync(b.creds, 0o755);
  assert.throws(() => readCredentials(b.creds, { project: b.repo, adapter: 'github' }), /private directory/);
  chmodSync(b.creds, 0o700);
  // Inside the project (where the agents work), inside the Cleared checkout: refused.
  const inside = join(b.repo, 'secrets'); mkdirSync(inside, { mode: 0o700 });
  assert.throws(() => privateDir(inside, { project: b.repo }), /outside the project/);
  assert.throws(() => privateDir(join(ORCH_HOME, 'app'), {}), /private directory|outside/);
  // A link is not a file.
  symlinkSync(join(b.creds, 'credentials.json'), join(b.creds, 'link.json'));
  assert.throws(() => privateFile(join(b.creds, 'link.json')), /private regular file/);
  assert.throws(() => readCredentials(b.creds, { project: b.repo, adapter: 'linear' }), /no a Linear user token|Linear user token/);
  // The writer refuses to start from loose credentials: nothing is presented to any tracker.
  chmodSync(join(b.creds, 'credentials.json'), 0o644);
  const run = spawnSync(process.execPath, [join(ORCH_HOME, 'app/human-write.mjs')], { env: b.env, input: JSON.stringify({ op: 'answer', ticket: b.ticket, text: 'x' }), encoding: 'utf8' });
  assert.equal(JSON.parse(run.stdout).ok, false);
});

// A real second account: the agents' Unix account must not read the credentials, the passkeys or the access token.
// Needs a passwordless sudo to that account (CLEARED_TEST_AGENT_USER); serve/install.sh runs the same probes on the server.
const agentUser = process.env.CLEARED_TEST_AGENT_USER;
test('the agents\' account cannot read the human credentials, the passkeys or the access token', { skip: agentUser ? false : 'set CLEARED_TEST_AGENT_USER (a second account reachable with sudo -n) to run it' }, () => {
  const b = box('github');
  b.credentials({ github_token: HUMAN_GH });
  writeFileSync(join(b.creds, 'passkeys.json'), '[]', { mode: 0o600 });
  for (const path of [b.creds, join(b.creds, 'credentials.json'), join(b.creds, 'human-signing.key'), join(b.creds, 'passkeys.json'), process.env.CLEARED_TEST_APP_TOKEN].filter(Boolean)) {
    const probe = spawnSync('sudo', ['-n', '-u', agentUser, '--', 'test', '-r', path]);
    assert.notEqual(probe.status, 0, `${path} must not be readable by ${agentUser}`);
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser, '--', 'test', '-w', path]).status, 0, `${path} must not be writable by ${agentUser}`);
  }
});
