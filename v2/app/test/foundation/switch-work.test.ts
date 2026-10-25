// What a switch between screens computes beyond the next screen's markup
// (lane j3-tab-perf, P223): the numbers and durations every screen says go
// through Intl's formatters, which are slow to build, so each is built once
// for its language and options (a screen's catalog, made once for its
// language, is web/test/switch-work.test.tsx's, since the catalogs come
// through Vite); and the Lead's stream, which says the lead's state
// and plans again each time the screen opens it, asks the shell to recount
// the inbox only for a question or a plan the screen did not hold yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeadState, Plan } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ago, count, decimal, duration, fixed, lasted, quantity, since } from '../../web/lib/time.ts';

const en = translator(loadCatalog('shell', 'en'));
const fr = translator(loadCatalog('shell', 'fr'));
const NOW = new Date(2026, 9, 25, 9, 30);

// Counts the formatters Intl builds while `run` runs.
function built(run: () => void): { numbers: number; relative: number } {
  const made = { numbers: 0, relative: 0 };
  const { NumberFormat, RelativeTimeFormat } = Intl;
  const counted = <T extends object>(real: T, key: keyof typeof made): T => new Proxy(real, {
    construct(target, args) { made[key] += 1; return Reflect.construct(target as never, args); },
    apply(target, self, args) { made[key] += 1; return Reflect.apply(target as never, self, args); },
  });
  Intl.NumberFormat = counted(NumberFormat, 'numbers');
  Intl.RelativeTimeFormat = counted(RelativeTimeFormat, 'relative');
  try { run(); }
  finally {
    Intl.NumberFormat = NumberFormat;
    Intl.RelativeTimeFormat = RelativeTimeFormat;
  }
  return made;
}

test('the durations, counts and numbers of a screen build each Intl formatter once for its language and options', () => {
  const say = () => {
    for (const t of [en, fr]) {
      for (let minutes = 0; minutes < 3000; minutes += 7) duration(minutes, t);
      for (let ms = 0; ms < 200_000; ms += 900) lasted(ms, t);
      since(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW, t);
      ago(new Date(NOW.getTime() - 26 * 3_600_000).toISOString(), NOW, t);
      for (let n = 0; n < 200; n += 1) {
        quantity(n * 1234, t);
        decimal(n / 7, t, 1, 1);
        t('time_minutes', { n });
      }
    }
    for (const language of ['en', 'fr'] as const) {
      for (let n = 0; n < 200; n += 1) {
        fixed(n / 3, 2, language);
        count(n * 999, language);
      }
    }
  };
  say();
  assert.deepEqual(built(say), { numbers: 0, relative: 0 }, 'said again, nothing is built');
  const first = built(() => { duration(61, en); duration(61, en); duration(61, en); });
  assert.ok(first.numbers <= 2, `three durations, at most one formatter per digits setting: ${first.numbers}`);
});

test('a cached formatter says what a new one says', () => {
  assert.equal(duration(125, fr), '2 h 05');
  assert.equal(duration(125, en), '2h 5m');
  assert.equal(quantity(12_345, fr), new Intl.NumberFormat('fr').format(12_345));
  assert.equal(quantity(12_345, en), '12,345');
  assert.equal(fixed(3.9, 2, 'fr'), '3,90');
  assert.equal(count(35_500, 'en'), '35,500');
  assert.equal(decimal(86.54, fr, 1, 1), '86,5');
  assert.equal(ago(new Date(NOW.getTime() - 26 * 3_600_000).toISOString(), NOW, fr), 'hier');
});

const state = (pending: { sessionId: string; requestId: string } | null, phase = 'waiting'): LeadState => ({ phase, pendingQuestion: pending } as unknown as LeadState);
const plan = (id: string, title: string, planState = 'proposed'): Plan => ({ id, goal: 'g', title, summary: '', items: [], maxParallel: 2, totals: { minutes: 30 }, state: planState, proposedAt: '2026-10-25T08:00:00Z', approvedAt: null, approvedBy: null } as unknown as Plan);

test('the Lead\'s stream, opened again, says nothing new to the inbox; a new question or a changed plan does', async () => {
  const { inboxNews } = await import('../../web/screens/lead/model.ts') as { inboxNews: (frame: unknown, held: { lead: LeadState; plans: readonly Plan[] }) => boolean };
  const asked = { sessionId: 'lead-session', requestId: 'q1' };
  const held = { lead: state(asked), plans: [plan('p1', 'Guestbook search')] };
  // What the stream says when it opens: the state and the plans the screen already holds.
  assert.equal(inboxNews({ kind: 'state', state: state({ ...asked }) }, held), false, 'the same question again');
  assert.equal(inboxNews({ kind: 'plan', plan: plan('p1', 'Guestbook search') }, held), false, 'the same plan again');
  assert.equal(inboxNews({ kind: 'state', state: state(null, 'working') }, held), false, 'no question waits');
  assert.equal(inboxNews({ kind: 'message', message: { seq: 9, at: '2026-10-25T08:00:00Z', by: 'lead', text: 'hi', kind: 'message' } }, held), false);
  // What changes the inbox.
  assert.equal(inboxNews({ kind: 'state', state: state({ sessionId: 'lead-session', requestId: 'q2' }) }, held), true, 'a new question');
  assert.equal(inboxNews({ kind: 'state', state: state(asked) }, { lead: state(null), plans: [] }), true, 'a question the screen did not hold');
  assert.equal(inboxNews({ kind: 'plan', plan: plan('p1', 'Guestbook search', 'approved') }, held), true, 'a plan that moved');
  assert.equal(inboxNews({ kind: 'plan', plan: plan('p2', 'Another plan') }, held), true, 'a new plan');
});
