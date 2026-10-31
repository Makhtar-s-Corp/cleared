// A login the hourly reading refuses (issue #509): a calm "unavailable", no red, no
// English reason in a French sentence, and no figure that nothing measured. A figure
// a session reported stays, with where it comes from. Both languages.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Consumption } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { headline, readingLines } from '../screens/consumption/model.ts';
import { weeklyQuota } from '../shell/quota.ts';
import { html, visibleText } from './render.tsx';

const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('consumption', 'fr') });
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('consumption', 'en') });
const NOW = new Date('2026-10-31T10:00:00.000Z');
const REFUSED = { at: '2026-10-31T09:00:00.000Z', source: 'claude-code /api/oauth/usage', ok: false, error: 'the endpoint refused the login (HTTP 403)', unavailable: true };
const REPORTED = { window: 'seven_day', usedPercent: 54, resetsAt: '2026-11-03T10:00:00.000Z', observedAt: '2026-10-31T08:00:00.000Z', source: 'session', projection: { kind: 'holds', percentAtReset: 78 } };
const data = (quotas: readonly unknown[]): Consumption => ({
  at: NOW.toISOString(), timeZone: 'UTC', days: ['2026-10-31'],
  harnesses: [{ harness: 'claude-code', sessions: 1, tokens: 10, perDay: [{ day: '2026-10-31', tokens: 10 }], quotas, lastReading: REFUSED, costUsd: null, costTurns: { reported: 0, turns: 1 } }],
  levers: { model: { current: 'claude-opus-5-5', choice: null, options: [], reviewer: 'claude-sonnet-5-5' }, maxLanes: { choice: null, options: [] }, paused: false }, wins: [],
} as never);
const drawn = (t: typeof fr, language: 'fr' | 'en', quotas: readonly unknown[]) => html(<ConsumptionView data={data(quotas)} t={t} language={language} now={NOW} />);

test('no figure: it says unavailable, calmly, with no red line and no reason in English', () => {
  const markup = drawn(fr, 'fr', []);
  const text = visibleText(markup).join(' ');
  assert.match(text, /[Ii]ndisponible/);
  assert.doesNotMatch(text, /refused the login|HTTP 403|a échoué|Non mesuré/);
  assert.doesNotMatch(markup, /quota-reading-failed/);
  assert.match(markup, /data-reading="unavailable"/);
  assert.doesNotMatch(text, /\d+\s*% utilisés/, 'no figure that nothing measured');
  assert.match(visibleText(drawn(en, 'en', [])).join(' '), /[Uu]navailable/);
});

test('a figure a session reported stays, says where it comes from, and the line says the sessions are the only source', () => {
  const text = visibleText(drawn(fr, 'fr', [REPORTED])).join(' ');
  assert.match(text, /54\s%\sutilisés/);
  assert.match(text, /rapport d'une session/);
  const lines = readingLines(data([REPORTED]).harnesses[0] as never, REPORTED as never, 'UTC', 'fr', fr);
  assert.deepEqual(lines.map((line) => line.kind), ['seen', 'unavailable']);
  assert.match(lines[1]?.text ?? '', /rapports des sessions/);
});

test('the headline and the sidebar\'s gauge agree', () => {
  assert.equal(headline(data([]), 'fr', fr).kind, 'unavailable');
  assert.match(headline(data([]), 'fr', fr).text, /indisponible/);
  assert.deepEqual(weeklyQuota(data([])), { kind: 'unavailable' });
  assert.equal(weeklyQuota(data([REPORTED])).kind, 'measured');
  assert.deepEqual(weeklyQuota(null), { kind: 'none' });
});

test('every word in both catalogs, no em dash', () => {
  for (const [t, language] of [[fr, 'fr'], [en, 'en']] as const) {
    const markup = drawn(t, language, []);
    assert.doesNotMatch(markup, /⟦|—/);
  }
});
