// The live Take over run's rules (scripts/proof-takeover-live.ts, issue
// #463): when the quota stops it, what the service's environment holds, and
// what the report may say. The run itself is real (a login, Docker, a little
// quota) and is not run here: importing the script starts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_ANSWER, LIVE_TICKETS, STOP_SPENT, STOP_WINDOW, liveEnv, quotaVerdict, redact } from '../../scripts/proof-takeover-live.ts';

test('the run stops at 5 points of the week spent, or at 90 % of the week, and goes on with no figure', () => {
  assert.equal(STOP_SPENT, 5);
  assert.equal(STOP_WINDOW, 90);
  assert.deepEqual(quotaVerdict(undefined, undefined), { stop: false });
  assert.deepEqual(quotaVerdict(40, 44.9), { stop: false });
  assert.equal(quotaVerdict(40, 45).stop, true);
  assert.match((quotaVerdict(40, 45.2) as { reason: string }).reason, /spent 5\.2 points/);
  assert.equal(quotaVerdict(88, 90).stop, true, 'the window at 90 % stops it whatever was spent');
  assert.match((quotaVerdict(89.5, 90) as { reason: string }).reason, /at 90 %/);
  assert.deepEqual(quotaVerdict(undefined, 50), { stop: false }, 'the first figure is the baseline');
});

test('the service runs the real adapter, calls no model on its own, and names the login by its path only', () => {
  const env = liveEnv({
    base: { PATH: '/usr/bin', HOME: '/run/home' }, state: '/run/state', work: '/run/work', project: '/run/project', origin: '/run/origin.git',
    machine: '/run/agents.conf', servicePort: 9701, appPort: 9702, login: '/secret/login.json', model: 'claude-haiku-5-5', budgetUsd: 1.5,
  });
  assert.equal(env.CLEARED_V2_ADAPTER, undefined, 'no fake adapter');
  assert.equal(env.CLEARED_CLAUDE_CREDENTIALS, '/secret/login.json');
  assert.ok(!Object.values(env).some((value) => /sk-ant/.test(value)), 'no token in the environment');
  assert.equal(env.CLEARED_V2_QUOTA_MINUTES, '0', 'the quota is not read on the host');
  assert.equal(env.CLEARED_V2_LEAD_ENABLED, 'off');
  assert.equal(env.CLEARED_V2_MAP_MINUTES, '0');
  assert.equal(env.CLEARED_V2_AUTHOR_MODEL, 'claude-haiku-5-5');
  assert.equal(env.CLEARED_V2_REVIEWER_MODEL, 'claude-haiku-5-5');
  assert.equal(env.CLEARED_V2_BUDGET_USD, '1.5');
  assert.equal(env.CLEARED_V2_HOST, '127.0.0.1');
  assert.equal(env.CLEARED_V2_PORT, '9701');
  assert.equal(env.CLEARED_V2_REPO_URL, '/run/origin.git', 'the remote is the bare copy, no fork');
});

test('the report says no home folder, no run folder, no login path, no token and no cookie', () => {
  const text = [
    'clone /home/someone/.local/x', 'run /tmp/cleared-live-takeover-ab12/state/ledger.db', 'login /secret/login.json',
    'token sk-ant-oat01-AAAAbbbbCCCCdddd', 'cookie: cleared_session=abc123', '"x-csrf-token": "f00d"', 'Authorization: Bearer xyz',
  ].join('\n');
  const out = redact(text, { root: '/tmp/cleared-live-takeover-ab12', home: '/home/someone', login: '/secret/login.json' });
  assert.doesNotMatch(out, /someone|cleared-live-takeover-ab12|\/secret|sk-ant-oat01|abc123|f00d|xyz/);
  assert.match(out, /clone ~\/\.local\/x/);
  assert.match(out, /run <run>\/state\/ledger\.db/);
  assert.match(out, /login <login>/);
  assert.match(out, /token <token>/);
  assert.match(redact('/home/other/a', {}), /^~\/a$/, 'any home folder');
});

test('the harness line\'s answer is the number alone, and the two tickets each change the guestbook\'s page', () => {
  assert.ok(HARNESS_ANSWER.test('⏺ 42'));
  assert.ok(!HARNESS_ANSWER.test('420'));
  assert.equal(LIVE_TICKETS.length, 2);
  for (const ticket of LIVE_TICKETS) assert.match(ticket.body, /src\/page\.ts/);
});
