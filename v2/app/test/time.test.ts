// One formatter for every time the app says (the owner's requests of
// 2026-10-23, 08:30 and 08:40, lane i18n): a duration is "42 min" under an
// hour, "10 h 30" ("10h 30m") under a day, "2 j 4 h" ("2d 4h") past it; a
// date is said relative to now, "il y a 3 min" ("3 min ago"), "hier"; a
// session's or a ticket's status is said in the person's language. The
// words are the shell's, which every screen's catalog holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/catalog.ts';
import { translator } from '../web/lib/i18n.ts';
import { ago, clock, duration, estimate, lasted, since } from '../web/lib/time.ts';
import { sessionStatus, ticketState } from '../web/lib/status.ts';

const en = translator(loadCatalog('shell', 'en'));
const fr = translator(loadCatalog('shell', 'fr'));
const NOW = new Date(2026, 9, 23, 14, 30);
const before = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

test('a duration: minutes under an hour, hours and minutes under a day, days and hours past it', () => {
  const minutes = [0, 1, 42, 59, 60, 61, 125, 630, 1439, 1440, 1500, 3120, 3125, 20000];
  assert.deepEqual(minutes.map((m) => duration(m, fr)), ['0 min', '1 min', '42 min', '59 min', '1 h', '1 h 01', '2 h 05', '10 h 30', '23 h 59', '1 j', '1 j 1 h', '2 j 4 h', '2 j 4 h', '13 j 21 h']);
  assert.deepEqual(minutes.map((m) => duration(m, en)), ['0 min', '1 min', '42 min', '59 min', '1h', '1h 1m', '2h 5m', '10h 30m', '23h 59m', '1d', '1d 1h', '2d 4h', '2d 4h', '13d 21h']);
  assert.equal(duration(41.6, fr), '42 min', 'rounded to the minute');
  assert.equal(duration(-5, fr), '0 min', 'never negative');
});

test('no duration says more than 59 minutes', () => {
  for (let m = 0; m < 5 * 24 * 60; m += 7) {
    for (const t of [en, fr]) {
      const said = duration(m, t);
      for (const [, n] of said.matchAll(/(\d+)\s*min/g)) assert.ok(Number(n) < 60, `${m} min reads "${said}"`);
    }
  }
});

test('an estimate is never zero; an age under a minute is now; a run under a minute is in seconds', () => {
  assert.equal(estimate(0, fr), '1 min');
  assert.equal(estimate(135, fr), '2 h 15');
  assert.equal(since(before(0.5), NOW, fr), 'à l\'instant');
  assert.equal(since(before(12), NOW, fr), '12 min');
  assert.equal(since(before(26 * 60 + 2), NOW, fr), '1 j 2 h');
  assert.equal(since(before(26 * 60 + 2), NOW, en), '1d 2h');
  assert.equal(lasted(42_000, fr), '42 s');
  assert.equal(lasted(42_000, en), '42s');
  assert.equal(lasted(18 * 60_000 + 5_000, fr), '18 min');
  assert.equal(lasted(90 * 60_000, en), '1h 30m');
});

test('a date relative to now: just now, minutes, hours today, yesterday, then days', () => {
  assert.equal(ago(before(0.2), NOW, fr), 'à l\'instant');
  assert.equal(ago(before(3), NOW, fr), 'il y a 3 min');
  assert.equal(ago(before(3), NOW, en), '3 min ago');
  assert.equal(ago(before(150), NOW, fr), 'il y a 2 h');
  assert.equal(ago(before(150), NOW, en), '2h ago');
  // 14:30 now: 20 h back is yesterday at 18:30, and 40 h back the day before.
  assert.equal(ago(before(20 * 60), NOW, fr), 'hier');
  assert.equal(ago(before(20 * 60), NOW, en), 'yesterday');
  assert.equal(ago(before(40 * 60), NOW, fr), 'il y a 2 j');
  assert.equal(ago(before(40 * 60), NOW, en), '2d ago');
  // Past midnight, 50 minutes back is still minutes, not yesterday.
  const early = new Date(2026, 9, 23, 0, 20);
  assert.equal(ago(new Date(early.getTime() - 50 * 60_000).toISOString(), early, fr), 'il y a 50 min');
  assert.equal(ago(new Date(early.getTime() - 3 * 3600_000).toISOString(), early, fr), 'hier');
  assert.equal(ago(new Date(NOW.getTime() + 60_000).toISOString(), NOW, fr), 'à l\'instant', 'a clock a little ahead');
});

test('a clock: hours and minutes, padded', () => {
  assert.equal(clock(new Date(2026, 9, 23, 9, 5).toISOString()), '09:05');
});

test('a session\'s status in the person\'s language, by its phase; the service\'s phrase of a tool translated by its shape', () => {
  const s = (phase: string, status: string) => sessionStatus({ phase: phase as never, status }, fr);
  assert.equal(s('starting', 'Starting'), 'Démarrage');
  assert.equal(s('working', 'Working'), 'Au travail');
  assert.equal(s('reviewing', 'Reviewing'), 'En relecture');
  assert.equal(s('waiting_human', 'Paused, waiting for you'), 'En pause, attend votre réponse');
  assert.equal(s('done', 'Done'), 'Terminée');
  assert.equal(s('stopped', 'Stopped'), 'Arrêtée');
  assert.equal(s('failed', 'Failed'), 'Arrêtée sur une erreur');
  assert.equal(s('paused', 'Paused'), 'En pause');
  assert.equal(s('working', 'Reading src/page.ts'), 'Lit src/page.ts');
  assert.equal(s('working', 'Editing src/page.ts'), 'Modifie src/page.ts');
  assert.equal(s('reviewing', 'Searching for week'), 'Cherche week');
  assert.equal(s('working', 'Running npm test'), 'Lance npm test');
  // What the harness wrote of its own is data, as written.
  assert.equal(s('working', 'Writing a test for a timeout'), 'Writing a test for a timeout');
  assert.equal(s('working', ''), 'Au travail');
  assert.equal(sessionStatus({ phase: 'stopped', status: 'Stopped' }, en), 'Stopped');
  assert.equal(sessionStatus({ phase: 'working', status: 'Reading src/page.ts' }, en), 'Reading src/page.ts');
});

test('a ticket\'s state in the person\'s language for the tracker\'s default names; a state of its own as written', () => {
  const states = ['Todo', 'In Progress', 'In Review', 'Needs Approval', 'Ready to Ship', 'Done'];
  assert.deepEqual(states.map((s) => ticketState(s, fr)), ['À faire', 'En cours', 'En relecture', 'À approuver', 'Prêt à livrer', 'Terminé']);
  assert.deepEqual(states.map((s) => ticketState(s, en)), states);
  assert.equal(ticketState('Backlog', fr), 'Backlog');
});

test('a harness\'s own sentence that starts as a tool\'s phrase stays as written', () => {
  const s = (status: string) => sessionStatus({ phase: 'working', status }, fr);
  assert.equal(s('Reading the diff of src/screens/Envelope.jsx'), 'Reading the diff of src/screens/Envelope.jsx');
  assert.equal(s('Running the docs tests · 12 passed so far'), 'Running the docs tests · 12 passed so far');
  assert.equal(s('Running npm test 2>&1 | tail -8'), 'Lance npm test 2>&1 | tail -8');
});
