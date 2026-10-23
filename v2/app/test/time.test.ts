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
import { ago, clock, decimal, duration, estimate, lasted, since } from '../web/lib/time.ts';
import { sessionStatus, ticketState } from '../web/lib/status.ts';

const en = translator(loadCatalog('shell', 'en'));
const fr = translator(loadCatalog('shell', 'fr'));
const NOW = new Date(2026, 9, 23, 14, 30);
// The catalogs' no-break spaces, written as plain ones in the tables below.
const nb = (text: string) => text.replace(/(\d) (?=min|[hjs]\b|\d)/g, '$1\u00a0').replace(/([hjd]) (?=\d)/g, '$1\u00a0');
const before = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

test('a duration: minutes under an hour, hours and minutes under a day, days and hours past it', () => {
  const minutes = [0, 1, 42, 59, 60, 61, 125, 630, 1439, 1440, 1500, 3120, 3125, 20000];
  assert.deepEqual(minutes.map((m) => duration(m, fr)), ['0 min', '1 min', '42 min', '59 min', '1 h', '1 h 01', '2 h 05', '10 h 30', '23 h 59', '1 j', '1 j 1 h', '2 j 4 h', '2 j 4 h', '13 j 21 h'].map(nb));
  assert.deepEqual(minutes.map((m) => duration(m, en)), ['0 min', '1 min', '42 min', '59 min', '1h', '1h 1m', '2h 5m', '10h 30m', '23h 59m', '1d', '1d 1h', '2d 4h', '2d 4h', '13d 21h'].map(nb));
  assert.equal(duration(41.6, fr), nb('42 min'), 'rounded to the minute');
  assert.equal(duration(-5, fr), nb('0 min'), 'never negative');
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
  assert.equal(estimate(0, fr), nb('1 min'));
  assert.equal(estimate(135, fr), nb('2 h 15'));
  assert.equal(since(before(0.5), NOW, fr), 'à l\'instant');
  assert.equal(since(before(12), NOW, fr), nb('12 min'));
  assert.equal(since(before(26 * 60 + 2), NOW, fr), nb('1 j 2 h'));
  assert.equal(since(before(26 * 60 + 2), NOW, en), nb('1d 2h'));
  assert.equal(lasted(42_000, fr), nb('42 s'));
  assert.equal(lasted(42_000, en), nb('42s'));
  assert.equal(lasted(18 * 60_000 + 5_000, fr), nb('18 min'));
  assert.equal(lasted(90 * 60_000, en), nb('1h 30m'));
});

test('a date relative to now: just now, minutes, hours today, yesterday, then days', () => {
  assert.equal(ago(before(0.2), NOW, fr), 'à l\'instant');
  assert.equal(ago(before(3), NOW, fr), nb('il y a 3 min'));
  assert.equal(ago(before(3), NOW, en), nb('3 min ago'));
  assert.equal(ago(before(150), NOW, fr), nb('il y a 2 h'));
  assert.equal(ago(before(150), NOW, en), nb('2h ago'));
  // 14:30 now: 20 h back is yesterday at 18:30, and 40 h back the day before.
  assert.equal(ago(before(20 * 60), NOW, fr), 'hier');
  assert.equal(ago(before(20 * 60), NOW, en), 'yesterday');
  assert.equal(ago(before(40 * 60), NOW, fr), nb('il y a 2 j'));
  assert.equal(ago(before(40 * 60), NOW, en), nb('2d ago'));
  // Past midnight, 50 minutes back is still minutes, not yesterday.
  const early = new Date(2026, 9, 23, 0, 20);
  assert.equal(ago(new Date(early.getTime() - 50 * 60_000).toISOString(), early, fr), nb('il y a 50 min'));
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

test('a decimal number in the catalog\'s locale, through Intl', () => {
  assert.equal(decimal(3.94, fr, 0, 1), '3,9');
  assert.equal(decimal(3.94, en, 0, 1), '3.9');
  assert.equal(decimal(3.9, en, 2, 2), '3.90');
  assert.equal(decimal(1234.5, fr, 2, 2), '1234,50', 'no grouping in a sentence');
  assert.equal(duration(90, fr), nb('1 h 30'));
});

// A number keeps its unit (plan 5.4, lane i18n's art director): no line breaks between them.
test('a duration never breaks between a number and its unit, nor between the hours and the minutes', () => {
  for (let m = 0; m < 3 * 24 * 60; m += 13) {
    for (const t of [en, fr]) {
      const said = duration(m, t);
      assert.doesNotMatch(said, /\d \D|\D \d/, `${m} min reads "${said}" with a breaking space`);
    }
  }
  assert.equal(duration(630, fr), '10\u00a0h\u00a030');
  assert.equal(duration(630, en), nb('10h\u00a030m'));
  assert.equal(ago(before(3), NOW, fr), 'il y a 3\u00a0min');
});
