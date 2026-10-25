// The Consumption screen's fixtures (O15): a ledger in memory with a week of
// invented turns for two agents and the quota windows they reported, read by
// the service's own consumption() and its levers, so the screen in the
// fixtures app draws what the service would answer. With `week` (C17, issue
// #396), the same ledger also holds a week of merged tickets, read by the
// service's own weekFigures(): asked for, so the figures other tests pin do
// not move. No name, no path, no figure of a real account.
import { LEVERS_TABLE, LeverError, LeverStore, type LeverReader, type LeversChange } from '../../src/consumption/levers.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { consumption, leverChoices, type Consumption, type LeverChoices } from '../../src/consumption/usage.ts';
import { weekFigures, type WeekFigures } from '../../src/consumption/week.ts';
import { VariantStore } from '../../src/flow/variants.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import type { TestOutcome, TicketType } from '../../src/api/types.ts';
import type { Harness } from '../../src/session/contract.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import { MemoryTicketStore, type Actor } from '../../src/tickets/contract.ts';

const DAY = 24 * 3_600_000;
const CONFIG = { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' };

// Tokens of each of the last seven days, oldest first, in turns of the day.
const WEEK: Readonly<Record<'claude-code' | 'codex', readonly number[]>> = {
  'claude-code': [210_000_000, 12_000_000, 8_500_000, 64_000_000, 470_000_000, 310_000_000, 355_000_000],
  codex: [92_000_000, 3_000_000, 2_500_000, 4_000_000, 128_000_000, 211_000_000, 275_000_000],
};

// The tower fixture's two services, in its workspace's order.
const SERVICES = ['guestbook', 'filter-api'];

export function consumptionFixture(project: string, now: () => Date, options: { readonly week?: boolean } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, [LEVERS_TABLE, ...QUOTA_TABLES]);
  const start = now();
  const at = (daysBack: number, hour: number) => new Date(Date.parse(`${start.toISOString().slice(0, 10)}T00:00:00Z`) - daysBack * DAY + hour * 3_600_000).toISOString();
  let n = 0;
  for (const harness of ['claude-code', 'codex'] as const) {
    const id = `fx-${harness}`;
    store.sessions.put({ id, project, ticket: 'LOCAL-1', role: 'author', harness, model: 'claude-opus-5-5', status: 'running', createdAt: at(7, 9), updatedAt: at(0, 9) });
    WEEK[harness].forEach((tokens, i) => {
      for (const hour of [9, 14]) {
        n += 1;
        store.events.append({
          at: at(6 - i, hour), sessionId: id, ticket: 'LOCAL-1', project,
          event: {
            type: 'RUN_FINISHED', threadId: id, runId: `r${n}`, outcome: { type: 'success' },
            usage: [{ inputTokens: Math.round(tokens / 40), outputTokens: Math.round(tokens / 100), cachedInputTokens: Math.round(tokens * 0.46), cacheWriteInputTokens: Math.round(tokens * 0.02) }],
            result: { stopReason: 'end_turn', total_cost_usd: harness === 'claude-code' ? Math.round(tokens / 1e6 * 4.2) / 100 : null },
          } as never,
        });
      }
    });
  }
  // The windows the agents reported: Claude Code holds, Codex would reach 100 % before its reset.
  const limit = (session: string, window: 'seven_day' | 'five_hour', usedPercent: number, resetsInMs: number) => store.events.append({
    at: new Date(start.getTime() - 20 * 60_000).toISOString(), sessionId: session, ticket: 'LOCAL-1', project,
    event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window, usedPercent, resetsAt: new Date(start.getTime() + resetsInMs).toISOString() } } as never,
  });
  limit('fx-codex', 'seven_day', 62, 3.5 * DAY);
  // Claude Code's from the hourly reading (issue #270), at the same time.
  store.db.prepare("INSERT INTO quota_readings (project, harness, source, at, ok, \"window\", used_percent, resets_at) VALUES (?, 'claude-code', 'claude-code /api/oauth/usage', ?, 1, 'seven_day', 41, ?)")
    .run(project, new Date(start.getTime() - 20 * 60_000).toISOString(), new Date(start.getTime() + 3.5 * DAY).toISOString());
  picks(store.db, project);
  // The week's tickets: none without `week`.
  const ready = options.week ? weekStory(store, project, at) : Promise.resolve(new MemoryTicketStore());
  const levers = new LeverStore(store.db, project);
  return {
    // The ledger and the levers the fixtures' batches read (requirement C6): the same lanes and windows as the screen.
    db: store.db,
    levers: levers as LeverReader,
    // A window of Claude Code's subscription reported now, as a session reports it.
    report(window: 'seven_day' | 'five_hour', usedPercent: number): void {
      store.events.append({
        at: now().toISOString(), sessionId: 'fx-claude-code', ticket: 'LOCAL-1', project,
        event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window, usedPercent, resetsAt: null } } as never,
      });
    },
    read(zone: string | undefined): Consumption {
      return consumption(store.db, { project, now: now(), ...(zone ? { timeZone: zone } : {}), levers: levers.read(), config: CONFIG });
    },
    // The week's figures (C17): the service's own read over the same ledger.
    async week(zone: string | undefined): Promise<WeekFigures> {
      return weekFigures(store.db, await ready, { project, services: SERVICES, now: now(), ...(zone ? { timeZone: zone } : {}) });
    },
    // The service's own validation, its refusal as the status and message the route sends.
    write(change: LeversChange, user: string): { readonly status: 200; readonly body: LeverChoices } | { readonly status: 400; readonly body: { readonly error: string } } {
      try {
        return { status: 200, body: leverChoices(levers.set(change, user, now().toISOString(), CONFIG.reviewerModel), CONFIG) };
      } catch (error) {
        if (error instanceof LeverError) return { status: 400, body: { error: error.message } };
        throw error;
      }
    },
    close: () => store.close(),
  };
}

export type ConsumptionFixture = ReturnType<typeof consumptionFixture>;

// Three harness picks that ended (issue #329), with invented tickets and
// figures: two bugs, Codex kept once and Claude Code once, and a ticket of
// no type where Cursor did not run its tests.
type Ran = { readonly harness: Harness; readonly tests: TestOutcome; readonly tokens: number | null; readonly kept?: boolean };
function picks(db: Parameters<typeof applyTables>[0], project: string): void {
  const variants = new VariantStore(db);
  const run = (ticket: string, kind: TicketType, ran: readonly Ran[]) => {
    const rows = variants.create(ticket, project, { harnesses: ran.map((r) => r.harness), kind });
    rows.forEach((row, i) => {
      const r = ran[i] as Ran;
      variants.update(row.id, { state: r.kept ? 'chosen' : 'dropped', session: `fx-pick-${ticket}-${i + 1}`, files: ['src/entries.ts'], tests: r.tests, tokens: r.tokens, workMs: 20 * 60_000, won: r.kept === true });
    });
  };
  run('LOCAL-130', 'bug', [{ harness: 'claude-code', tests: 'passed', tokens: 31_200 }, { harness: 'codex', tests: 'passed', tokens: 12_400, kept: true }]);
  run('LOCAL-131', 'bug', [{ harness: 'claude-code', tests: 'passed', tokens: 18_900, kept: true }, { harness: 'codex', tests: 'failed', tokens: 9_700 }]);
  run('LOCAL-132', 'other', [{ harness: 'claude-code', tests: 'passed', tokens: 22_000, kept: true }, { harness: 'cursor', tests: 'not_run', tokens: null }]);
}

// A week of merged tickets (C17), with invented titles and figures: two
// planned tickets, one over its estimate and one under, a ticket on both
// services from the chat with no plan, an issue closed on a tracker (not a
// merge), the lead's turns, and the running ticket the agents' turns above
// belong to. Every turn is Claude Code's and reports its dollars; the Codex
// turns above report none, so the week says no dollar figure.
async function weekStory(store: Store, project: string, at: (daysBack: number, hour: number) => string): Promise<MemoryTicketStore> {
  applyTables(store.db, PLAN_TABLES);
  const time = (daysBack: number, h: number, m = 0) => at(daysBack, h + m / 60);
  const flow: Actor = { kind: 'agents', id: 'cleared-v2' };
  const owner: Actor = { kind: 'human', id: 'fixtures' };
  let clock = time(7, 8);
  const tickets = new MemoryTicketStore({ now: () => clock });
  const story = async (title: string, services: readonly string[], end?: { readonly at: string; readonly by: Actor }) => {
    clock = time(7, 8);
    const made = await tickets.create({ title, project, services: [...services] }, owner);
    clock = time(7, 9);
    await tickets.move(made.id, tickets.states.progress, flow);
    if (end) {
      clock = end.at;
      await tickets.move(made.id, tickets.states.done, end.by);
    }
    return made.id;
  };
  await story('Sign the guestbook with a name', ['guestbook']);
  const newest = await story('Show the newest entries first', ['guestbook'], { at: time(1, 11, 30), by: flow });
  const empty = await story('Refuse empty words in the filter', ['filter-api'], { at: time(3, 14), by: { kind: 'agents', id: 'cleared-agents' } });
  const codes = await story('Agree on the filter\'s error codes', ['guestbook', 'filter-api'], { at: time(4, 11), by: flow });
  await story('Closed on the tracker', ['guestbook'], { at: time(2, 9), by: { kind: 'agents', id: 'cleared-mirror' } });

  let run = 0;
  const session = (id: string, ticket: string, role: 'author' | 'reviewer' | 'lead', service: string | null = null) => {
    store.sessions.put({ id, project, ticket, role, harness: 'claude-code', model: 'claude-opus-5-5', status: 'done', createdAt: time(7, 9), updatedAt: time(0, 8), service });
    const put = (iso: string, event: unknown) => store.events.append({ at: iso, sessionId: id, ticket, project, event: event as never });
    return {
      turn: (from: string, to: string, tokens: number, total: number) => {
        const runId = `w${++run}`;
        put(from, { type: 'RUN_STARTED', threadId: id, runId });
        put(to, { type: 'RUN_FINISHED', threadId: id, runId, outcome: { type: 'success' }, usage: [{ inputTokens: tokens }], result: { stopReason: 'end_turn', total_cost_usd: total } });
      },
      step: (iso: string, type: 'STEP_STARTED' | 'STEP_FINISHED', stepName: 'waiting_human' | 'release') => put(iso, { type, stepName }),
    };
  };
  const item = (ticket: string, minutes: number) => {
    store.db.prepare(`INSERT INTO plans (id, project, goal, title, summary, state, max_parallel, totals, proposed_at)
      VALUES (?, ?, 'The guestbook reads well', 'The guestbook reads well', 'Two small changes', 'running', 1, '{}', ?)`).run(`fx-plan-${ticket}`, project, time(7, 8));
    store.db.prepare(`INSERT INTO plan_items (plan_id, position, title, body, lane, size, after, estimate, ticket, state, updated_at)
      VALUES (?, 1, ?, '', 'full', 's', '[]', ?, ?, 'landed', ?)`).run(`fx-plan-${ticket}`, ticket, JSON.stringify({ minutes, costUsd: 0.3, weekPercent: null, samples: 0 }), ticket, time(7, 8));
  };

  // Planned at 30 minutes; 42 taken, less the 12 the owner took to answer.
  item(newest, 30);
  const author = session('fx-week-newest', newest, 'author');
  author.turn(time(1, 10), time(1, 10, 20), 1_200_000, 0.9);
  author.step(time(1, 10, 20), 'STEP_STARTED', 'waiting_human');
  author.step(time(1, 10, 32), 'STEP_FINISHED', 'waiting_human');
  author.turn(time(1, 10, 32), time(1, 10, 50), 800_000, 1.6);
  author.step(time(1, 10, 54), 'STEP_FINISHED', 'release');
  session('fx-week-newest-review', newest, 'reviewer').turn(time(1, 10, 55), time(1, 11, 2), 400_000, 0.3);
  // Planned at 20 minutes; 16 taken.
  item(empty, 20);
  const filter = session('fx-week-empty', empty, 'author');
  filter.turn(time(3, 13), time(3, 13, 16), 900_000, 0.7);
  filter.step(time(3, 13, 16), 'STEP_FINISHED', 'release');
  // From the chat, no plan: a step on each service.
  session('fx-week-codes-api', codes, 'author', 'filter-api').turn(time(4, 9), time(4, 9, 25), 1_500_000, 1.1);
  session('fx-week-codes-gb', codes, 'author', 'guestbook').turn(time(4, 9, 30), time(4, 9, 48), 700_000, 0.5);
  // The lead's turns, on the workspace's own row.
  const lead = session('fx-week-lead', 'lead', 'lead');
  lead.turn(time(2, 16), time(2, 16, 6), 250_000, 0.2);
  lead.turn(time(0, 8), time(0, 8, 4), 300_000, 0.35);
  return tickets;
}
