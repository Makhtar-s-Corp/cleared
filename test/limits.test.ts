import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.ts';
import { route } from '../lib/route.ts';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.ts';
import { conf, scratch, fixtureProject, sandbox, task, first } from './support.ts';


test('the subscription is watched from what each session says of it: its share used, what the day took and the pace', async () => {
  const { summary } = await import('../lib/limits.ts');
  // The day and the pace, from the readings kept.
  const at = (hour) => `2026-10-09T${String(hour).padStart(2, '0')}:00:00Z`;
  const week = { resets_at: '2026-10-13T09:00:00.000Z' };
  const history = [
    { at: '2026-10-08T20:00:00Z', windows: { seven_day: { used: 56, ...week } } },
    { at: at(5), windows: { seven_day: { used: 57, ...week } } },
    { at: at(9), windows: { seven_day: { used: 62, ...week } } },
    { at: at(11), windows: { seven_day: { used: 65, ...week } } },
    { at: at(12), windows: { seven_day: { used: 68, ...week } } },
  ];
  const dayStart = Date.parse('2026-10-08T22:00:00Z');
  const seen = summary(history, Date.parse(at(12)), 80, dayStart).seven_day;
  assert.deepEqual([seen.used, seen.today, seen.pace, seen.hours_to_stop, seen.hours_to_full, seen.stopped], [68, 12, 2, 6, 16, false]);
  assert.equal(summary([...history, { at: at(13), windows: { seven_day: { used: 81, ...week } } }], Date.parse(at(13)), 80, dayStart).seven_day.stopped, true);
  // Once the window has started over, what was read before says nothing of it.
  assert.deepEqual(summary(history, Date.parse('2026-10-13T10:00:00Z'), 80, Date.parse('2026-10-12T22:00:00Z')), {});
  // No pace from one reading; no stop when the project names none.
  assert.equal(summary(history.slice(-1), Date.parse(at(12)), 80, dayStart).seven_day.pace, null);
  assert.equal(summary([{ at: at(12), windows: { seven_day: { used: 99, ...week } } }], Date.parse(at(12)), null, dayStart).seven_day.stopped, false);
});
