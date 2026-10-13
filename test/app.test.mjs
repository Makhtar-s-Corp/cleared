import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer, ROUTES } from '../app/server.mjs';
import { demoSource } from '../app/sources/demo.mjs';
import { describeRun, scrub, statusLineOf, boardCollector, writeBoardSnapshot } from '../lib/board-collector.mjs';
import { liveSource } from '../app/sources/live.mjs';
import { diffSnapshots } from '../app/lib/events.mjs';
import { checkRanges, ensureToken, hostAllowed, readToken, TAILSCALE } from '../app/lib/access.mjs';
import { spawnSync } from 'node:child_process';

const TOKEN = 'a'.repeat(64);
// Amber (token or value) may appear only in the rules of what waits for the human, the greeting highlight, the project dot and the token definitions.
const ALLOWED_AMBER = /\.key\b|\.card\.ready|\.card\.question|\.chip\.q|\.amber-bar|\.project::before|data-col="awaiting"|\.d-awaiting|st-awaiting|^\s*(--|:root)|^\s*--awaiting/;
const AMBER = /var\(--(?:awaiting|e-awaiting)[^)]*\)|#F5A623|#AB570A|#FFFBF2|#FCE2B3|245,\s*166,\s*35|171,\s*87,\s*10/i;
const amberViolations = (css) => css.split('\n').filter((line) => AMBER.test(line) && !ALLOWED_AMBER.test(line)).map((line) => line.trim().slice(0, 80));
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
  for (const f of readdirSync(join(import.meta.dirname, '..', 'app', 'public')).filter((n) => /\.(html|css|js)$/.test(n))) {
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
  assert.ok(Object.values(byId).some((t) => t.queued && /slot|place/.test(t.reason)), 'a team waiting for a place');
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
  const c = { ...b, landed: [{ id: 'EX-1' }], stats: { inFlight: 1 } };
  assert.deepEqual(diffSnapshots(b, c).map((e) => e.type), ['stats.updated'], 'a release that lands reaches the page');
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
  const dirty = scrub('saved at /home/someone/.local/state/x/y.md with ghp_abcdefghijklmnop and ' + 'f'.repeat(44) + ' ~/.cleared');
  assert.doesNotMatch(dirty, /\/home|ghp_|f{40}|~\//);
  const more = scrub('push failed https://x-access-token:ghs_AbCdEfGh1234567890@github.com/o/r.git and lane EX-31 has cost 12.40 $ at list price, cap $10, 8 € spent; key ' + 'A1b2'.repeat(9));
  assert.doesNotMatch(more, /ghs_|x-access-token:|12\.40|\$10|8 €|A1b2A1b2/);
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

test('the cookie never holds the token, and a range without a prefix length is refused', async () => {
  const s = await serve();
  try {
    const cookie = (await s.call('/session', { headers: auth })).headers.get('set-cookie');
    assert.ok(!cookie.includes(TOKEN), 'the cookie is a derived session value');
    assert.equal((await s.call('/api/snapshot', { headers: { cookie: `cleared_app=${TOKEN}` } })).status, 401, 'the token itself is not a cookie');
    assert.equal((await s.call('/events', { method: 'HEAD', headers: auth })).status, 200, 'HEAD on the stream does not open one');
  } finally { await s.close(); }
  assert.deepEqual(checkRanges(['100.64.0.0/10', 'fd7a:115c:a1e0::/48']), ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
  for (const bad of ['192.168.1.20', '10.0.0.0/33', '::1/129', 'foo/8', '10.0.0.0/8/1', '10.0.0.0/']) assert.throws(() => checkRanges([bad]), /prefix length/, bad);
});

test('a failed read ends the heartbeat: the page cannot take stale cards for live ones', async () => {
  const source = demoSource();
  let fail = false;
  const real = source.snapshot.bind(source);
  source.snapshot = async () => { if (fail) throw new Error('down'); return real(); };
  const s = await serve({ source, pollMs: 30, heartbeatMs: 60 });
  try {
    const reader = (await s.call('/events', { headers: auth })).body.getReader();
    let buffer = '', pending = null;
    const pump = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { pending ??= reader.read(); const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), 40))]); if (r) { pending = null; if (r.value) buffer += new TextDecoder().decode(r.value); } } };
    await pump(250);
    assert.match(buffer, /event: heartbeat/);
    fail = true; await pump(100); buffer = '';
    await pump(300);
    assert.doesNotMatch(buffer, /event: heartbeat/);
    reader.cancel();
  } finally { await s.close(); }
});

test('`cleared app` refuses a bad range and prints the address of the bind it is given', () => {
  const dir = scratch();
  const file = join(scratch(), 'token');
  ensureToken(file, {});
  const conf = join(dir, 'agents.conf');
  const run = (extra, ranges) => {
    writeFileSync(conf, `[app]\nranges = ${ranges}\ntoken_file = ${file}\n`);
    return spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cleared'), 'app', ...extra], { encoding: 'utf8', env: { ...process.env, CLEARED_CONF: conf, CLEARED_REPO: dir } });
  };
  const bad = run(['--link'], '192.168.1.20');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /prefix length/);
  const link = run(['--bind', '100.101.102.103', '--link'], '100.64.0.0/10');
  assert.equal(link.status, 0, link.stderr);
  assert.match(link.stdout, /^http:\/\/100\.101\.102\.103:8788\/login#[0-9a-f]{64}\n$/);
  assert.equal(run(['--nonsense'], '').status, 64);
});

test('the old dashboard address redirects to the app when one is configured, and stays a page otherwise', async () => {
  const { dashboardServer } = await import('../serve/serve-dashboard.mjs');
  const dir = scratch(); writeFileSync(join(dir, 'index.html'), '<p>page</p>');
  const ask = async () => {
    const server = dashboardServer({ file: join(dir, 'index.html'), ranges: ['127.0.0.0/8'] });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { redirect: 'manual' });
    server.closeAllConnections(); server.close();
    return [r.status, r.headers.get('location')];
  };
  assert.deepEqual(await ask(), [200, null]);
  process.env.CLEARED_APP_URL = 'http://100.64.0.9:8788/';
  try { assert.deepEqual(await ask(), [302, 'http://100.64.0.9:8788/']); } finally { delete process.env.CLEARED_APP_URL; }
});

test('the design is followed: no gradient, fonts served by the app, light by default, amber only for the human', async () => {
  const pub = join(import.meta.dirname, '..', 'app', 'public');
  const css = readFileSync(join(pub, 'style.css'), 'utf8');
  for (const f of ['style.css', 'app.js', 'index.html', 'login.html']) assert.doesNotMatch(readFileSync(join(pub, f), 'utf8'), /gradient|conic|image-set|filter:\s*blur/i, `${f} has no gradient`);
  assert.match(css, /font-family: Geist;[^}]*\/fonts\/Geist-Variable\.woff2/);
  assert.match(css, /font-family: "Geist Mono";[^}]*\/fonts\/GeistMono-Variable\.woff2/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/, 'light by default; dark only when chosen');
  assert.doesNotMatch(readFileSync(join(pub, 'app.js'), 'utf8'), /\.style\.cssText|setAttribute\('style'/, 'no inline style, which the content policy refuses');
  // the tokens of DESIGN.md are the ones of the style sheet
  for (const hex of ['#FAFAFA', '#FFFFFF', '#F4F4F4', '#EAEAEA', '#171717', '#4D4D4D', '#666666', '#8F8F8F', '#F5A623', '#AB570A', '#FFFBF2', '#FCE2B3', '#16A34A', '#F2FBF5', '#EE0000', '#0070F3', '#7928CA', '#0A9DB0', '#D97757', '#10A37F'])
    assert.ok(css.toUpperCase().includes(hex), `${hex} is in the style sheet`);
  // amber is used for the human only: every rule that names an amber token or value is one of the rules for what waits
  assert.deepEqual(amberViolations(css), [], 'amber used outside what waits for the human');
  assert.ok(amberViolations('.conn2 { background: var(--awaiting); }\n.x { color: #F5A623; }').length === 2, 'the check can fail');
  assert.doesNotMatch(css, /(^|\n)button\.ink/, 'the login button style does not leak to the placeholders');
  for (const f of ['index.html', 'login.html']) assert.doesNotMatch(readFileSync(join(pub, f), 'utf8'), /\sstyle=|<style/i, `${f}: no inline style, which the content policy refuses`);
  const s = await serve();
  try {
    const font = await s.call('/fonts/Geist-Variable.woff2');
    assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal((await s.call('/fonts/GeistMono-Variable.woff2')).status, 200);
    assert.equal((await s.call('/fonts/../server.mjs', { headers: auth })).status, 404);
    assert.equal((await s.call('/fonts/LICENSE.txt', { headers: auth })).status, 404, 'only the two font files are served');
  } finally { await s.close(); }
  const en = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'lib', 'i18n', 'en.json'), 'utf8'));
  const fr = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'lib', 'i18n', 'fr.json'), 'utf8'));
  const js = readFileSync(join(pub, 'app.js'), 'utf8');
  for (const key of ['app_wait_ready_one_tone', 'app_wait_ready_other_tone', 'app_wait_ready_key_one', 'app_wait_ready_key_other', 'app_wait_need_one_tone', 'app_wait_need_other_tone', 'app_wait_need_key_one', 'app_wait_need_key_other', 'app_wait_none', 'app_col_progress', 'app_col_checks', 'app_col_review', 'app_col_awaiting'])
    assert.ok(en[key] && fr[key], key);
  assert.match(en.app_share_label, /share of this week.s usage/);
  assert.equal(fr.app_wait_need_key_other, 'vous attendent.', 'two things wait: the verb agrees');
  assert.equal(fr.app_wait_ready_key_other, 'prêtes à partir.');
  assert.match(js, /app_share_label/);
});

const boardConf = (adapter = 'local') => ({ sections: { owner: { language: 'en' }, heartbeat: { wake_interval_minutes: '1' },
  tracker: { adapter, repository: 'owner/repo', progress_state: 'In Progress', review_state: 'In Review', validate_state: 'Needs Approval', go_state: 'Ready to Ship' } } });
async function boardFixture(adapter = 'local', imageUrl = null) {
  const dir = scratch();
  process.env.ORCH_LEDGER = join(dir, 'ledger.db'); process.env.CLEARED_STATE_DIR = dir; process.env.ORCH_STATE_DIR = dir;
  const { openLedger } = await import('../lib/ledger.mjs');
  const db = openLedger();
  db.exec('CREATE TABLE heartbeat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE heartbeat_incidents (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, active INTEGER);');
  db.prepare('INSERT INTO heartbeat_state VALUES (?,?)').run('last_wake_at', new Date().toISOString());
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const pngAfter = Buffer.from(png); pngAfter[pngAfter.length - 1] ^= 1;
  const digest = (await import('node:crypto')).createHash('sha256').update(png).digest('hex');
  const digestAfter = (await import('node:crypto')).createHash('sha256').update(pngAfter).digest('hex');
  if (adapter === 'local') {
    db.exec('CREATE TABLE tracker_images (digest TEXT PRIMARY KEY, mime TEXT, body BLOB);');
    db.prepare('INSERT INTO tracker_images VALUES (?,?,?)').run(digest, 'image/png', png);
    db.prepare('INSERT INTO tracker_images VALUES (?,?,?)').run(digestAfter, 'image/png', pngAfter);
  }
  db.close();
  const ref = adapter === 'local' ? 'LOCAL-1' : adapter === 'github' ? '1' : 'TKT-1';
  const ticket = { id: ref, identifier: ref, title: 'Screen before and after', body: '', status: 'Needs Approval' };
  const url = imageUrl || `local://capture/${digest}`;
  const afterUrl = imageUrl ? `${imageUrl}?after=1` : `local://capture/${digestAfter}`;
  const trackerClient = {
    listTickets: ({ status }) => status === 'Needs Approval' ? [ticket] : [],
    getTicket: () => ticket,
    comments: () => [{ body: `**Before**\n![Before](${url})\n**After**\n![After](${afterUrl})` }],
  };
  const conf = boardConf(adapter);
  return { dir, png, digest, trackerClient, conf, close: () => { delete process.env.ORCH_LEDGER; delete process.env.CLEARED_STATE_DIR; delete process.env.ORCH_STATE_DIR; } };
}

test('the app source has no tracker, forge, process or network dependency', () => {
  for (const path of ['app/main.mjs', 'app/server.mjs', 'app/sources/live.mjs', 'app/lib/events.mjs']) {
    const code = readFileSync(join(import.meta.dirname, '..', path), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /tracker\/contract|tracker\/adapters|\bgh\b|fetch\(|execFile|spawn\(|https?\.request|createConnection/, path);
  }
});

test('a hung tracker cannot delay the app response from the last snapshot', async () => {
  const f = await boardFixture();
  try {
    await writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir });
    f.trackerClient.listTickets = () => { throw new Error('tracker unreachable'); };
    const s = await serve({ source: liveSource({ conf: f.conf, dir: f.dir }) });
    try {
      const start = performance.now();
      const response = await s.call('/api/snapshot', { headers: auth });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).tickets.length, 1);
      assert.ok(performance.now() - start < 200, 'served in under 200 ms');
    } finally { await s.close(); }
  } finally { f.close(); }
});

test('an interrupted collection leaves the complete prior snapshot intact', async () => {
  const f = await boardFixture();
  try {
    await writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir });
    const path = join(f.dir, 'snapshot.json');
    const before = readFileSync(path);
    f.trackerClient.comments = () => { throw new Error('lost connection'); };
    await assert.rejects(writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir }));
    assert.deepEqual(readFileSync(path), before);
  } finally { f.close(); }
});

test('missing, stale and unknown-version snapshots are visible as health problems', async () => {
  const f = await boardFixture();
  try {
    const source = liveSource({ conf: f.conf, dir: f.dir });
    assert.match((await source.snapshot()).health.problems[0].message, /No board snapshot/);
    const snap = await boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }).snapshot();
    snap.generatedAt = new Date(Date.now() - 5 * 60000).toISOString();
    writeFileSync(join(f.dir, 'snapshot.json'), JSON.stringify(snap));
    assert.match((await source.snapshot()).health.problems[0].message, /5 min old/);
    snap.schema = 99;
    writeFileSync(join(f.dir, 'snapshot.json'), JSON.stringify(snap));
    assert.match((await source.snapshot()).health.problems[0].message, /format is unknown/);
  } finally { f.close(); }
});

test('[Linear adapter] the wake caches captures for all three trackers', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const [adapter, url] of [['local', null], ['github', 'https://github.com/owner/repo/raw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/captures/a.png'], ['linear', 'https://uploads.linear.app/a.png']]) {
      const f = await boardFixture(adapter, url);
      globalThis.fetch = async () => new Response(f.png, { status: 200 });
      try {
        await writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir });
        const source = liveSource({ conf: f.conf, dir: f.dir });
        const snap = await source.snapshot();
        assert.equal(snap.tickets[0].captures.before, `/media/${f.digest}`, adapter);
        assert.deepEqual((await source.media(f.digest)).body, f.png, adapter);
      } finally { f.close(); }
    }
  } finally { globalThis.fetch = realFetch; }
});

test('the snapshot file is published only after a full write and rename', async () => {
  const f = await boardFixture();
  try {
    const collector = boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] });
    await writeBoardSnapshot({ collector, dir: f.dir });
    const source = liveSource({ conf: f.conf, dir: f.dir });
    const previous = await source.snapshot();
    writeFileSync(join(f.dir, 'snapshot.json.partial'), '{broken');
    assert.deepEqual((await source.snapshot()).tickets, previous.tickets);
    assert.equal(readdirSync(f.dir).filter((name) => name.startsWith('snapshot.json.')).length, 1);
  } finally { f.close(); }
});

test('ticket text and health names cannot put secrets, amounts or host paths in the snapshot or page', async () => {
  const f = await boardFixture();
  try {
    const secret = 'ghp_' + 'A'.repeat(30);
    const ticket = { id: 'LOCAL-1', identifier: 'LOCAL-1', title: `Saved /home/private/key ${secret} for 12.40 $`, status: 'Needs Approval' };
    f.trackerClient.listTickets = ({ status }) => status === 'Needs Approval' ? [ticket] : [];
    f.trackerClient.getTicket = () => ticket;
    f.trackerClient.comments = () => [{ body: `Agree with /home/private/key and ${secret}? Costs 12.40 $.` }];
    await writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir });
    const disk = readFileSync(join(f.dir, 'snapshot.json'), 'utf8');
    assert.doesNotMatch(disk, /\/home\/private|ghp_|12\.40|\$/);
    const { openLedger } = await import('../lib/ledger.mjs');
    const db = openLedger();
    db.prepare('INSERT INTO heartbeat_incidents VALUES (?,?,?,1)').run(`service_unreachable:/home/private/${secret}`, new Date().toISOString(), new Date().toISOString());
    db.close();
    assert.doesNotMatch(JSON.stringify(await liveSource({ conf: f.conf, dir: f.dir }).snapshot()), /\/home\/private|ghp_|12\.40|\$/);
  } finally { f.close(); }
});


test('renaming a new snapshot pushes an event on the existing stream', async () => {
  const f = await boardFixture();
  try {
    await writeBoardSnapshot({ collector: boardCollector({ conf: f.conf, trackerClient: f.trackerClient, fuelReader: async () => [] }), dir: f.dir });
    const source = liveSource({ conf: f.conf, dir: f.dir });
    const s = await serve({ source, pollMs: 10000, heartbeatMs: 10000 });
    try {
      const reader = (await s.call('/events', { headers: auth })).body.getReader();
      const next = async () => {
        let buffer = '';
        while (!buffer.includes('\n\n')) {
          const result = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('no snapshot event')), 1000))]);
          buffer += new TextDecoder().decode(result.value);
        }
        return buffer;
      };
      assert.match(await next(), /event: snapshot/);
      const path = join(f.dir, 'snapshot.json');
      const changed = JSON.parse(readFileSync(path));
      changed.generatedAt = new Date(Date.now() + 1000).toISOString();
      changed.tickets[0].title = 'Updated from new snapshot';
      writeFileSync(`${path}.tmp`, JSON.stringify(changed));
      renameSync(`${path}.tmp`, path);
      assert.match(await next(), /event: ticket.updated/);
      reader.cancel();
    } finally { await s.close(); }
  } finally { f.close(); }
});
