// C3's steps (P243, docs/v2/milestone-4-plan.md section 10) on the fakes of
// GitHub's REST API and Linear's GraphQL API, on loopback, never a real
// account: a person hands an older issue over, the lead's plans hold its
// ticket in the Inbox, the owner approves, the ticket starts, and the
// tracker follows; no second ticket or issue is made, and an integration's
// label does nothing. The mirror, the plan runner and the flow engine are
// the real ones; the tickets are the flow tests' store.
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../src/lead/plans/runner.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import { applyTables } from '../../src/store/db.ts';
import { delegateTo } from '../../src/tickets/delegation.ts';
import { createMirror } from '../../src/tickets/mirror.ts';
import { quickAuthor, setup, until } from '../flow/support.ts';
import { recordingLead } from '../lead/plans/support.ts';
import { FakeGitHub, type FakeAccount } from './fakes/github.ts';
import { FakeLinear } from './fakes/linear.ts';

const REPO = 'org/guestbook';
const GITHUB_TOKEN = randomBytes(16).toString('hex');
const LINEAR_TOKEN = randomBytes(16).toString('hex');
const BOT: FakeAccount = { login: 'cleared-bot', type: 'User' };
const JANE: FakeAccount = { login: 'jane', type: 'User' };
const ACTIONS: FakeAccount = { login: 'github-actions[bot]', type: 'Bot' };
const LINEAR_BOT = { id: 'user-mirror', name: 'Cleared' };
const LINEAR_JANE = { user: { id: 'user-jane', name: 'Jane' } };

async function world() {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, [...PLAN_TABLES, ...NOTIFY_TABLES]);
  const iso = () => new Date(t.clock.now).toISOString();
  const github = new FakeGitHub({ clock: iso, accounts: { [GITHUB_TOKEN]: BOT }, repos: [REPO] });
  const linear = new FakeLinear({ clock: iso, accounts: { [LINEAR_TOKEN]: LINEAR_BOT } });
  const [githubApi, linearApi] = await Promise.all([github.listen(), linear.listen()]);
  const lead = recordingLead();
  const runner = new PlanRunner({ store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook', config: DEFAULT_PLAN_CONFIG, now: () => new Date(t.clock.now) });
  runner.listen();
  const logs: string[] = [];
  const mirror = createMirror({
    pollMs: 60_000, language: 'en', delegation: { label: 'cleared' },
    github: { api: githubApi, token: GITHUB_TOKEN }, linear: { api: linearApi, token: LINEAR_TOKEN, team: 'ENG' },
  }, {
    db: t.store.db, tickets: t.tickets, project: 'guestbook', services: [{ name: 'guestbook', repo: REPO }],
    flow: () => t.engine, now: () => new Date(t.clock.now), log: (line) => logs.push(line),
    delegate: delegateTo({ plans: () => runner, lead: () => lead, tickets: t.tickets, flow: () => t.engine }),
  });
  assert.ok(mirror);
  const tick = (seconds = 1) => { t.clock.now += seconds * 1000; };
  const settle = async () => {
    for (let i = 0; i < 5; i++) { await t.engine.settled(); await runner.settled(); }
  };
  const close = async () => { await mirror.close(); await Promise.all([github.close(), linear.close()]); };
  return { ...t, github, linear, lead, runner, mirror, logs, tick, settle, close };
}

test('C3 on GitHub: a person labels an older issue cleared; its ticket waits in the Inbox, starts at the owner\'s approval, and the issue follows', async () => {
  const w = await world();
  try {
    const issue = w.github.open(REPO, JANE, { title: 'Sort the entries newest first', body: 'The guestbook lists the oldest first.' });
    w.tick();
    await w.mirror.pass();
    const before = (await w.tickets.list()).length;

    w.tick(60);
    w.github.label(REPO, issue.number, JANE, 'cleared');
    w.tick();
    await w.mirror.pass();
    const tickets = await w.tickets.list();
    assert.equal(tickets.length, before + 1);
    const ticket = tickets.find((t) => t.title === 'Sort the entries newest first');
    assert.ok(ticket);
    assert.equal(ticket.status, 'Todo');
    const plan = w.runner.store.list(['proposed']).find((p) => p.items[0]?.ticket === ticket.id);
    assert.ok(plan, 'a plan bound to the ticket is proposed');
    assert.ok(w.inbox.list().some((item) => item.kind === 'plan' && item.planId === plan.id), 'in the Inbox');
    assert.ok(w.lead.lines.some((line) => line.includes(ticket.id) && line.includes('jane') && line.includes(`${REPO}#${issue.number}`)), 'the lead is told');
    const [comment] = w.github.comments.get(issue.number) ?? [];
    assert.equal(comment?.body, `jane handed this issue over to Cleared: it is ${ticket.id}. Plan ${plan.id} waits for the owner's approval in Cleared, and no work starts before it.`);
    assert.equal(w.startedSessions.length, 0);

    await w.runner.approve(plan.id, 'u1');
    await w.settle();
    await until(() => w.startedSessions.some((s) => s.input.ticket === ticket.id && s.input.role === 'author'), 'the ticket started');
    await until(async () => (await w.tickets.get(ticket.id))?.status !== 'Todo', 'the ticket moved');
    w.tick();
    await w.mirror.pass();
    const labels = w.github.issue(REPO, issue.number).labels.map((l) => l.name);
    const status = (await w.tickets.get(ticket.id))?.status;
    assert.ok(labels.includes(`status:${status}`), `the issue follows the ticket (${labels.join(', ')}; ${status})`);
    assert.deepEqual(w.github.requests.filter((r) => r.method === 'POST' && r.path === `/repos/${REPO}/issues`), [], 'no second issue');
  } finally {
    await w.close();
  }
});

test('C3 on Linear: a person assigns a Backlog issue to the mirror\'s user; it comes in Todo, Linear moves to Todo, its plan waits; an integration\'s label does nothing', async () => {
  const w = await world();
  try {
    const issue = w.linear.create(LINEAR_JANE, { title: 'Trim the names', description: 'Names keep their spaces.', state: 'Backlog' });
    const ruled = w.linear.create(LINEAR_JANE, { title: 'Labelled by a rule', state: 'Todo' });
    w.tick();
    await w.mirror.pass();
    w.tick(60);
    w.linear.assign(issue.id, LINEAR_JANE, LINEAR_BOT.id);
    w.linear.label(ruled.id, { bot: { id: 'bot-zap', name: 'Zapier' } }, 'cleared');
    w.tick();
    await w.mirror.pass();
    const ticket = (await w.tickets.list()).find((t) => t.title === 'Trim the names');
    assert.ok(ticket);
    assert.equal(ticket.status, 'Todo');
    assert.equal(w.linear.stateOf(issue.id), 'Todo');
    assert.ok(w.runner.store.list(['proposed']).some((p) => p.items[0]?.ticket === ticket.id));
    assert.match(w.linear.issues.get(issue.id)?.comments[0]?.body ?? '', new RegExp(`^Jane handed this issue over to Cleared: it is ${ticket.id}\\.`));
    assert.equal((await w.tickets.list()).some((t) => t.title === 'Labelled by a rule'), false, 'an integration\'s label is not a delegation');
    assert.deepEqual(w.linear.issues.get(ruled.id)?.comments, []);
    assert.deepEqual(w.logs, []);
  } finally {
    await w.close();
  }
});

test('C3: a bot\'s label on GitHub does nothing either', async () => {
  const w = await world();
  try {
    const issue = w.github.open(REPO, JANE, { title: 'Triaged by a workflow' });
    w.tick();
    await w.mirror.pass();
    w.tick(60);
    w.github.label(REPO, issue.number, ACTIONS, 'cleared');
    w.tick();
    await w.mirror.pass();
    assert.equal((await w.tickets.list()).some((t) => t.title === 'Triaged by a workflow'), false);
    assert.deepEqual(w.github.comments.get(issue.number) ?? [], []);
  } finally {
    await w.close();
  }
});
