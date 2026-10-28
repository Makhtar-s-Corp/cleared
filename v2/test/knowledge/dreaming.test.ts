// Learning from past sessions (issue #455): a nightly pass per service
// reads the reviewers' change requests of its sessions, groups the defects
// that come back on two tickets or more, and proposes each group as a
// knowledge item that cites its source sessions. Nothing is written
// before the owner's Approve; a rejected proposal is never made again;
// the pass is off per service and skipped at the week stop. Everything
// runs on fixtures: no model, no quota.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeItem } from '../../src/api/types.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { DREAM_HOUR, DREAM_TICKET, DREAMING_TABLES, Dreaming, defectsOf, fingerprint, type DreamingDeps } from '../../src/knowledge/dreaming.ts';
import { knowledgeRoutes } from '../../src/knowledge/routes.ts';
import { Knowledge, type MemoryWrite } from '../../src/knowledge/service.ts';
import { KNOWLEDGE_TABLES } from '../../src/knowledge/store.ts';
import { cleanText } from '../../src/session/clean.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';

const OWNER = { id: 'u1', name: 'owner' };
const OTHER = { id: 'u2', name: 'someone' };
const PROJECT = 'guestbook';

const service = (name: string): ServiceConfig => ({
  name, kind: 'repository', repo: `example/${name}`, url: `file:///srv/${name}`, base: 'main', path: null, healthUrl: null, sensitivity: 'normal',
  consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, dir: `/srv/${name}`,
});

const WORKSPACE: WorkspaceConfig = { id: PROJECT, name: 'Guestbook', file: '/srv/workspace.conf', services: [service('guestbook'), service('filter-api')] };

// A reviewer's report as the review prompt asks for it (flow/prompts.ts).
const report = (...defects: string[]) => [
  'I read the change and ran the tests.', '',
  'Verdict: fix before merge',
  'Defects:',
  ...defects.map((defect) => `- ${defect}`),
  'To verify: nothing.',
  'Questions for the user: None.',
].join('\n');

const SWALLOWED = (file: string) => `\`${file}:12\` the exit code of the test command is swallowed, so a failing run still reports success; expected the failure to stop the step.`;
const UNRELATED = 'The page title is missing on the settings screen.';

type Clock = { at: Date };

function setup(options: { readonly limit?: number; readonly write?: MemoryWrite } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...KNOWLEDGE_TABLES, ...DREAMING_TABLES]);
  const clock: Clock = { at: new Date(2026, 9, 28, DREAM_HOUR, 30, 0) };
  const now = () => clock.at;
  const inbox = new InboxStore(store.db, now);
  const writes: unknown[] = [];
  const write: MemoryWrite = options.write ?? (async (_context, entry) => { writes.push(entry); return `m${writes.length}`; });
  const knowledge = new Knowledge({
    db: store.db, inbox, tickets: new MemoryTicketStore(), workspace: WORKSPACE, memory: { project: '/srv/guestbook', env: {} },
    ownerId: OWNER.name, clean: (text) => cleanText(text, {}), now, write,
  });
  const deps: DreamingDeps = {
    db: store.db, inbox, workspace: WORKSPACE, project: PROJECT, ownerId: OWNER.name,
    clean: (text) => cleanText(text, {}), now, weekStopPercent: () => options.limit ?? 85,
  };
  const dreaming = new Dreaming(deps);
  return { store, inbox, knowledge, dreaming, clock, writes, deps };
}

let counter = 0;
// A reviewer session of `ticket` on `service` that asked for changes with
// `text`, journaled as the flow does: its verdict, then the request on the
// channel, on the reviewer's session; the author's copy on the author's.
function rejected(store: Store, input: { readonly ticket: string; readonly service?: string | null; readonly text: string; readonly at?: string; readonly session?: string; readonly round?: number }) {
  const session = input.session ?? `0000000${++counter}-1111-4222-8333-444455556666`.slice(-36);
  const author = `a${session.slice(1)}`;
  const at = input.at ?? '2026-10-27T10:00:00.000Z';
  if (!store.sessions.get(session)) {
    for (const [id, role] of [[session, 'reviewer'], [author, 'author']] as const)
      store.sessions.put({ id, project: PROJECT, ticket: input.ticket, role, harness: 'claude-code', model: 'claude-sonnet-5-5', status: 'done', createdAt: at, updatedAt: at, service: input.service === undefined ? 'guestbook' : input.service });
  }
  const round = input.round ?? 1;
  const base = { at, ticket: input.ticket, project: PROJECT };
  store.events.append({ ...base, sessionId: session, event: { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session, verdict: 'changes_requested', round } } as never });
  const request = { round, limit: 3, from: 'reviewer', text: input.text };
  store.events.append({ ...base, sessionId: session, event: { type: 'CUSTOM', name: 'cleared.review_channel', value: request } as never });
  store.events.append({ ...base, sessionId: author, event: { type: 'CUSTOM', name: 'cleared.review_channel', value: request } as never });
  return session;
}

const dreams = (inbox: InboxStore, state: 'waiting' | 'handled' = 'waiting'): KnowledgeItem[] => inbox.knowledge({ ticket: DREAM_TICKET, state });

test('the defects of a report: the lines of its Defects section, without the file and line, never its verdict or its other sections', () => {
  const text = report(SWALLOWED('src/run.ts'), 'None of the new paths has a test, so a regression would pass the review unseen.');
  assert.deepEqual(defectsOf(text), [
    'the exit code of the test command is swallowed, so a failing run still reports success; expected the failure to stop the step.',
    'None of the new paths has a test, so a regression would pass the review unseen.',
  ]);
  assert.deepEqual(defectsOf(report('None.')), []);
  assert.deepEqual(defectsOf('Verdict: fix before merge\nDefects: `a.ts:3` the loop never ends when the list is empty, expected it to stop.\nTests: passed.'),
    ['the loop never ends when the list is empty, expected it to stop.']);
  assert.deepEqual(defectsOf('No section here.'), []);
});

test('a fingerprint is the same for the same rule written with other case, spaces, punctuation or markdown', () => {
  const one = fingerprint('The exit code of the test command is swallowed.');
  assert.equal(fingerprint('**the  EXIT code** of the `test command` is swallowed!!'), one);
  assert.equal(fingerprint('- The exit code of the test command is swallowed'), one);
  assert.notEqual(fingerprint('The exit code of the build is checked.'), one);
});

test('a defect found on two tickets becomes one proposal, waiting in the inbox, citing both reviewer sessions; nothing is written', async () => {
  const { store, inbox, dreaming, writes } = setup();
  const first = rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts'), UNRELATED), at: '2026-10-20T10:00:00.000Z' });
  const second = rejected(store, { ticket: 'LOCAL-2', text: report(`\`lib/steps.ts:40\` The exit code of the test command is swallowed, so a failing run reports success; expected the failure to stop the step.`), at: '2026-10-26T10:00:00.000Z' });
  const passes = await dreaming.tick();
  assert.deepEqual(passes.map((pass) => [pass.service, pass.outcome, pass.proposed]), [['guestbook', 'done', 1], ['filter-api', 'done', 0]]);
  const [item, ...rest] = dreams(inbox);
  assert.equal(rest.length, 0);
  assert.ok(item);
  assert.equal(item.state, 'waiting');
  assert.equal(item.level, 'service');
  assert.equal(item.service, 'guestbook');
  assert.equal(item.ticket, DREAM_TICKET);
  // The most recent wording, without its file and line.
  assert.equal(item.text, 'The exit code of the test command is swallowed, so a failing run reports success; expected the failure to stop the step.');
  assert.deepEqual(item.sources?.map((source) => [source.session, source.ticket]), [[second, 'LOCAL-2'], [first, 'LOCAL-1']]);
  assert.equal(item.sessionId, second);
  // Proposed only: no memory written, nothing queued for the skill.
  assert.equal(writes.length, 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_skill').get() as { n: number }).n, 0);
  // A second pass on the same day does nothing.
  assert.deepEqual(await dreaming.tick(), []);
  assert.equal(dreams(inbox).length, 1);
});

test('fewer than two source sessions, no proposal: one ticket, one reviewer resumed over rounds, the author\'s copy of the request', async () => {
  const { store, inbox, dreaming } = setup();
  // One reviewer resumed: two rounds in one session, one ticket.
  const session = rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-1', session, round: 2, text: report(SWALLOWED('src/run.ts')) });
  // A new reviewer of the same ticket: still one ticket.
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/other.ts')) });
  const [pass] = await dreaming.tick();
  assert.equal(pass?.outcome, 'done');
  assert.equal(pass?.proposed, 0);
  assert.equal(dreams(inbox).length, 0);
});

test('a defect seen on another service\'s sessions counts for that service only', async () => {
  const { store, inbox, dreaming, clock } = setup();
  rejected(store, { ticket: 'LOCAL-1', service: 'guestbook', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', service: 'filter-api', text: report(SWALLOWED('src/run.ts')) });
  await dreaming.tick();
  assert.equal(dreams(inbox).length, 0);
  // A session with no service is the workspace's first service's.
  rejected(store, { ticket: 'LOCAL-3', service: null, text: report(SWALLOWED('src/run.ts')) });
  clock.at = new Date(2026, 9, 29, DREAM_HOUR, 30, 0);
  await dreaming.tick();
  assert.deepEqual(dreams(inbox).map((item) => [item.service, item.sources?.length]), [['guestbook', 2]]);
});

test('Approve alone writes a proposal into the memory and the skill\'s queue, through the API; Reject writes nothing', async () => {
  const { store, inbox, knowledge, dreaming, writes } = setup();
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  await dreaming.tick();
  const [item] = dreams(inbox);
  assert.ok(item);
  const routes = knowledgeRoutes({ knowledge: () => knowledge, proof: () => 'proof', start: async () => {} });
  const call = async (path: string, user: string | undefined, proof = 'proof') => {
    const route = routes.find((candidate) => candidate.path === path) as (typeof routes)[number];
    let status = 0;
    const response = { writeHead: (code: number) => { status = code; }, end: () => {} };
    const headers: Record<string, string> = { 'x-cleared-proof': proof, ...(user ? { 'x-cleared-user': user } : {}) };
    const registry = { users: { get: async (id: string) => [OWNER, OTHER].find((u) => u.id === id) } };
    await route.handle({ request: { headers }, response, params: { id: item.id }, registry } as never);
    return status;
  };
  // Not the owner, no proof, no user: refused, nothing written.
  assert.equal(await call('/api/knowledge/:id/approve', OTHER.id), 403);
  assert.equal(await call('/api/knowledge/:id/approve', OWNER.id, 'wrong'), 401);
  assert.equal(await call('/api/knowledge/:id/approve', undefined), 403);
  assert.equal(writes.length, 0);
  assert.equal(dreams(inbox).length, 1);
  assert.equal(await call('/api/knowledge/:id/approve', OWNER.id), 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { scope: 'project:guestbook', content: `Lesson: ${item.text}`, where: item.id, owner: OWNER.name, ticket: DREAM_TICKET });
  assert.deepEqual((store.db.prepare('SELECT service, text FROM knowledge_skill').all() as Record<string, unknown>[]).map((row) => ({ ...row })), [{ service: 'guestbook', text: item.text }]);
  assert.equal(dreams(inbox, 'handled')[0]?.outcome?.decision, 'approve');
});

test('a rejected proposal is never made again, the same words or the same rule written otherwise', async () => {
  const { store, inbox, knowledge, dreaming, clock, writes } = setup();
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  await dreaming.tick();
  const [item] = dreams(inbox);
  assert.ok(item);
  await knowledge.reject(item.id, OWNER);
  assert.equal(writes.length, 0);
  // The next night: the same reports, and two new ones with the same rule in other words.
  clock.at = new Date(2026, 9, 29, DREAM_HOUR, 30, 0);
  rejected(store, { ticket: 'LOCAL-3', at: '2026-10-28T12:00:00.000Z', text: report('`a.ts:1` **The exit code of the test command is SWALLOWED**, so a failing run still reports success: expected the failure to stop the step!') });
  rejected(store, { ticket: 'LOCAL-4', at: '2026-10-28T13:00:00.000Z', text: report('- the exit code of the  test command is swallowed; so a failing run still reports success, expected the failure to stop the step') });
  const passes = await dreaming.tick();
  assert.equal(passes[0]?.proposed, 0);
  assert.equal(dreams(inbox).length, 0);
  // The rejection is kept apart from the inbox: an inbox that no longer had the item would not bring the rule back.
  store.db.exec("DELETE FROM flow_inbox WHERE kind = 'knowledge'");
  clock.at = new Date(2026, 9, 30, DREAM_HOUR, 30, 0);
  assert.equal((await dreaming.tick())[0]?.proposed, 0);
  assert.equal(dreams(inbox).length, 0);
});

test('a handover\'s knowledge rejected counts too, and nothing already proposed, approved or waiting is proposed again', async () => {
  const { store, inbox, knowledge, dreaming, clock } = setup();
  // A handover proposed the same rule; the owner rejected it.
  const handed = inbox.addKnowledge({ ticket: 'LOCAL-9', project: PROJECT, sessionId: 'handover-session', text: 'The exit code of the test command is swallowed, so a failing run still reports success; expected the failure to stop the step.', level: 'workspace', service: null });
  await knowledge.reject(handed.id, OWNER);
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  // A second rule, approved through a handover: already in the memory.
  const approved = inbox.addKnowledge({ ticket: 'LOCAL-8', project: PROJECT, sessionId: 'handover-other', text: 'None of the new paths has a test, so a regression would pass the review unseen.', level: 'service', service: 'guestbook' });
  await knowledge.approve(approved.id, OWNER);
  rejected(store, { ticket: 'LOCAL-3', text: report('None of the new paths has a test, so a regression would pass the review unseen.') });
  rejected(store, { ticket: 'LOCAL-4', text: report('None of the new paths has a test; a regression would pass the review unseen.') });
  // A third rule, proposed once and still waiting: not proposed twice.
  rejected(store, { ticket: 'LOCAL-5', text: report(UNRELATED) });
  rejected(store, { ticket: 'LOCAL-6', text: report(UNRELATED) });
  const [first] = await dreaming.tick();
  assert.equal(first?.proposed, 1);
  assert.deepEqual(dreams(inbox).map((item) => item.text), [UNRELATED]);
  clock.at = new Date(2026, 9, 29, DREAM_HOUR, 30, 0);
  const [second] = await dreaming.tick();
  assert.equal(second?.proposed, 0);
  assert.equal(dreams(inbox).length, 1);
});

test('a secret-looking value never reaches a proposal: the defect that holds one is left out, whatever the shape', async () => {
  // Fictitious values, built from parts so that no file holds one.
  const fakes = [
    ['gh', 'p_', 'FAKEfake0123456789FAKEfake0123'].join(''),
    ['gl', 'pat-', 'FAKEfake0123456789FAKE'].join(''),
    ['AK', 'IA', 'FAKE0000EXAMPLE0'].join(''),
    ['Bearer ', 'fakeFAKE0123456789fake'].join(''),
    ['API', '_KEY=', 'fakeFAKE01234567'].join(''),
    ['deploy', ':', 'hunter22fake', '@', 'db.example.test'].join(''),
    ['sk-', 'ant-', 'FAKEfake0123456789FAKEfake0123'].join(''),
  ];
  for (const fake of fakes) {
    const { store, inbox, dreaming, clock } = setup();
    // The same defect on three tickets; the most recent wording holds the value.
    rejected(store, { ticket: 'LOCAL-1', at: '2026-10-20T10:00:00.000Z', text: report(`The exit code of the deploy check is swallowed, so a failing run still reports success; the run used ${fake} as its login.`) });
    rejected(store, { ticket: 'LOCAL-2', at: '2026-10-26T10:00:00.000Z', text: report(`The exit code of the deploy check is swallowed, so a failing run still reports success; the run used ${fake} as its login.`) });
    await dreaming.tick();
    assert.equal(dreams(inbox).length, 0, fake.slice(0, 4));
    // Two clean reports: the proposal is made from them, and the value is in no inbox row.
    rejected(store, { ticket: 'LOCAL-3', at: '2026-10-27T10:00:00.000Z', text: report('The exit code of the deploy check is swallowed, so a failing run still reports success.') });
    rejected(store, { ticket: 'LOCAL-4', at: '2026-10-27T11:00:00.000Z', text: report('The exit code of the deploy check is swallowed, so a failing run still reports success.') });
    clock.at = new Date(2026, 9, 29, DREAM_HOUR, 30, 0);
    await dreaming.tick();
    const [item] = dreams(inbox);
    assert.equal(item?.text, 'The exit code of the deploy check is swallowed, so a failing run still reports success.');
    assert.deepEqual(item?.sources?.map((source) => source.ticket), ['LOCAL-4', 'LOCAL-3']);
    const rows = JSON.stringify(store.db.prepare('SELECT * FROM flow_inbox').all());
    assert.ok(!rows.includes(fake), fake.slice(0, 4));
    assert.ok(!rows.includes('[removed'));
  }
});

test('off for a service: no pass for it; the switch is the owner\'s, through the API', async () => {
  const { store, inbox, dreaming } = setup();
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  assert.throws(() => dreaming.set('guestbook', false, OTHER), { kind: 'forbidden' });
  assert.throws(() => dreaming.set('nowhere', false, OWNER), { kind: 'not_found' });
  dreaming.set('guestbook', false, OWNER);
  assert.deepEqual(dreaming.view().services.map((row) => [row.service, row.enabled]), [['guestbook', false], ['filter-api', true]]);
  const passes = await dreaming.tick();
  assert.deepEqual(passes.map((pass) => [pass.service, pass.outcome]), [['guestbook', 'off'], ['filter-api', 'done']]);
  assert.equal(dreams(inbox).length, 0);
  // On again the same day: the pass runs.
  dreaming.set('guestbook', true, OWNER);
  const again = await dreaming.tick();
  assert.deepEqual(again.map((pass) => [pass.service, pass.outcome, pass.proposed]), [['guestbook', 'done', 1]]);
});

test('at the week stop the pass is skipped, read from the quota as the plans read it; below it, it runs', async () => {
  const { store, inbox, dreaming, clock } = setup({ limit: 85 });
  rejected(store, { ticket: 'LOCAL-1', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  const quota = (usedPercent: number, at: string) => store.events.append({
    at, sessionId: 'quota-session', ticket: 'LOCAL-1', project: PROJECT,
    event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent, resetsAt: '2026-11-02T00:00:00.000Z' } } as never,
  });
  quota(90, '2026-10-28T01:00:00.000Z');
  const skipped = await dreaming.tick();
  assert.deepEqual(skipped.map((pass) => pass.outcome), ['quota', 'quota']);
  assert.equal(dreams(inbox).length, 0);
  // Read again later that night, below the stop: the pass runs.
  quota(40, '2026-10-28T02:40:00.000Z');
  clock.at = new Date(2026, 9, 28, DREAM_HOUR, 50, 0);
  const ran = await dreaming.tick();
  assert.deepEqual(ran.map((pass) => [pass.service, pass.outcome]), [['guestbook', 'done'], ['filter-api', 'done']]);
  assert.equal(dreams(inbox).length, 1);
  assert.deepEqual(dreaming.view().services.map((row) => row.last?.outcome), ['done', 'done']);
});

test('before the pass\'s hour nothing runs; reports older than the window are not read', async () => {
  const { store, inbox, dreaming, clock } = setup();
  rejected(store, { ticket: 'LOCAL-1', at: '2026-08-01T10:00:00.000Z', text: report(SWALLOWED('src/run.ts')) });
  rejected(store, { ticket: 'LOCAL-2', text: report(SWALLOWED('src/steps.ts')) });
  clock.at = new Date(2026, 9, 28, DREAM_HOUR - 1, 59, 0);
  assert.deepEqual(await dreaming.tick(), []);
  clock.at = new Date(2026, 9, 28, DREAM_HOUR, 0, 0);
  const [pass] = await dreaming.tick();
  assert.equal(pass?.proposed, 0);
  assert.equal(dreams(inbox).length, 0);
});

test('at most a few proposals per service and pass, the defects seen on the most tickets first', async () => {
  const { store, inbox, dreaming } = setup();
  const rules = [
    'The upload handler drops the request body when the client retries.',
    'A migration renames a column that the running release still reads.',
    'The cache key ignores the locale, so French pages show English titles.',
    'The retry loop sleeps without a limit when the broker never answers.',
    'Dates are compared as strings, so October sorts before September.',
    'The form accepts an empty email and saves a guest nobody can reach.',
    'The worker logs the full request payload, guest messages included.',
  ];
  rules.forEach((rule, index) => {
    const tickets = index === 6 ? 4 : 2;
    for (let n = 0; n < tickets; n++) rejected(store, { ticket: `LOCAL-${index}-${n}`, text: report(rule) });
  });
  const [pass] = await dreaming.tick();
  assert.equal(pass?.proposed, 5);
  assert.equal(dreams(inbox)[0]?.text, rules[6]);
});

test('the switch through the API: GET /api/dreaming reads each service, POST /api/dreaming/:service sets one, the owner only', async () => {
  const { knowledge, dreaming } = setup();
  const routes = knowledgeRoutes({ knowledge: () => knowledge, dreaming: () => dreaming, proof: () => 'proof', start: async () => {} });
  const call = async (method: string, path: string, user: string, params: Record<string, string> = {}, body?: unknown) => {
    const route = routes.find((candidate) => candidate.method === method && candidate.path === path) as (typeof routes)[number];
    let status = 0;
    let text = '';
    const response = { writeHead: (code: number) => { status = code; }, end: (chunk: string) => { text = chunk; } };
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = Object.assign((async function* () { yield* chunks; })(), { headers: { 'x-cleared-proof': 'proof', 'x-cleared-user': user } });
    const registry = { users: { get: async (id: string) => [OWNER, OTHER].find((u) => u.id === id) } };
    await route.handle({ request, response, params, registry } as never);
    return { status, body: JSON.parse(text) as unknown };
  };
  const read = await call('GET', '/api/dreaming', OTHER.id);
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as { services: { service: string; enabled: boolean }[] }).services.map((row) => [row.service, row.enabled]), [['guestbook', true], ['filter-api', true]]);
  assert.equal((await call('POST', '/api/dreaming/:service', OTHER.id, { service: 'guestbook' }, { enabled: false })).status, 403);
  assert.equal((await call('POST', '/api/dreaming/:service', OWNER.id, { service: 'nowhere' }, { enabled: false })).status, 404);
  assert.equal((await call('POST', '/api/dreaming/:service', OWNER.id, { service: 'guestbook' }, { enabled: 'no' })).status, 400);
  assert.equal((await call('POST', '/api/dreaming/:service', OWNER.id, { service: 'guestbook' }, { enabled: false })).status, 200);
  assert.deepEqual(dreaming.view().services.map((row) => [row.service, row.enabled]), [['guestbook', false], ['filter-api', true]]);
});
