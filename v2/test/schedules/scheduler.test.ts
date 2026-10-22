// The scheduler (docs/v2/milestone-2-plan.md, decision 29): each minute it
// starts the schedules that are due through the plan runner, with the
// creator's approval given at creation as the plan's; the ticket's budget
// is the schedule's; a release still waits for the owner; the week stop
// and the schedule's own cap skip a run, said once as schedule_failed.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../src/lead/plans/runner.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import { parseRecipe, type RecipeFile } from '../../src/recipes/recipe.ts';
import { Recipes } from '../../src/recipes/service.ts';
import { budgetedFlow } from '../../src/schedules/budget.ts';
import { Scheduler, type ScheduleEvent } from '../../src/schedules/scheduler.ts';
import { SCHEDULE_TABLES } from '../../src/schedules/store.ts';
import { ScheduleError } from '../../src/schedules/when.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { applyTables } from '../../src/store/db.ts';
import { finished, setup, started, text, until } from '../flow/support.ts';
import { recordingLead } from '../lead/plans/support.ts';

const BUMP = `---
name: bump-dependency
kind: ticket
lane: full
size: s
parameters: [package]
---
Bump {{package}}.

- [ ] npm test passes
`;
const TIDY = `---
name: tidy-docs
kind: goal
---
Make the README clear.
`;

const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

async function scheduler(options: { readonly author?: readonly FakeStep[]; readonly files?: Record<string, string> } = {}) {
  const t = await setup({ scripts: { author: options.author ?? [started, ...text('a1', 'Done.'), finished(0.3)] } });
  applyTables(t.store.db, [...PLAN_TABLES, ...NOTIFY_TABLES, ...SCHEDULE_TABLES]);
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  let recipes: RecipeFile[] = Object.entries(options.files ?? { 'bump-dependency': BUMP, 'tidy-docs': TIDY })
    .map(([name, body]) => parseRecipe(body, { file: `.cleared/recipes/${name}.md`, service: 'guestbook', services: ['guestbook'] }));
  const posts: { text: string; user: string; goal: boolean }[] = [];
  const lead = Object.assign(recordingLead(), {
    async post(text: string, user: string, goal = false) { posts.push({ text, user, goal }); return { seq: 41 + posts.length }; },
  });
  const now = () => new Date(t.clock.now);
  let schedules: Scheduler | undefined;
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, lead, project: 'guestbook', config: DEFAULT_PLAN_CONFIG, now,
    flow: budgetedFlow(t.engine, (plan) => schedules?.budgetOf(plan)),
  });
  plans.listen();
  const service = new Recipes({
    source: { list: async () => ({ recipes, problems: [] }), refresh: async () => undefined },
    plans, lead, inbox: t.inbox, workspace: [], clean: (s) => s, now,
  });
  const events: ScheduleEvent[] = [];
  schedules = new Scheduler({ db: t.store.db, project: 'guestbook', recipes: service, plans, lead, weekStopPercent: 85, now });
  schedules.subscribe((event) => { events.push(event); });
  const settle = async () => {
    for (let i = 0; i < 4; i++) { await t.engine.settled(); await plans.settled(); }
  };
  const at = async (ms: number) => {
    t.clock.now = ms;
    const result = await schedules!.tick();
    await settle();
    return result;
  };
  const week = (usedPercent: number) => t.store.events.append({ at: iso(t.clock.now), sessionId: 'author-old', ticket: 'LOCAL-1', project: 'guestbook',
    event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent, resetsAt: null } } });
  const queue = () => (t.store.db.prepare("SELECT kind, facts FROM v2_notify_queue WHERE key != 'cursor' ORDER BY key").all() as { kind: string; facts: string }[])
    .map((row) => `${row.kind}:${(JSON.parse(row.facts) as { code: string | null }).code}`);
  return { ...t, lead, posts, plans, recipes: service, schedules, events, settle, at, week, queue, setRecipes: (next: RecipeFile[]) => { recipes = next; } };
}

// The setup's clock starts on 2026-10-21 at 10:00 UTC.
const OCT_22_0300 = Date.parse('2026-10-22T03:00:00.000Z');

test('a schedule every day at 03:00 runs at the first tick past 03:00, once, by its creator\'s approval, with its budget on the ticket', async () => {
  const t = await scheduler();
  const created = await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 60 }, 'u2');
  assert.equal(created.nextRunAt, iso(OCT_22_0300));
  assert.equal(created.createdBy, 'u2');
  assert.equal(created.enabled, true);

  await t.at(OCT_22_0300 - MINUTE);
  assert.equal(t.plans.list().length, 0, 'not before 03:00');
  await t.at(OCT_22_0300 + 30_000);
  assert.equal(t.plans.list().length, 1);
  const plan = t.plans.list()[0]!;
  assert.equal(plan.state, 'approved');
  assert.equal(plan.approvedBy, 'u2', 'the schedule\'s creator is the plan\'s approver');
  await until(() => t.startedSessions.length >= 1, 'the ticket started');
  const start = t.flowEvents.find((e) => e.type === 'ticket_started');
  assert.equal(start?.type === 'ticket_started' ? start.origin?.budgetUsd : undefined, 2, 'the budget travels on the origin');
  await t.at(OCT_22_0300 + 90_000);
  await t.at(OCT_22_0300 + 30 * MINUTE);
  assert.equal(t.plans.list().length, 1, 'not twice');
  const after = t.schedules.list()[0]!;
  assert.equal(after.lastRunAt, iso(OCT_22_0300 + 30_000));
  assert.equal(after.nextRunAt, iso(OCT_22_0300 + 24 * 60 * MINUTE));
  assert.deepEqual(t.events.map((e) => e.type), ['schedule_ran']);
  // The lead is told once, by one line that names the schedule.
  assert.equal(t.lead.lines.length, 1);
  assert.match(t.lead.lines[0]!, new RegExp(created.id));
  // A run that went well is not a notification: its release waits in the inbox as any other.
  assert.deepEqual(t.queue(), []);
});

test('the schedule\'s budget stops the ticket it started, though the service sets none', async () => {
  const t = await scheduler({ author: [started, ...text('a1', 'Expensive.'), finished(2.5)] });
  assert.equal(t.deps.config.budgetUsd, undefined);
  await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  await t.at(OCT_22_0300 + 30_000);
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket was put back');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(back?.type === 'ticket_put_back' ? back.reason : undefined, 'budget');
  const ticket = t.plans.list()[0]!.items[0]!.ticket!;
  assert.match((await t.tickets.comments(ticket)).at(-1)?.body ?? '', /budget of \$2/);
  await t.settle();
});

test('at the week stop the run is skipped, said once as schedule_failed and notified, and the next run is tomorrow', async () => {
  const t = await scheduler();
  await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 100 }, 'u1');
  t.week(86);
  await t.at(OCT_22_0300 + 30_000);
  await t.at(OCT_22_0300 + 90_000);
  assert.equal(t.plans.list().length, 0);
  assert.deepEqual(t.events.map((e) => `${e.type}:${e.type === 'schedule_failed' ? e.reason : ''}`), ['schedule_failed:week']);
  assert.deepEqual(t.queue(), ['health:week_stop']);
  assert.equal(t.schedules.list()[0]?.nextRunAt, iso(OCT_22_0300 + 24 * 60 * MINUTE));
  assert.equal(t.lead.events.length, 1, 'the lead hears of the skipped run once');
  assert.equal(t.lead.lines.length, 0);
});

test('the schedule\'s own cap skips a run below the week stop; under it, the run starts', async () => {
  const t = await scheduler();
  await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 50 }, 'u1');
  t.week(60);
  await t.at(OCT_22_0300 + 30_000);
  assert.equal(t.plans.list().length, 0);
  assert.match(t.events[0]?.type === 'schedule_failed' ? t.events[0].note : '', /50 %/);
  t.week(40);
  await t.at(OCT_22_0300 + 24 * 60 * MINUTE + 30_000);
  assert.equal(t.plans.list().length, 1);
  await t.settle();
});

test('a disabled schedule never runs', async () => {
  const t = await scheduler();
  const created = await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'hour :00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  t.schedules.store.setEnabled(created.id, false);
  for (let h = 1; h <= 48; h++) await t.at(Date.parse('2026-10-21T10:00:00.000Z') + h * 60 * MINUTE + 30_000);
  assert.equal(t.plans.list().length, 0);
  assert.deepEqual(t.events, []);
});

test('a schedule at a time runs once, then is disabled; after a stop of the service, a daily one catches up once', async () => {
  const t = await scheduler();
  const once = await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, at: '2026-10-21T22:00', budgetUsd: 1, weekCapPercent: 85 }, 'u1');
  const daily = await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'axios' }, every: 'day 03:00', budgetUsd: 1, weekCapPercent: 85 }, 'u1');
  // The service was down from the evening of the 21st to the 25th at 10:00.
  await t.at(Date.parse('2026-10-25T10:00:00.000Z'));
  await t.at(Date.parse('2026-10-25T10:01:00.000Z'));
  assert.equal(t.plans.list().length, 2, 'each runs once, not once per missed day');
  const [a, b] = [t.schedules.get(once.id)!, t.schedules.get(daily.id)!];
  assert.equal(a.enabled, false);
  assert.equal(a.nextRunAt, null);
  assert.equal(b.enabled, true);
  assert.equal(b.nextRunAt, '2026-10-26T03:00:00.000Z');
});

test('a goal schedule sends the goal to the lead as its creator, and approves the plan the lead proposes for it, with the budget', async () => {
  const t = await scheduler();
  const created = await t.schedules.create({ goal: 'Make the README clear.', every: 'day 03:00', budgetUsd: 3, weekCapPercent: 85 }, 'u2');
  assert.equal(created.goal, 'Make the README clear.');
  await t.at(OCT_22_0300 + 30_000);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0]?.user, 'u2');
  assert.equal(t.posts[0]?.goal, true);
  assert.match(t.posts[0]!.text, new RegExp(`schedule ${created.id}`));
  assert.match(t.posts[0]!.text, /Make the README clear\./);
  // The lead answers the goal (goal-42) with a plan.
  const proposed = await t.plans.propose({ goal: 'goal-42', title: 'A clear README', summary: 'One change.', items: [{ title: 'Clear README', body: 'Rewrite it.\n\n- [ ] it reads well', lane: 'full', size: 's', after: [] }] });
  // Another plan of another goal is left to the owner.
  const other = await t.plans.propose({ goal: 'goal-7', title: 'Other', summary: 'Other.', items: [{ title: 'Other', body: 'Other.\n\n- [ ] x', lane: 'full', size: 's', after: [] }] });
  await t.at(OCT_22_0300 + 90_000);
  assert.equal(t.plans.get(proposed.plan)?.state, 'approved');
  assert.equal(t.plans.get(proposed.plan)?.approvedBy, 'u2');
  assert.equal(t.plans.get(other.plan)?.state, 'proposed');
  assert.equal(t.schedules.budgetOf(proposed.plan), 3);
  assert.equal(t.schedules.budgetOf(other.plan), undefined);
  await t.at(OCT_22_0300 + 150_000);
  assert.equal(t.lead.lines.length, 1, 'the approval is told once');
  await t.settle();
});

test('a recipe gone from the base branch fails the run, which is notified', async () => {
  const t = await scheduler();
  await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  t.setRecipes([]);
  await t.at(OCT_22_0300 + 30_000);
  assert.deepEqual(t.events.map((e) => `${e.type}:${e.type === 'schedule_failed' ? e.reason : ''}`), ['schedule_failed:recipe']);
  assert.deepEqual(t.queue(), ['health:schedule_failed']);
});

test('a schedule is refused when it names both or neither of a recipe and a goal, a recipe missing a parameter, no time, or a budget or cap out of range', async () => {
  const t = await scheduler();
  const base = { budgetUsd: 2, weekCapPercent: 85, every: 'day 03:00' };
  const refused = async (body: object, pattern: RegExp) => assert.rejects(t.schedules.create(body as never, 'u1'),
    (error: unknown) => error instanceof ScheduleError && pattern.test(error.message));
  await refused({ ...base, recipe: 'bump-dependency', goal: 'x', parameters: { package: 'pg' } }, /recipe or a goal/);
  await refused({ ...base }, /recipe or a goal/);
  await refused({ ...base, recipe: 'bump-dependency' }, /package/);
  await refused({ ...base, recipe: 'nothing' }, /nothing/);
  await refused({ budgetUsd: 2, weekCapPercent: 85, recipe: 'tidy-docs' }, /at or every/);
  await refused({ ...base, at: '2026-10-22T03:00', recipe: 'tidy-docs' }, /at or every/);
  await refused({ ...base, recipe: 'tidy-docs', budgetUsd: 0 }, /budget/);
  await refused({ ...base, recipe: 'tidy-docs', budgetUsd: 1001 }, /budget/);
  await refused({ ...base, recipe: 'tidy-docs', weekCapPercent: 0 }, /cap/);
  await refused({ ...base, recipe: 'tidy-docs', weekCapPercent: 101 }, /cap/);
  await refused({ ...base, goal: ' ' }, /goal/);
  assert.deepEqual(t.schedules.list(), []);
});

test('a schedule is removed; an unknown one is not found', async () => {
  const t = await scheduler();
  const created = await t.schedules.create({ recipe: 'tidy-docs', every: 'day 03:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  assert.equal(t.schedules.remove(created.id), true);
  assert.equal(t.schedules.remove(created.id), false);
  await t.at(OCT_22_0300 + 30_000);
  assert.deepEqual(t.posts, []);
});

test('a failure that repeats is told once, until a run goes well; an hourly schedule does not wake the owner every hour', async () => {
  const t = await scheduler();
  await t.schedules.create({ recipe: 'bump-dependency', parameters: { package: 'pg' }, every: 'hour :00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  t.setRecipes([]);
  for (let h = 1; h <= 3; h++) await t.at(Date.parse('2026-10-21T10:00:30.000Z') + h * 60 * MINUTE);
  assert.equal(t.events.filter((e) => e.type === 'schedule_failed').length, 3, 'each run is still said and kept');
  assert.deepEqual(t.queue(), ['health:schedule_failed'], 'one notification');
  assert.equal(t.lead.events.length, 1, 'one event for the lead');
  // A run that goes well, then a failure again: told again.
  t.setRecipes([parseRecipe(BUMP, { file: '.cleared/recipes/bump-dependency.md', service: 'guestbook', services: ['guestbook'] })]);
  await t.at(Date.parse('2026-10-21T14:00:30.000Z'));
  t.setRecipes([]);
  await t.at(Date.parse('2026-10-21T15:00:30.000Z'));
  assert.equal(t.queue().length, 2);
  assert.equal(t.lead.events.length, 2);
  await t.settle();
});

test('a removed schedule\'s id is never given again, so its runs stay its own', async () => {
  const t = await scheduler();
  const first = await t.schedules.create({ recipe: 'tidy-docs', every: 'day 03:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  const second = await t.schedules.create({ recipe: 'tidy-docs', every: 'day 04:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  await t.at(OCT_22_0300 + 30_000);
  t.schedules.remove(first.id);
  t.schedules.remove(second.id);
  const third = await t.schedules.create({ recipe: 'tidy-docs', every: 'day 05:00', budgetUsd: 2, weekCapPercent: 85 }, 'u1');
  assert.deepEqual([first.id, second.id, third.id], ['sch-1', 'sch-2', 'sch-3']);
});

test('a scheduled goal tells the lead the owner is away: it asks nothing and writes its assumptions in the plan', async () => {
  const t = await scheduler();
  await t.schedules.create({ goal: 'Make the README clear.', every: 'day 03:00', budgetUsd: 3, weekCapPercent: 85 }, 'u2');
  await t.at(OCT_22_0300 + 30_000);
  assert.match(t.posts[0]!.text, /away/);
  assert.match(t.posts[0]!.text, /ask (?:the owner )?nothing/i);
  assert.match(t.posts[0]!.text, /assumptions/);
});
