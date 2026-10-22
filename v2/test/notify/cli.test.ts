// npm run notify (src/cli/notify.ts) and the child process the dispatcher
// starts through it. lib/notify runs there, never in the service: importing
// it copies every CLEARED_* variable of the process to ORCH_*. The adapter
// is ntfy, posting to a server this test runs on 127.0.0.1 (a port the
// system picks), so nothing leaves the machine; Web Push is checked as far
// as its push service, which a test cannot be.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationsFrom } from '../../app/src/notifications.ts';
import { childSender, Dispatcher } from '../../src/notify/dispatcher.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

const CLI = fileURLToPath(new URL('../../src/cli/notify.ts', import.meta.url));
const LINK = 'https://cleared.example.test:8443';

let root: string;
let server: Server;
let posts: Record<string, unknown>[] = [];
let status = 200;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'cleared-notify-'));
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      posts.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const port = () => (server.address() as { port: number }).port;

// A project whose [notify] names the adapters, with its private directory.
function project(name: string, notify: Record<string, string>, owner = 'en'): NodeJS.ProcessEnv {
  const dir = join(root, name);
  const secrets = join(dir, 'secrets');
  mkdirSync(join(dir, 'repo', '.cleared'), { recursive: true });
  mkdirSync(secrets, { mode: 0o700 });
  chmodSync(secrets, 0o700);
  writeFileSync(join(secrets, 'credentials.json'), JSON.stringify({ ntfy: { server: `http://127.0.0.1:${port()}`, topic: 'cleared-test-topic' } }), { mode: 0o600 });
  const lines = Object.entries({ secrets_dir: secrets, ...notify }).map(([k, v]) => `${k} = ${v}`);
  writeFileSync(join(dir, 'repo', '.cleared', 'agents.conf'), `[owner]\nlanguage = ${owner}\n\n[notify]\n${lines.join('\n')}\n`);
  return {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'),
    CLEARED_REPO: join(dir, 'repo'), CLEARED_STATE_DIR: join(dir, 'state'), CLEARED_NOTIFY_LINK_BASE: LINK,
  };
}

// Not spawnSync: the ntfy server runs in this process and must answer.
function run(env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('settings: what the dispatcher needs of [notify], from the same agents.conf as the app', async () => {
  const env = project('settings', { adapters: 'ntfy', quiet_hours: '22:00-07:00', timezone: 'Europe/Paris', coalesce_minutes: '5', events: 'approval, permission, plan' });
  const out = await run(env, ['settings']);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    events: ['approval', 'permission', 'plan'], quiet: { start: 22 * 60, end: 7 * 60 }, timezone: 'Europe/Paris', coalesceMinutes: 5, deadlineMs: 30_000,
    urgent: ['rollback', 'health'], urgency: ['rollback', 'health', 'approval', 'plan', 'question', 'permission', 'blocked'],
  });
  // A setting that is wrong is said, without a path, and the dispatcher keeps what waits.
  const bad = await run(project('bad', { quiet_hours: 'late' }), ['settings']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /quiet_hours must read like 22:00-07:00/);
});

test('send: each message rendered from its kind, ticket and filtered title, with the link of its kind', async () => {
  posts = [];
  const env = project('send', { adapters: 'ntfy' });
  const messages = [
    { key: 'permission:s1:r1', kind: 'permission', ticket: 'LOCAL-3', group: 'LOCAL-3', title: 'Read /srv/cleared/state/claude.token and tok_live_AbCdEfGhIjKlMnOpQrStUv', code: null, link: '/inbox#permission%3As1%3Ar1', from: null },
    { key: 'question:lead:q1', kind: 'question', ticket: null, group: 'lead', title: '', code: null, link: '/lead', from: 'lead' },
    { key: 'health:9', kind: 'health', ticket: null, group: 'health:week_stop', title: '', code: 'week_stop', link: '/', from: null },
  ];
  const out = await run(env, ['send'], JSON.stringify({ messages }));
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { results: Object.fromEntries(messages.map((m) => [m.key, [{ adapter: 'ntfy', result: 'sent' }]])) });
  assert.deepEqual(posts.map((p) => [p.title, p.message, p.click]), [
    ['A team asks for your permission', 'LOCAL-3 · Read [path] and [secret]: open it to allow or deny.', `${LINK}/inbox#permission%3As1%3Ar1`],
    ['The lead asks you a question', 'Open the lead to answer.', `${LINK}/lead`],
    ['Health problem', 'Cleared: the usage limit is reached, no new ticket starts.', `${LINK}/`],
  ]);
  assert.doesNotMatch(JSON.stringify(posts), /tok_live|claude\.token|\/srv\//);
});

test('send refuses what the service would never ask: an unknown kind, a link elsewhere, a group of any text', async () => {
  posts = [];
  const env = project('refuse', { adapters: 'ntfy' });
  for (const message of [
    { key: 'a', kind: 'blocked', ticket: 'LOCAL-1', group: 'LOCAL-1', title: '', code: null, link: '/', from: null },
    { key: 'b', kind: 'approval', ticket: 'LOCAL-1', group: 'LOCAL-1', title: '', code: null, link: '//evil.example/x', from: null },
    { key: 'c', kind: 'approval', ticket: 'LOCAL-1', group: 'LOCAL-1', title: '', code: null, link: 'https://evil.example/', from: null },
    { key: 'd', kind: 'approval', ticket: 'LOCAL-1', group: 'a b', title: '', code: null, link: '/inbox', from: null },
  ]) {
    const out = await run(env, ['send'], JSON.stringify({ messages: [message] }));
    assert.equal(out.code, 64, JSON.stringify(message));
  }
  assert.equal((await run(env, ['send'], 'not json')).code, 64);
  assert.equal((await run(env, ['dispatch'])).code, 64);
  assert.equal(posts.length, 0);
});

test('send says per adapter: refused with its short code, not ready, and nothing at all when no adapter is ready', async () => {
  posts = [];
  status = 403;
  const env = project('codes', { adapters: 'ntfy, webpush', vapid_subject: 'https://cleared.example.test' });
  const message = { key: 'k', kind: 'approval', ticket: 'LOCAL-1', group: 'LOCAL-1', title: 'x', code: null, link: '/inbox', from: null };
  const out = await run(env, ['send'], JSON.stringify({ messages: [message] }));
  status = 200;
  assert.equal(out.code, 0, out.stderr);
  // Web Push has no subscription: it is not ready, so only ntfy was tried.
  assert.deepEqual(JSON.parse(out.stdout), { results: { k: [{ adapter: 'ntfy', result: 'failed', reason: 'ntfy refused (403)' }] } });
  const none = await run(project('none', { adapters: 'webpush', vapid_subject: 'https://cleared.example.test' }), ['send'], JSON.stringify({ messages: [message] }));
  assert.deepEqual(JSON.parse(none.stdout), { results: { k: [] } });
});

test('npm run notify -- test: the fixed message to each adapter, per adapter a line, and a notification_sent event', async () => {
  posts = [];
  const env = project('check', { adapters: 'ntfy, webpush' }, 'fr');
  const out = await run(env, ['test']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, 'ntfy: sent\nwebpush: not ready (no_subscription)\n');
  assert.deepEqual(posts.map((p) => [p.title, p.click]), [['Notifications activées', `${LINK}/`]]);
  const store = openStore(join(env.CLEARED_STATE_DIR as string, 'ledger.db'));
  try {
    const rows = store.db.prepare("SELECT kind, ticket, detail, source FROM events WHERE kind = 'notification_sent'").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: 'notification_sent', ticket: null, detail: '{"event":"test","adapter":"ntfy"}', source: 'notify' }]);
  } finally { store.close(); }
  status = 500;
  const failed = await run(env, ['test']);
  status = 200;
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, 'ntfy: failed (ntfy refused (500))\nwebpush: not ready (no_subscription)\n');
});

test('the dispatcher reads the subscriptions the app wrote: one store, one key pair', async () => {
  const env = { ...project('shared', { adapters: 'webpush', vapid_subject: 'https://cleared.example.test' }), CLEARED_NOTIFY_PUSH_HOSTS: 'push.example.invalid' };
  const app = notificationsFrom(env);
  const status = await app.status('http://127.0.0.1:8792');
  assert.equal(status.available, true);
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
  await app.subscribe('http://127.0.0.1:8792', { subscription: { endpoint: 'https://push.example.invalid/send/abc', keys: { p256dh, auth: Buffer.alloc(16, 1).toString('base64url') } } }, 'alex · Linux');
  // The app's subscription is the one the dispatcher tries: not "no_subscription".
  const out = await run(env, ['test']);
  assert.equal(out.code, 1);
  assert.equal(out.stdout, 'webpush: failed (push service refused)\n');
});

test('a permission waiting reaches the adapter through the child process, and its send is in the ledger', async () => {
  posts = [];
  const env = project('child', { adapters: 'ntfy' });
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...RUNS_TABLES, ...NOTIFY_TABLES]);
  const inbox = new InboxStore(store.db);
  const dispatcher = new Dispatcher({ db: store.db, inbox, sender: childSender(env) });
  await dispatcher.tick();
  const item = inbox.addPermission({ ticket: 'LOCAL-5', project: 'guestbook', sessionId: 's5', requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'npm install left-pad' },
    suggestion: { decision: 'ask', rule: 'install.package', reason: 'installs a package' } });
  const result = await dispatcher.tick();
  assert.equal(result.sent.length, 1);
  assert.deepEqual(posts.map((p) => [p.title, p.message, p.click]), [['A team asks for your permission', 'LOCAL-5: open it to allow or deny.', `${LINK}/inbox#${encodeURIComponent(item.id)}`]]);
  const rows = store.db.prepare("SELECT ticket, detail FROM events WHERE kind = 'notification_sent'").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ ticket: 'LOCAL-5', detail: '{"event":"permission","adapter":"ntfy"}' }]);
  store.close();
});
