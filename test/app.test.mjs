import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer, ROUTES } from '../app/server.mjs';
import { demoSource } from '../app/sources/demo.mjs';
import { describeRun, scrub, statusLineOf } from '../app/sources/live.mjs';
import { diffSnapshots } from '../app/lib/events.mjs';
import { ensureToken, hostAllowed, readToken, TAILSCALE } from '../app/lib/access.mjs';

const TOKEN = 'a'.repeat(64);
const dirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'cleared-app-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function serve(options = {}) {
  const server = appServer({ source: demoSource(), token: TOKEN, ranges: ['127.0.0.0/8'], pollMs: 50, heartbeatMs: 80, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(3000), ...init });
  return { base, call, close: () => new Promise((r) => { server.close(r); }) };
}
const auth = { authorization: `Bearer ${TOKEN}` };

test('every route of the server is a read, and a write request is refused on all of them', async () => {
  assert.ok(ROUTES.every((r) => r.startsWith('GET ')), 'the route table lists reads only');
  const s = await serve();
  try {
    for (const route of ROUTES) {
      const path = route.slice(4).replace(':id', 'EX-31');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
        if (method === 'TRACE') continue;
        const r = await s.call(path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{"status":"Done"}' : undefined });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(r.headers.get('allow'), 'GET, HEAD');
      }
    }
    // Even before signing in, a write is refused for what it is, not asked for a token.
    assert.equal((await s.call('/api/tickets/EX-31', { method: 'POST' })).status, 405);
  } finally { await s.close(); }
});

test('the server code holds no way to write: no tracker, ledger or process write is imported or called', () => {
  const files = ['app/server.mjs', 'app/main.mjs', 'app/sources/live.mjs', 'app/lib/events.mjs'];
  for (const f of files) {
    const code = readFileSync(join(import.meta.dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '');
    for (const forbidden of [/\.createTicket\(/, /\.moveTicket\(/, /\.comment\(/, /\.editComment\(/, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/, /writeFile|appendFile|unlink|rmSync/, /runStart|runEnd|addEvent/, /spawn-lane|merge-pr|kill-lane/])
      assert.doesNotMatch(code, forbidden, `${f} ${forbidden}`);
  }
});

test('a peer outside the allowed ranges, a wrong host and a missing or wrong token are all refused', async () => {
  let s = await serve({ ranges: TAILSCALE });
  try { for (const path of ['/', '/login', '/api/snapshot', '/events']) assert.equal((await s.call(path, { headers: auth })).status, 403, `outside the ranges: ${path}`); }
  finally { await s.close(); }
  s = await serve();
  try {
    const rebinding = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: new URL(s.base).port, path: '/api/snapshot', headers: { host: 'evil.example', ...auth } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(rebinding, 421, 'a name that is not ours (DNS rebinding)');
    for (const path of ['/api/snapshot', '/api/messages', '/api/tickets/EX-31', '/media/' + 'a'.repeat(64), '/events', '/app.js']) {
      assert.equal((await s.call(path)).status, 401, `no token: ${path}`);
      assert.equal((await s.call(path, { headers: { authorization: 'Bearer wrong' } })).status, 401, `wrong token: ${path}`);
      assert.equal((await s.call(path, { headers: { cookie: 'cleared_app=wrong' } })).status, 401, `wrong cookie: ${path}`);
    }
    const root = await s.call('/');
    assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/login');
    assert.equal((await s.call('/?token=' + TOKEN)).status, 302, 'a token in the address does not open anything');
    assert.equal((await s.call('/api/snapshot?token=' + TOKEN)).status, 401);
    const login = await s.call('/login');
    assert.equal(login.status, 200);
    assert.doesNotMatch(await login.text(), /sample-app|EX-\d+/, 'the sign-in page carries no data');
    assert.equal((await s.call('/session', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const session = await s.call('/session', { headers: auth });
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const withCookie = await s.call('/api/snapshot', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(withCookie.status, 200);
    assert.equal((await s.call('/api/snapshot', { headers: auth })).status, 200);
    assert.equal((await s.call('/nothing', { headers: auth })).status, 404);
    assert.equal((await s.call('/../../etc/passwd', { headers: auth })).status, 404);
  } finally { await s.close(); }
});

test('responses carry a content policy that forbids loading anything from another site, and no pages load external resources', async () => {
  const s = await serve();
  try {
    const r = await s.call('/', { headers: auth });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally { await s.close(); }
  for (const f of readdirSync(join(import.meta.dirname, '..', 'app', 'public'))) {
    const text = readFileSync(join(import.meta.dirname, '..', 'app', 'public', f), 'utf8');
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)/, `${f} names another site`);
    assert.doesNotMatch(text, /@import|innerHTML|insertAdjacentHTML|document\.write|eval\(/, `${f}`);
  }
});

test('the demo data covers the seven cases, with no money amount, path or secret', async () => {
  const snap = await demoSource().snapshot();
  const byId = Object.fromEntries(snap.tickets.map((t) => [t.id, t]));
  assert.ok(byId['EX-31'].screen && byId['EX-31'].waiting && byId['EX-31'].column === 'awaiting', 'a screen ticket that waits for the human');
  assert.ok(!byId['EX-34'].screen, 'a ticket without a screen');
  assert.ok(Object.values(byId).some((t) => t.queued && /place/.test(t.reason)), 'a team waiting for a place');
  assert.ok(snap.fuel.some((f) => !f.measured), 'a subscription that is not measured');
  assert.ok(!snap.health.ok && snap.health.problems.length, 'a problem reported by status');
  const screen = await demoSource().ticket('EX-31');
  assert.ok(screen.show.kind === 'screen' && screen.show.before.length && screen.show.after.length);
  const code = await demoSource().ticket('EX-34');
  assert.ok(code.show.kind === 'code' && code.show.tests.length && code.show.touches);
  const everything = JSON.stringify([snap, screen, code]);
  assert.doesNotMatch(everything, /[€$]|cost|euro|dollar|\/home\/|\/tmp\/|sk-/i);
  const sample = await demoSource().ticket('EX-31');
  assert.ok(sample.where.length <= 3 && sample.blackBox.every((e) => e.text && e.at && e.raw));
  const en = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'lib', 'i18n', 'en.json'), 'utf8'));
  for (const id of Object.keys(byId)) for (const member of (await demoSource().ticket(id)).squad) assert.ok(en[`app_role_${member.role.replace(/ /g, '_')}`], `role ${member.role} has a label`);
  assert.ok(await demoSource().media(screen.show.before[0].url.split('/').pop()), 'the capture is served by the app');
});

test('the stream sends a snapshot, then changes as named events, and a heartbeat', async () => {
  const source = demoSource();
  const s = await serve({ source });
  try {
    const response = await s.call('/events', { headers: auth });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    let buffer = '';
    const read = async (until) => { while (!until(buffer)) { const { value, done } = await reader.read(); if (done) break; buffer += new TextDecoder().decode(value); } };
    await read((b) => b.includes('event: snapshot'));
    const first = JSON.parse(/event: snapshot\ndata: (.*)\n/.exec(buffer)[1]);
    assert.equal(first.type, 'snapshot'); assert.ok(first.id && first.at && first.data.tickets.length);
    // A card changes column: the next frame says so, without the whole state.
    source.move('EX-36', 'review');
    await read((b) => b.includes('event: ticket.updated'));
    assert.match(buffer, /"column":"review"/);
    await read((b) => b.includes('event: heartbeat'));
    reader.cancel();
  } finally { await s.close(); }
});

test('events are diffed by ticket, fuel and health', () => {
  const a = { tickets: [{ id: 'A', column: 'progress' }, { id: 'B', column: 'review' }], fuel: [], health: { ok: true, problems: [] }, mode: 'm' };
  const b = { tickets: [{ id: 'A', column: 'review' }], fuel: [{ adapter: 'x' }], health: { ok: false, problems: [{ code: 'x' }] }, mode: 'm' };
  assert.deepEqual(diffSnapshots(a, b).map((e) => e.type), ['ticket.updated', 'ticket.removed', 'fuel.updated', 'health.updated']);
  assert.deepEqual(diffSnapshots(a, a), []);
});

test('the token file must be private, outside the project and owned by this account; it is created once', () => {
  const dir = scratch();
  const project = join(dir, 'project'); mkdirSync(project);
  const file = join(dir, 'config', 'app-token');
  const token = ensureToken(file, { project });
  assert.equal(token.length, 64);
  assert.equal(ensureToken(file, { project }), token, 'never overwritten');
  chmodSync(file, 0o644);
  assert.throws(() => readToken(file, { project }), /private regular file/);
  chmodSync(file, 0o600);
  const inside = join(project, 'token'); writeFileSync(inside, 'b'.repeat(64), { mode: 0o600 });
  assert.throws(() => readToken(inside, { project }), /outside the project/);
  writeFileSync(join(dir, 'short'), 'abc', { mode: 0o600 });
  assert.throws(() => readToken(join(dir, 'short'), { project }), /too short/);
  assert.ok(hostAllowed('100.64.0.1:8788') && hostAllowed('[::1]:8788') && hostAllowed('box.tail1234.ts.net') && hostAllowed('localhost'));
  assert.ok(!hostAllowed('evil.example') && !hostAllowed(''));
  assert.ok(hostAllowed('cockpit.home', ['cockpit.home']));
});

test('plain-language lines come from runs and events; nothing sensitive passes the scrub', () => {
  assert.equal(describeRun({ role: 'review', model: 'claude-sonnet-5-5', outcome: 'changes' }), 'Review by Sonnet: one fix requested');
  assert.equal(describeRun({ role: 'dev', model: 'gpt-6-luna' }), 'Team started: gpt-6-luna');
  assert.equal(statusLineOf({ handover: '- 1 044 tests green', reviews: 0, column: 'review' }), '1 044 tests green');
  assert.equal(statusLineOf({ handover: '', reviews: 2, column: 'review' }), 'second review round');
  const dirty = scrub('saved at /home/makhtar/.local/state/x/y.md with ghp_abcdefghijklmnop and ' + 'f'.repeat(44) + ' ~/.cleared');
  assert.doesNotMatch(dirty, /\/home|ghp_|f{40}|~\//);
});

test('the app messages exist in English and French', () => {
  const read = (l) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'lib', 'i18n', `${l}.json`), 'utf8'));
  const keys = (c) => Object.keys(c).filter((k) => k.startsWith('app_')).sort();
  assert.deepEqual(keys(read('fr')), keys(read('en')));
  const js = readFileSync(join(import.meta.dirname, '..', 'app', 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(import.meta.dirname, '..', 'app', 'public', 'index.html'), 'utf8');
  const used = new Set([...js.matchAll(/\bt\('(app_[a-z_]+)'/g), ...html.matchAll(/data-i="(app_[a-z_]+)"/g)].map((m) => m[1]));
  for (const k of used) assert.ok(read('en')[k], `missing ${k}`);
});

test('the live source reads a real ledger and a local tracker, read only, and leaks no path or amount', async () => {
  const dir = scratch();
  process.env.ORCH_LEDGER = join(dir, 'ledger.db');
  process.env.CLEARED_STATE_DIR = dir; process.env.ORCH_STATE_DIR = dir;
  const { openLedger, runStart, addEvent } = await import('../lib/ledger.mjs');
  const { LocalTracker } = await import('../lib/tracker/adapters/local.mjs');
  const { liveSource } = await import('../app/sources/live.mjs');
  const db = openLedger();
  const conf = { sections: { owner: { language: 'fr' }, models: { a: 'claude:claude-opus-5-5', b: 'codex:gpt-6-luna' }, merge: { tooling_paths: 'docs/' },
    tracker: { adapter: 'local', agents_uid: '999999', owner_id: 'nobody', todo_state: 'Todo', progress_state: 'In Progress', review_state: 'In Review', validate_state: 'Needs Approval', go_state: 'Ready to Ship', done_state: 'Done' } } };
  new LocalTracker({ conf, db, actor: { kind: 'agents', id: 'x' } });
  const at = new Date().toISOString();
  for (const [title, status] of [['Add a delivery date button on the order page', 'In Progress'], ['Show totals', 'In Review'], ['Waiting ticket', 'Needs Approval']])
    db.prepare('INSERT INTO tracker_tickets(title, body, labels, status, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(title, '', '[]', status, at, at);
  runStart(db, { runId: 'r1', role: 'dev', ticket: 'LOCAL-1', model: 'claude-opus-5-5', provider: 'claude', source: 'dispatcher' });
  db.prepare("UPDATE runs SET outcome='done', pr_number=7, tokens_total=1000, ended_at=? WHERE run_id='r1'").run(at);
  runStart(db, { runId: 'r2', role: 'review', ticket: 'LOCAL-2', model: 'claude-sonnet-5-5', provider: 'claude', source: 'dispatcher' });
  addEvent(db, { kind: 'handover_missing', ticket: 'LOCAL-2', detail: 'saved at /home/someone/.local/state/x/failed.md' });
  db.exec('CREATE TABLE memory_entries (id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL, source_who TEXT NOT NULL, source_where TEXT NOT NULL, source_when TEXT NOT NULL, status TEXT NOT NULL, links TEXT NOT NULL, supersedes TEXT, last_used_at TEXT)');
  db.prepare("INSERT INTO memory_entries(id,type,scope,content,source_who,source_where,status,source_when,links) VALUES ('h1','handover','ticket:LOCAL-2','## Done\nTotals now show with and without tax. 1 044 tests green.\n## Left to do\nNothing.','agent','s','proposed',?,'[]')").run(at);
  db.close();
  const source = liveSource({ conf });
  const snap = await source.snapshot();
  const by = Object.fromEntries(snap.tickets.map((t) => [t.title, t]));
  assert.equal(by['Add a delivery date button on the order page'].column, 'checks', 'author finished with a PR, no review yet');
  assert.equal(by['Show totals'].column, 'review');
  assert.ok(by['Waiting ticket'].waiting && by['Waiting ticket'].column === 'awaiting');
  assert.equal(snap.tickets[0].title, 'Waiting ticket', 'cards that wait for the human come first');
  assert.equal(by['Show totals'].statusLine, '1 044 tests green');
  assert.equal(by['Add a delivery date button on the order page'].model, 'claude-opus-5-5');
  assert.equal(snap.language, 'fr');
  assert.ok(snap.fuel.some((f) => f.adapter === 'codex' && f.measured === false));
  const detail = await source.ticket('2');
  assert.ok(detail.where.length && detail.where.length <= 3);
  assert.ok(detail.blackBox.length >= 2);
  assert.doesNotMatch(JSON.stringify([snap, detail]), /\/home\/|cost|euro|€/i);
  assert.equal(await source.ticket('../../etc/passwd'), null);
  delete process.env.ORCH_LEDGER; delete process.env.CLEARED_STATE_DIR; delete process.env.ORCH_STATE_DIR;
});
