// The status's words and its JSON (docs/v2/milestone-4-plan.md, section
// 7.4): one line per part, in French by default and in English, every
// duration as a person reads it, and schema 1 with the stable keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../../src/heartbeat/beat.ts';
import type { HeartbeatSettings } from '../../src/heartbeat/settings.ts';
import type { Snapshot } from '../../src/heartbeat/snapshot.ts';
import { renderStatus, statusJson, statusLanguage, statusTranslator, type StatusInput } from '../../src/heartbeat/status.ts';
import { NOW, minutesBefore } from './support.ts';

const settings: HeartbeatSettings = { everyMs: 60_000, sessionMinutes: 120, trackerMinutes: 10, trackers: ['github'] };

const snapshot: Snapshot = {
  lastBeat: { at: minutesBefore(1), ok: true, everyMs: 60_000 },
  monitor: { state: 'on', refused: [] },
  sessions: [
    { id: 's1', ticket: 'LOCAL-1', role: 'author', status: 'working', movedAt: minutesBefore(4) },
    { id: 's2', ticket: 'LOCAL-4', role: 'reviewer', status: 'reviewing', movedAt: minutesBefore(185) },
  ],
  waiting: { count: 2, oldest: { ticket: 'LOCAL-2', kind: 'question', since: minutesBefore(90) } },
  quota: [{ window: 'five_hour', usedPercent: 10, resetsAt: null }, { window: 'seven_day', usedPercent: 42.5, resetsAt: null }],
  trackers: [{ name: 'github:example-org/shop', readAt: minutesBefore(3) }],
  releases: [{ ticket: 'LOCAL-3', state: 'halted', since: minutesBefore(40) }],
};

function input(over: Partial<Snapshot> = {}, reachable = true): StatusInput {
  const s = { ...snapshot, ...over };
  const service = { address: '127.0.0.1:8791', reachable };
  return { project: 'shop', snapshot: s, problems: diagnose({ side: 'status', snapshot: s, settings, now: NOW, health: service }), service, now: NOW };
}

test('the language is the app\'s, French by default', () => {
  assert.equal(statusLanguage({}), 'fr');
  assert.equal(statusLanguage({ CLEARED_V2_APP_LANGUAGE: 'en' }), 'en');
  assert.equal(statusLanguage({ CLEARED_V2_APP_LANGUAGE: 'de' }), 'fr');
});

test('in English: one line per part, durations a person reads, the problem said in a sentence', () => {
  const lines = renderStatus(input(), statusTranslator('en'));
  assert.equal(lines[0], 'Cleared · shop');
  const text = lines.join('\n');
  assert.match(text, /^Service +answers at 127\.0\.0\.1:8791$/m);
  assert.match(text, /^Last beat +1 min ago$/m);
  assert.match(text, /^Monitor +on, a beat every 1 min$/m);
  assert.match(text, /^Sessions +2 running$/m);
  assert.match(text, /^Waiting on you +2 items, the oldest LOCAL-2 \(a question\) for 1h 30m$/m);
  assert.match(text, /^Quota +10 % of the 5-hour window · 42\.5 % of the week$/m);
  assert.match(text, /^Mirrors +github:example-org\/shop read 3 min ago$/m);
  assert.match(text, /^Releases +LOCAL-3 halted for 40 min$/m);
  assert.match(text, /^Problems +Session s2 \(reviewer\) of LOCAL-4 has not moved for 3h 5m\.$/m);
  assert.doesNotMatch(text, /\b\d{3,} ?min/, 'no duration in minutes past an hour');
});

test('in French, with French typography', () => {
  const text = renderStatus(input(), statusTranslator('fr')).join('\n');
  assert.match(text, /^Dernier battement +il y a 1 min$/m);
  assert.match(text, /^En attente de vous +2 éléments, le plus ancien LOCAL-2 \(une question\) depuis 1 h 30$/m);
  assert.match(text, /^Quota +10 % de la fenêtre de 5 heures · 42,5 % de la semaine$/m);
  assert.match(text, /^Problèmes +La session s2 \(relecteur\) de LOCAL-4 n'a pas bougé depuis 3 h 05\.$/m);
});

test('the empty cases are said as such', () => {
  const t = statusTranslator('en');
  const text = renderStatus(input({
    lastBeat: { at: minutesBefore(1), ok: true, everyMs: 30_000 }, sessions: [], waiting: { count: 0, oldest: null }, quota: null, trackers: [], releases: [],
  }), t).join('\n');
  assert.match(text, /^Monitor +on, a beat every 30s$/m);
  assert.match(text, /^Sessions +none running$/m);
  assert.match(text, /^Waiting on you +nothing$/m);
  assert.match(text, /^Quota +unknown$/m);
  assert.match(text, /^Mirrors +none$/m);
  assert.match(text, /^Releases +none$/m);
  assert.match(text, /^Problems +none$/m);
  assert.match(renderStatus(input({ quota: [] }), t).join('\n'), /^Quota +no recent reading$/m);
  assert.match(renderStatus(input({ waiting: { count: 1, oldest: { ticket: 'LOCAL-9', kind: 'permission', since: minutesBefore(0) } } }), t).join('\n'),
    /^Waiting on you +1 item, LOCAL-9 \(a permission\) just now$/m);
});

test('a service down, a beat never written, a monitor off: each said, the notice apart', () => {
  const t = statusTranslator('en');
  const text = renderStatus(input({ lastBeat: null, monitor: null }, false), t).join('\n');
  assert.match(text, /^Service +does not answer at 127\.0\.0\.1:8791$/m);
  assert.match(text, /^Last beat +never$/m);
  assert.match(text, /^Monitor +unknown until the service beats$/m);
  assert.match(text, /^Problems +No beat is recorded: the service has not run on this ledger, or not since it was updated\.\n +The service does not answer at 127\.0\.0\.1:8791\.\n +Session s2/m);
  const off = renderStatus(input({ monitor: { state: 'off', refused: [] } }), t).join('\n');
  assert.match(off, /^Monitor +off: nobody hears it when the service stops$/m);
  assert.match(off, /^Notices +No monitor is set \(CLEARED_V2_HEARTBEAT_PING_URL_FILE\): nobody hears it when the service stops\.$/m);
  const failed = renderStatus(input({ lastBeat: { at: minutesBefore(2), ok: false, everyMs: 60_000 } }), t).join('\n');
  assert.match(failed, /^Last beat +2 min ago, it could not read the ledger$/m);
});

test('what the ledger holds is printed without its control characters', () => {
  const text = renderStatus(input({ waiting: { count: 1, oldest: { ticket: 'LOCAL-1\u001b[2J', kind: 'question', since: minutesBefore(5) } } }), statusTranslator('en')).join('\n');
  assert.ok(!text.includes('\u001b'));
});

test('the JSON: schema 1, the stable keys, each problem with its code, id, level and message', () => {
  const json = statusJson(input({ monitor: { state: 'off', refused: [] } }), statusTranslator('en'));
  assert.deepEqual(Object.keys(json), ['schema', 'project', 'checkedAt', 'ok', 'service', 'lastBeat', 'monitor', 'sessions', 'waiting', 'quota', 'trackers', 'releases', 'problems', 'notices']);
  assert.equal(json.schema, 1);
  assert.equal(json.project, 'shop');
  assert.equal(json.checkedAt, NOW.toISOString());
  assert.equal(json.ok, false);
  assert.deepEqual(json.service, { address: '127.0.0.1:8791', reachable: true });
  assert.deepEqual(json.lastBeat, { at: minutesBefore(1), ok: true, everyMs: 60_000 });
  assert.deepEqual(json.monitor, { state: 'off', refused: [] });
  assert.deepEqual(json.sessions, { running: 2, names: ['s1', 's2'] });
  assert.deepEqual(json.waiting, snapshot.waiting);
  assert.deepEqual(json.problems, [
    { code: 'monitor_off', id: 'monitor', level: 'notice', message: 'No monitor is set (CLEARED_V2_HEARTBEAT_PING_URL_FILE): nobody hears it when the service stops.' },
    { code: 'session_stalled', id: 's2', level: 'problem', message: 'Session s2 (reviewer) of LOCAL-4 has not moved for 3h 5m.' },
  ]);
  assert.deepEqual(json.notices, [json.problems[0]]);
  assert.equal(statusJson(input({ sessions: [], monitor: { state: 'off', refused: [] } }), statusTranslator('en')).ok, true, 'a notice alone is ok');
});
