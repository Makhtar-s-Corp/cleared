// What the app writes to the trackers, and as whom. Each gesture runs through the real writer
// process (app/human-write.ts) against the real local tracker, or against a fake GitHub server:
// the author the tracker records must be the human.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ORCH_HOME, parseConf } from '../lib/conf.ts';
import { openLedger } from '../lib/ledger.ts';
import { LocalTracker } from '../lib/tracker/adapters/local.ts';
import { privateDir, privateFile, readCredentials } from '../app/lib/credentials.ts';
import { targetStates } from '../app/lib/human-tracker.ts';
import { bearer, body, box as scratchBox, HEAD, listen, VERSIONS } from './app-box.ts';

const HUMAN_GH = 'ghp_humanhumanhumanhuman1234';
const AGENT_GH = 'ghs_agentsagentsagentsagent99';
const TICKETS = { local: 'LOCAL-1', github: 'GH-12' };
const box = (adapter: keyof typeof TICKETS, extra = '') => scratchBox(adapter, { ticket: TICKETS[adapter], extra }) as ReturnType<typeof scratchBox> & { ticket: string };

// ---- GitHub ---------------------------------------------------------------------
// What the fake GitHub holds: the labels of issue 12, its timeline, the comments written, and every token presented.
type GithubState = {
  labels: string[];
  timeline: { event: string; label: { name: string }; actor: { login: string; type: string }; created_at: string }[];
  comments: { body: string; by: string }[];
  tokens: Set<string | undefined>;
};

async function fakeGithub(t: TestContext) {
  const state: GithubState = { labels: ['status:Needs Approval'], timeline: [], comments: [], tokens: new Set() };
  const who = (token: string | undefined) => (token === HUMAN_GH ? { login: 'alice', type: 'User' } : { login: 'cleared[bot]', type: 'Bot' });
  const server = await listen(async (request, response) => {
    const token = bearer(request); state.tokens.add(token);
    const url = new URL(request.url!, 'http://x');
    const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (!token) return reply(401, {});
    const label = /^\/repos\/o\/r\/issues\/12\/labels\/(.+)$/.exec(url.pathname);
    if (url.pathname === '/installation/repositories') return token === AGENT_GH ? reply(200, { repositories: [] }) : reply(403, {});
    if (url.pathname === '/user') return token === HUMAN_GH ? reply(200, who(token)) : reply(403, {});
    if (url.pathname === '/repos/o/r/issues/12' && request.method === 'GET') return reply(200, { number: 12, title: 'Ticket', body: '', labels: state.labels.map((name) => ({ name })), html_url: 'https://github.example/o/r/issues/12', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' });
    if (label && request.method === 'DELETE') { state.labels = state.labels.filter((l) => l !== decodeURIComponent(label[1]!)); return reply(200, []); }
    if (url.pathname === '/repos/o/r/issues/12/labels' && request.method === 'POST') {
      for (const name of JSON.parse(await body(request)).labels as string[]) { state.labels.push(name); state.timeline.push({ event: 'labeled', label: { name }, actor: who(token), created_at: new Date().toISOString() }); }
      return reply(200, []);
    }
    if (url.pathname === '/repos/o/r/issues/12/timeline') return reply(200, url.searchParams.get('page') === '1' ? state.timeline : []);
    if (url.pathname === '/repos/o/r/issues/12/comments' && request.method === 'POST') { state.comments.push({ body: JSON.parse(await body(request)).body, by: who(token).login }); return reply(201, {}); }
    return reply(404, { message: url.pathname });
  });
  t.after(() => server.close());
  return { state, env: { CLEARED_APP_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
}

test('local tracker: the three gestures are written, signed as the human, and the tracker reads them as his', async () => {
  const b = box('local');
  b.credentials({});
  const agents = new LocalTracker({ conf: b.conf, db: openLedger(b.env.ORCH_LEDGER), actor: { kind: 'agents', id: 'cleared' } });
  try {
    const made = agents.createTicket({ title: 'A change', body: 'x', labels: [] });
    agents.moveTicket(made!.identifier, 'Needs Approval');
    b.approvalRecord();
    // An answer: a comment, by the human.
    const answered = await b.write({ op: 'answer', ticket: b.ticket, text: 'Yes, take the charges out first' });
    assert.equal(answered.ok, true, JSON.stringify(answered));
    const comment = agents.comments(b.ticket)[0]!;
    assert.equal(comment.body, 'Yes, take the charges out first');
    assert.deepEqual(comment.by, { kind: 'human', id: 'alice' }); assert.equal(comment.byOwner, true);
    // A stale version is refused; nothing moves.
    const stale = await b.write({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'b'.repeat(40) }], at: b.at });
    assert.equal(stale.ok, false); assert.equal(stale.code, 'version');
    assert.equal(agents.getTicket(b.ticket)!.status, 'Needs Approval');
    // The agreement, for the version on record: the move is the human's, proven by his key.
    const approved = await b.write({ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at });
    assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
    const last = agents.history(b.ticket).at(-1)!;
    assert.equal(last.status, 'Ready to Ship'); assert.deepEqual(last.by, { kind: 'human', id: 'alice' });
    assert.ok(last.approvalContext, 'the agreement is tied to the request that was on record');
    // Send back: the word, then the move.
    agents.moveTicket(b.ticket, 'Needs Approval'); b.approvalRecord();
    const back = await b.write({ op: 'sendback', ticket: b.ticket, text: 'Round the figure to the cent.' });
    assert.equal(back.ok, true, JSON.stringify(back)); assert.equal(back.verified, true);
    assert.equal(agents.getTicket(b.ticket)!.status, 'In Progress');
    assert.equal(agents.comments(b.ticket)[0]!.body, 'Round the figure to the cent.');
    assert.equal(agents.history(b.ticket).at(-1)!.by.kind, 'human');
    // Not waiting for him any more: refused.
    const late = await b.write({ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at });
    assert.equal(late.code, 'state');
  } finally { agents.close(); }
});

test('local tracker: a move written by anyone else than the human never reads as his agreement, whoever signs it', async () => {
  const b = box('local');
  const db = openLedger(b.env.ORCH_LEDGER);
  const agents = new LocalTracker({ conf: b.conf, db, actor: { kind: 'agents', id: 'cleared' } });
  try {
    const made = agents.createTicket({ title: 'A change', body: 'x', labels: [] })!;
    assert.throws(() => agents.moveTicket(made.identifier, 'Ready to Ship'), /Only the configured human/, 'an agent cannot write the status of agreement');
    const shared = new LocalTracker({ conf: b.conf, db, actor: { kind: 'shared', id: 'mallory' } });
    assert.throws(() => shared.moveTicket(made.identifier, 'Ready to Ship'), /Only the configured human/, 'nor an account that is not the owner');
    // A row written straight into the ledger, claiming to be the human with a signature of another key.
    const other = generateKeyPairSync('ed25519').privateKey;
    const forger = new LocalTracker({ conf: { ...b.conf, sections: { ...b.conf.sections, tracker: { ...b.conf.sections.tracker, human_private_key: join(b.creds, 'forged.key') } } }, db, actor: { kind: 'human', id: 'alice' } });
    writeFileSync(join(b.creds, 'forged.key'), other.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    forger.moveTicket(made.identifier, 'Ready to Ship');
    assert.equal(agents.history(made.identifier).at(-1)!.by.kind, 'other', 'the signature does not verify against the human\'s public key');
  } finally { agents.close(); }
});

test('GitHub: the three gestures are written with the human\'s own token, and the timeline shows the human', async (t) => {
  const fake = await fakeGithub(t);
  const b = box('github');
  b.credentials(HUMAN_GH); b.approvalRecord();
  const run = (request: object) => b.write(request, fake.env);
  assert.equal((await run({ op: 'answer', ticket: b.ticket, text: 'Yes' })).ok, true);
  assert.deepEqual(fake.state.comments, [{ body: 'Yes', by: 'alice' }]);
  const stale = await run({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'c'.repeat(40) }], at: b.at });
  assert.equal(stale.code, 'version'); assert.deepEqual(fake.state.labels, ['status:Needs Approval']);
  const approved = await run({ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at });
  assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
  assert.deepEqual(fake.state.labels, ['status:Ready to Ship']);
  assert.equal(fake.state.timeline.at(-1)!.actor.login, 'alice');
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
  b.credentials(AGENT_GH); b.approvalRecord();
  for (const request of [{ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at }, { op: 'sendback', ticket: b.ticket, text: 'x' }, { op: 'answer', ticket: b.ticket, text: 'x' }]) {
    const result = await b.write(request, fake.env);
    assert.equal(result.ok, false); assert.equal(result.code, 'identity');
  }
  assert.deepEqual(fake.state.comments, []); assert.deepEqual(fake.state.labels, ['status:Needs Approval']);
});

test('the writer cannot be pointed at another place by the project settings, and takes only plain https or this machine', async () => {
  const b = box('github', 'github_api_url = https://evil.example\n');
  b.credentials(HUMAN_GH);
  // The settings keys are not read; the default address is api.github.com (unreachable here, so it fails, but never reaches evil.example).
  const result = await b.write({ op: 'answer', ticket: b.ticket, text: 'x' }, { CLEARED_APP_GITHUB_API: 'http://evil.example' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed', 'the browser gets a code, not the reason');
});

test('the gesture text and the target statuses are checked: no empty text, and a sent-back ticket never lands in agreement or done', () => {
  const conf = parseConf('[tracker]\nadapter = local\nowner_id = alice\nvalidate_state = V\ngo_state = G\ndone_state = D\nprogress_state = P\n');
  assert.equal(targetStates(conf).back, 'P');
  assert.equal(targetStates(conf, { sent_back_state: 'R' }).back, 'R');
  for (const bad of ['G', 'D', 'V']) assert.throws(() => targetStates(conf, { sent_back_state: bad }), /must be a working status/);
});

test('human credentials: a private directory and files outside the project, owned by the app account, closed to every other account', () => {
  const b = box('github');
  b.credentials(HUMAN_GH);
  assert.equal(readCredentials(b.creds, { project: b.repo, adapter: 'github' }).token, HUMAN_GH);
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
  assert.throws(() => readCredentials(b.creds, { project: b.repo, adapter: 'other' }), /no user token/);
  // The writer refuses to start from loose credentials: nothing is presented to any tracker.
  chmodSync(join(b.creds, 'credentials.json'), 0o644);
  const run = spawnSync(process.execPath, [join(ORCH_HOME, 'app/human-write.ts')], { env: b.env, input: JSON.stringify({ op: 'answer', ticket: b.ticket, text: 'x' }), encoding: 'utf8' });
  assert.equal(JSON.parse(run.stdout).ok, false);
});

// A real second account: the agents' Unix account must not read the credentials, the passkeys or the access token.
// Needs a passwordless sudo to that account (CLEARED_TEST_AGENT_USER); serve/install.ts runs the same probes on the server.
const agentUser = process.env.CLEARED_TEST_AGENT_USER;
test('the agents\' account cannot read the human credentials, the passkeys or the access token', { skip: agentUser ? false : 'set CLEARED_TEST_AGENT_USER (a second account reachable with sudo -n) to run it' }, () => {
  const b = box('github');
  b.credentials(HUMAN_GH);
  writeFileSync(join(b.creds, 'passkeys.json'), '[]', { mode: 0o600 });
  for (const path of [b.creds, join(b.creds, 'credentials.json'), join(b.creds, 'human-signing.key'), join(b.creds, 'passkeys.json'), process.env.CLEARED_TEST_APP_TOKEN].filter(Boolean) as string[]) {
    const probe = spawnSync('sudo', ['-n', '-u', agentUser!, '--', 'test', '-r', path]);
    assert.notEqual(probe.status, 0, `${path} must not be readable by ${agentUser}`);
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser!, '--', 'test', '-w', path]).status, 0, `${path} must not be writable by ${agentUser}`);
  }
});
