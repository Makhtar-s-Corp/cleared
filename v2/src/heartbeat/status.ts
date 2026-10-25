// What the status says (docs/v2/milestone-4-plan.md, section 8.4): one line
// per part for a person at the terminal, or one JSON object, schema 1, with
// v1's stable keys where v2 has them. Its words are
// messages/heartbeat.<language>.json, over the shell's for the units of a
// duration, which app/web/lib/time.ts says as the app does; the language is
// CLEARED_V2_APP_LANGUAGE's, French by default. Ticket ids and session ids
// are said here, for the local operator; they never reach the monitor.
import { readFileSync } from 'node:fs';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { hasMark, translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { ago, decimal, duration, lasted, quantity, since } from '../../app/web/lib/time.ts';
import { failing, type Problem } from './beat.ts';
import type { Snapshot } from './snapshot.ts';

export const HEARTBEAT_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;

export function statusLanguage(env: NodeJS.ProcessEnv): Language {
  return env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr';
}

export function statusTranslator(language: Language): Translate {
  const read = (lang: Language) => JSON.parse(readFileSync(`${HEARTBEAT_MESSAGES_DIR}heartbeat.${lang}.json`, 'utf8')) as Record<string, string>;
  const catalog: Catalog = { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
  return translator(catalog);
}

export type StatusInput = {
  readonly project: string | null;
  readonly snapshot: Snapshot;
  readonly problems: readonly Problem[];
  readonly service: { readonly address: string; readonly reachable: boolean };
  readonly now: Date;
};

// What the ledger holds is printed without its control characters.
const plain = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140);

// A kind, a role or a train's state the catalog does not name reads as "an item".
const word = (t: Translate, key: string, fallback: string) => {
  const text = t(key);
  return hasMark(text) ? t(fallback) : text;
};

export function problemMessage(problem: Problem, t: Translate): string {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(problem.values)) values[key] = plain(String(value));
  if (typeof problem.values.minutes === 'number') values.time = duration(problem.values.minutes, t);
  if (typeof problem.values.role === 'string') values.role = word(t, `role_${problem.values.role}`, 'kind_other');
  return t(`problem_${problem.code}`, values);
}

export function statusJson(input: StatusInput, t: Translate) {
  const { snapshot: s } = input;
  const problems = input.problems.map((p) => ({ code: p.code, id: p.id, level: p.level, message: problemMessage(p, t) }));
  return {
    schema: 1,
    project: input.project,
    checkedAt: input.now.toISOString(),
    ok: failing(input.problems).length === 0,
    service: input.service,
    lastBeat: s.lastBeat,
    monitor: s.monitor,
    sessions: { running: s.sessions.length, names: s.sessions.map((session) => session.id) },
    waiting: s.waiting,
    quota: s.quota,
    trackers: s.trackers,
    releases: s.releases,
    problems,
    notices: problems.filter((p) => p.level === 'notice'),
  };
}

export function renderStatus(input: StatusInput, t: Translate): string[] {
  const { snapshot: s, now } = input;
  const at = (iso: string) => ago(iso, now, t);
  const lasting = (iso: string) => {
    const text = since(iso, now, t);
    return text === t('time_now') ? text : t('waiting_for', { time: text });
  };

  const beat = !s.lastBeat ? t('beat_never') : s.lastBeat.ok ? at(s.lastBeat.at) : t('beat_failed_at', { time: at(s.lastBeat.at) });
  const monitor = !s.monitor ? t('monitor_unknown')
    : s.monitor.state === 'on' ? t('monitor_on', { time: lasted(s.lastBeat?.everyMs ?? 60_000, t) })
      : s.monitor.state === 'off' ? t('monitor_off') : t('monitor_invalid');
  const sessions = s.sessions.length === 0 ? t('sessions_none') : t('sessions_some', { n: quantity(s.sessions.length, t) });
  const oldest = s.waiting.oldest;
  const waiting = !oldest || s.waiting.count === 0 ? t('waiting_none')
    : t(s.waiting.count === 1 ? 'waiting_one' : 'waiting_other', {
      n: quantity(s.waiting.count, t), ticket: plain(oldest.ticket), kind: word(t, `kind_${oldest.kind}`, 'kind_other'), time: lasting(oldest.since),
    });
  const quota = s.quota === null ? t('quota_unknown') : s.quota.length === 0 ? t('quota_none')
    : s.quota.map((q) => t(`quota_${q.window}`, { percent: t('percent', { n: decimal(q.usedPercent, t, 0, 1) }) })).join(' · ');
  const trackers = s.trackers.length === 0 ? t('trackers_none')
    : s.trackers.map((tracker) => t('tracker_read', { tracker: plain(tracker.name), time: at(tracker.readAt) })).join(' · ');
  const releases = s.releases.length === 0 ? t('releases_none')
    : s.releases.map((r) => t('release', { ticket: plain(r.ticket), state: word(t, `train_${r.state}`, 'kind_other'), time: since(r.since, now, t) })).join(' · ');
  const problems = failing(input.problems).map((p) => problemMessage(p, t));
  const notices = input.problems.filter((p) => p.level === 'notice').map((p) => problemMessage(p, t));

  const rows: [string, string[]][] = [
    [t('label_service'), [t(input.service.reachable ? 'service_up' : 'service_down', { address: input.service.address })]],
    [t('label_beat'), [beat]],
    [t('label_monitor'), [monitor]],
    [t('label_sessions'), [sessions]],
    [t('label_waiting'), [waiting]],
    [t('label_quota'), [quota]],
    [t('label_trackers'), [trackers]],
    [t('label_releases'), [releases]],
    [t('label_problems'), problems.length > 0 ? problems : [t('none')]],
    ...(notices.length > 0 ? [[t('label_notices'), notices] as [string, string[]]] : []),
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = [input.project ? t('title', { project: plain(input.project) }) : t('title_none')];
  for (const [label, values] of rows) values.forEach((value, i) => lines.push(`${(i === 0 ? label : '').padEnd(width)}${value}`));
  return lines;
}
