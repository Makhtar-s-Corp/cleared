// The Consumption screen's fixtures (O15): a ledger in memory with a week of
// invented turns for two agents and the quota windows they reported, read by
// the service's own consumption() and its levers, so the screen in the
// fixtures app draws what the service would answer. No name, no path, no
// figure of a real account.
import { LEVERS_TABLE, LeverError, LeverStore, type LeversChange } from '../../src/consumption/levers.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { consumption, leverChoices, type Consumption, type LeverChoices } from '../../src/consumption/usage.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

const DAY = 24 * 3_600_000;
const CONFIG = { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' };

// Tokens of each of the last seven days, oldest first, in turns of the day.
const WEEK: Readonly<Record<'claude-code' | 'codex', readonly number[]>> = {
  'claude-code': [210_000_000, 12_000_000, 8_500_000, 64_000_000, 470_000_000, 310_000_000, 355_000_000],
  codex: [92_000_000, 3_000_000, 2_500_000, 4_000_000, 128_000_000, 211_000_000, 275_000_000],
};

export function consumptionFixture(project: string, now: () => Date) {
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
  const levers = new LeverStore(store.db, project);
  return {
    read(zone: string | undefined): Consumption {
      return consumption(store.db, { project, now: now(), ...(zone ? { timeZone: zone } : {}), levers: levers.read(), config: CONFIG });
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
