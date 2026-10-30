// The first start in the app (docs/v2/milestone-5-plan.md, decision 5 and
// section 5, lane v2-j5-assistant): on a ledger with no user, and only when
// app/main.ts turns the gate on, the app answers /setup alone; the setup
// code creates the owner's account once, makes the approval key, names the
// owner in the settings and signs the owner in. After that, /setup is a
// signed-in page, and the model step's terminal opens on the loopback
// address only, as a session's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApprovalSigner } from '../../../src/approval/signer.ts';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import { issueSetupCode } from '../../../src/setup/code.ts';
import { readSettings } from '../../../src/setup/settings.ts';
import type { DataSource } from '../../src/proxy.ts';
import { cookieOf, FAST, openLedger, PASSWORD, signedIn, startApp, type Running } from '../support.ts';

const PUBLIC = 'https://cleared.example.com';

type Started = { app: Running; db: DatabaseSync; dir: string; code: string; forwarded: string[]; done(): Promise<void> };

async function start(options: { readonly gate?: boolean } = {}): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-app-setup-'));
  const db = openLedger();
  for (const table of SETUP_TABLES) db.exec(table);
  const { code } = issueSetupCode(db);
  const forwarded: string[] = [];
  const source: DataSource = {
    kind: 'service',
    forward(_request, response, forward) {
      forwarded.push(`${forward.method} ${forward.path}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    },
  };
  const app = await startApp({ db, source, extra: { publicOrigin: PUBLIC, ...(options.gate === false ? {} : { setup: { db, env: { CLEARED_STATE_DIR: dir }, params: FAST } }) } });
  return { app, db, dir, code, forwarded, done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// A raw request, so that the Host and every header are the test's.
function ask(app: Running, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(app.base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers: { host: url.host, ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text, headers: response.headers }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const owner = (s: Started, body: Record<string, string>, headers: Record<string, string> = {}) =>
  ask(s.app, 'POST', '/setup/owner', { 'content-type': 'application/json', origin: s.app.origin, 'sec-fetch-site': 'same-origin', ...headers }, JSON.stringify(body));

test('with no user, every page sends to /setup, which draws the assistant\'s first step; the files it needs are served', async () => {
  const s = await start();
  try {
    for (const path of ['/', '/inbox', '/login', '/sessions']) {
      const answer = await ask(s.app, 'GET', path);
      assert.equal(answer.status, 303, path);
      assert.equal(answer.headers.location, '/setup', path);
    }
    const page = await ask(s.app, 'GET', '/setup/forge');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-screen="setup"/);
    assert.match(page.text, /data-stage="first"/);
    const script = /<script type="module" src="([^"]+)">/.exec(page.text)?.[1] ?? '';
    assert.equal((await ask(s.app, 'GET', script)).status, 200, 'the page\'s own files are served before the owner exists');
    assert.equal((await ask(s.app, 'GET', '/theme.js')).status, 200);
    assert.equal((await ask(s.app, 'GET', '/api/me')).status, 401);
    assert.equal((await ask(s.app, 'GET', '/setup/nothing')).status, 404);
  } finally { await s.done(); }
});

test('the gate is app/main.ts\'s: without it, an app with no user still sends to /login', async () => {
  const s = await start({ gate: false });
  try {
    assert.equal((await ask(s.app, 'GET', '/')).headers.location, '/login');
    assert.equal((await ask(s.app, 'GET', '/setup')).status, 303);
  } finally { await s.done(); }
});

test('the right code creates the owner, makes the approval key, names the owner in the settings, and signs the owner in', async () => {
  const s = await start();
  try {
    const made = await owner(s, { code: s.code.toLowerCase().replace('-', ' '), name: 'alex', password: PASSWORD });
    assert.equal(made.status, 201, made.text);
    const body = JSON.parse(made.text) as { name: string; publicKey: string; existed: boolean };
    assert.equal(body.name, 'alex');
    assert.equal(body.existed, false);
    const key = join(s.dir, 'approval.key');
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.equal(ApprovalSigner.load(key).publicKey, body.publicKey);
    assert.ok(!made.text.includes('PRIVATE'));
    assert.equal(readSettings(join(s.dir, 'settings.conf')).env.CLEARED_V2_OWNER_ID, 'alex');
    const cookie = cookieOf(new Response(null, { headers: { 'set-cookie': String(made.headers['set-cookie']) } }));
    assert.ok(cookie.startsWith('cleared_v2_session='), cookie);
    assert.equal((await ask(s.app, 'GET', '/', { cookie })).status, 200, 'signed in');
    const page = await ask(s.app, 'GET', '/setup/forge', { cookie });
    assert.match(page.text, /data-stage="signed"/);
    assert.equal((await ask(s.app, 'GET', '/setup')).headers.location, '/login', 'signed out: the sign-in page');
    const again = await owner(s, { code: s.code, name: 'sam', password: PASSWORD });
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(again.text).error, 'owner_exists');
  } finally { await s.done(); }
});

// The owner's step is in the assistant's list: a click on it used to answer "method not allowed".
test('a signed-in owner reads the owner step\'s page, and its form posts as before', async () => {
  const s = await start();
  try {
    const made = await owner(s, { code: s.code, name: 'alex', password: PASSWORD });
    assert.equal(made.status, 201, made.text);
    const cookie = String(made.headers['set-cookie']).split(';')[0] as string;
    const page = await ask(s.app, 'GET', '/setup/owner', { cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/);
    assert.equal((await ask(s.app, 'PUT', '/setup/owner', { cookie })).status, 405);
  } finally {
    await s.stop();
  }
});

test('two posts with the right code at once make one owner', async () => {
  const s = await start();
  try {
    const answers = await Promise.all([owner(s, { code: s.code, name: 'alex', password: PASSWORD }), owner(s, { code: s.code, name: 'sam', password: PASSWORD })]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [201, 409]);
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
  } finally { await s.done(); }
});

test('a wrong code, a name or a password the app refuses, the service account\'s name and a post from elsewhere: refused, nothing made', async () => {
  const s = await start();
  try {
    assert.equal(JSON.parse((await owner(s, { code: 'ZZZZ-ZZZZ', name: 'alex', password: PASSWORD })).text).error, 'code_wrong');
    assert.equal(JSON.parse((await owner(s, { code: s.code, name: 'a b', password: PASSWORD })).text).error, 'name');
    assert.equal(JSON.parse((await owner(s, { code: s.code, name: 'alex', password: 'short' })).text).error, 'phrase', 'a word the guard does not read as a credential');
    assert.equal(JSON.parse((await owner(s, { code: s.code, name: userInfo().username, password: PASSWORD })).text).error, 'service_account');
    assert.equal((await owner(s, { code: s.code, name: 'alex', password: PASSWORD }, { origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await owner(s, { code: s.code, name: 'alex', password: PASSWORD }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);
    assert.throws(() => readFileSync(join(s.dir, 'approval.key')), /ENOENT/, 'no key made for a refused post');
  } finally { await s.done(); }
});

test('wrong codes are throttled as wrong passwords are: the sixth try waits', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await owner(s, { code: 'ZZZZ-ZZZZ', name: 'alex', password: PASSWORD })).status, 403);
    const blocked = await owner(s, { code: s.code, name: 'alex', password: PASSWORD });
    assert.equal(blocked.status, 429, 'even the right code waits');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  } finally { await s.done(); }
});

test('the model step\'s terminal is forwarded on the loopback address only, with the anti-forgery checks', async () => {
  const s = await start();
  try {
    await owner(s, { code: s.code, name: 'alex', password: PASSWORD });
    const me = await signedIn(s.app, 'alex');
    const write = { cookie: me.cookie, 'x-csrf-token': me.csrf, origin: s.app.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    assert.equal((await ask(s.app, 'POST', '/api/service/setup/model/terminal/open', write, '{"cols":80,"rows":24}')).status, 200);
    assert.equal((await ask(s.app, 'GET', '/api/service/setup/model/terminal/stream', { cookie: me.cookie })).status, 200);
    const host = new URL(PUBLIC).host;
    assert.equal((await ask(s.app, 'POST', '/api/service/setup/model/terminal/open', { ...write, host, origin: PUBLIC }, '{}')).status, 403, 'never through the public origin');
    assert.equal((await ask(s.app, 'POST', '/api/service/setup/model/terminal/input', { ...write, origin: PUBLIC }, '{}')).status, 403, 'the public Origin on the loopback Host');
    assert.equal((await ask(s.app, 'POST', '/api/service/setup/forge', { ...write, host, origin: PUBLIC }, '{}')).status, 200, 'the other steps are writes like the others');
    assert.deepEqual(s.forwarded, ['POST /api/setup/model/terminal/open', 'GET /api/setup/model/terminal/stream', 'POST /api/setup/forge']);
  } finally { await s.done(); }
});
