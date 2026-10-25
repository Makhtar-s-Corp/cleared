// The app reads only the wake's complete board snapshot, the ledger health
// record, and locally cached captures. No tracker or forge code is imported.
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { loadConf, section, stateDir } from '../../lib/conf.ts';
import { ledgerPath, openLedger } from '../../lib/ledger.ts';
import { message } from '../../lib/i18n.ts';
import { scrub } from '../../lib/board-scrub.ts';
import type { Conf } from '../../lib/conf.ts';
import type { Board } from '../lib/events.ts';

type Problem = { code: string; message: string };
type LiveBoard = Board & { schema: number; project: string; projects: unknown[]; language: string; generatedAt: string | null; details: Record<string, { show?: unknown }>;
  health: { ok: boolean; problems: Problem[]; recordedAt: string | null } };

const DIGEST = /^[a-f0-9]{64}$/;
// The board is parsed JSON: once a value is known to be an object, its fields are read as they come and checked one by one.
type Fields = Record<string, any>;
const record = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const time = (value: unknown) => string(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const mediaUrl = (value: unknown) => string(value) && /^\/media\/[a-f0-9]{64}$/.test(value);
const strings = (value: unknown, max = 20, length = 1500) => Array.isArray(value) && value.length <= max && value.every((x) => string(x) && x.length <= length);
const share = (value: unknown) => value === null || Number.isFinite(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || value === null || check(value);
const count = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
// The questions a team ended on: full text, its recommendation when it gave one, its choices.
const validQuestions = (value: unknown) => value === undefined || (Array.isArray(value) && value.length <= 4 && value.every((q) => record(q)
  && string(q.text) && q.text.length <= 1500 && (q.recommendation === null || (string(q.recommendation) && q.recommendation.length <= 600))
  && strings(q.options, 4, 80)));
// What changed: the pull request and what the wake knows of it. Unknown is null, never a guess.
const validChange = (value: unknown) => optional(value, (c) => record(c) && record(c.pr) && Number.isSafeInteger(c.pr.number)
  && (c.pr.url === null || (string(c.pr.url) && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(c.pr.url)))
  && ['files', 'additions', 'deletions', 'lines'].every((k) => count(c[k]))
  && (c.checks === null || ['green', 'red', 'running', 'none'].includes(c.checks)) && (c.draft === null || typeof c.draft === 'boolean'));
// The lane of a ticket (lib/fast-lane.ts) and the medians of the last days, by lane.
const validLane = (value: unknown) => optional(value, (lane) => lane === 'fast' || lane === 'full');
const validMedian = (value: unknown) => record(value) && (value.minutes === null || (Number.isFinite(value.minutes) && value.minutes >= 0)) && Number.isSafeInteger(value.count) && value.count >= 0;
const validLanes = (value: unknown) => value === undefined || (record(value) && validMedian(value.fast) && validMedian(value.full));
const minutes = (value: unknown) => value === undefined || value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
const validReport = (value: unknown) => optional(value, (r) => record(r) && time(r.at) && ['done', 'remaining', 'other'].every((k) => strings(r[k], 10, 600)));
const validDetail = (detail: unknown) => record(detail) && string(detail.id) && string(detail.title)
  && string(detail.column) && string(detail.kind) && typeof detail.waiting === 'boolean'
  && Number.isFinite(detail.flightMinutes) && share(detail.quotaShare)
  && optional(detail.since, time) && validQuestions(detail.questions) && validChange(detail.change) && validReport(detail.report)
  && Array.isArray(detail.where) && detail.where.every(string)
  && Array.isArray(detail.squad) && detail.squad.every((entry) => record(entry)
    && string(entry.role) && string(entry.harness) && string(entry.model))
  && record(detail.show) && (
    detail.show.kind === 'screen'
      ? ['before', 'after'].every((side) => Array.isArray(detail.show[side])
        && detail.show[side].every((image) => record(image) && mediaUrl(image.url) && string(image.caption)))
        && optional(detail.show.missing, (m) => ['working', 'none_kept', 'not_kept'].includes(m as string))
      : detail.show.kind === 'code' && Array.isArray(detail.show.tests)
        && detail.show.tests.every((test) => record(test) && string(test.name) && string(test.change) && string(test.state))
        && (detail.show.example === null || record(detail.show.example)) && string(detail.show.touches))
  && Array.isArray(detail.blackBox) && detail.blackBox.every((event) => record(event)
    && time(event.at) && string(event.text) && string(event.stage) && record(event.raw));
// What the three gestures rely on: the tracker reference, the version the user was shown, the team's options.
const validGesture = (ticket: Fields) => (ticket.ref === undefined || ticket.ref === null || (string(ticket.ref) && /^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket.ref)))
  && (ticket.approval === undefined || ticket.approval === null || (record(ticket.approval) && time(ticket.approval.at) && Array.isArray(ticket.approval.versions)
    && ticket.approval.versions.length >= 1 && ticket.approval.versions.length <= 8
    && ticket.approval.versions.every((v) => record(v) && Number.isSafeInteger(v.pr) && string(v.head) && /^[0-9a-f]{40}$/.test(v.head))))
  && (ticket.options === undefined || (Array.isArray(ticket.options) && ticket.options.length <= 4 && ticket.options.every((o) => string(o) && o.length <= 80)));
export function validBoard(value: unknown) {
  return record(value) && value.schema === 1 && string(value.project)
    && Array.isArray(value.projects) && value.projects.every((project) => record(project) && string(project.id) && string(project.name))
    && ['en', 'fr'].includes(value.language) && time(value.generatedAt)
    && record(value.owner) && string(value.owner.name)
    && record(value.stats) && Number.isFinite(value.stats.inFlight)
    && (value.stats.firstTimeClean === null || Number.isFinite(value.stats.firstTimeClean)) && validLanes(value.stats.lanes)
    && Array.isArray(value.landed) && value.landed.every((row) => record(row) && time(row.at)
      && string(row.id) && string(row.title) && string(row.model) && string(row.harness)
      && Number.isFinite(row.fixes) && (row.rolledBackAt === null || time(row.rolledBackAt)) && share(row.share)
      && validLane(row.lane) && ['totalMin', 'workingMin', 'humanWaitMin', 'machineWaitMin'].every((k) => minutes(row[k])))
    && Array.isArray(value.fuel) && value.fuel.every((entry) => record(entry) && string(entry.adapter)
      && typeof entry.measured === 'boolean' && (!entry.measured || Number.isFinite(entry.left)))
    && Array.isArray(value.tickets) && record(value.details)
    && record(value.mode) && string(value.mode.short) && string(value.mode.label)
    && record(value.health) && Array.isArray(value.health.problems)
    && value.health.problems.every((entry) => record(entry) && string(entry.message))
    && value.tickets.every((ticket) => record(ticket) && /^[A-Za-z0-9._-]{1,40}$/.test(ticket.id)
      && string(ticket.title) && ['progress', 'checks', 'review', 'awaiting'].includes(ticket.column)
      && string(ticket.kind) && string(ticket.model) && string(ticket.statusLine)
      && Number.isFinite(ticket.flightMinutes) && share(ticket.quotaShare)
      && optional(ticket.since, time) && validQuestions(ticket.questions) && validChange(ticket.change)
      && validGesture(ticket) && validLane(ticket.lane)
      && (ticket.captures === null || record(ticket.captures) && mediaUrl(ticket.captures.before) && mediaUrl(ticket.captures.after))
      && Object.hasOwn(value.details, ticket.id) && validDetail(value.details[ticket.id]))
    && Object.values(value.details).every(validDetail);
}
export function liveSource({ conf = loadConf(), now = () => Date.now(), dir = stateDir() }: { conf?: Conf; now?: () => number; dir?: string } = {}) {
  const language = section(conf, 'owner').language || 'en';
  const interval = Number(section(conf, 'heartbeat').wake_interval_minutes) || 1;
  const path = join(dir, 'snapshot.json');
  let cached: LiveBoard | undefined, signature = '';
  const safeName = (value: unknown) => scrub(value, 60);
  const problem = (code: string, key: string, values: Record<string, unknown> = {}): Problem => ({ code, message: message(key, language, values) });
  function health() {
    let db: ReturnType<typeof openLedger> | undefined;
    try {
      db = openLedger(ledgerPath(), { readOnly: true });
      const get = (key: string) => { try { return (db!.prepare('SELECT value FROM heartbeat_state WHERE key = ?').get(key)?.value || null) as string | null; } catch { return null; } };
      const lastWakeRaw = get('last_wake_at');
      const lastWake = lastWakeRaw && /^\d{4}-\d{2}-\d{2}T/.test(lastWakeRaw) && Number.isFinite(Date.parse(lastWakeRaw)) ? lastWakeRaw : null;
      const age = lastWake ? now() - Date.parse(lastWake) : null;
      const problems: Problem[] = [];
      if (!lastWake) problems.push(problem('wake_missing', 'app_srv_problem_wake_missing'));
      else if (age! > 3 * interval * 60000) problems.push(problem('wake_late', 'app_srv_problem_wake_late', { minutes: Math.floor(age! / 60000) }));
      else if (get('last_wake_ok') === 'false') problems.push(problem('wake_failed', 'app_srv_problem_wake_failed'));
      let incidents: Record<string, unknown>[] = [];
      try { incidents = db.prepare('SELECT id FROM heartbeat_incidents WHERE active = 1 ORDER BY first_seen').all(); } catch { /* no incidents yet */ }
      for (const { id } of incidents) {
        const [rawCode, ...rest] = String(id).split(':');
        const code = safeName(rawCode);
        if (['wake_late', 'wake_missing', 'wake_failed'].includes(code)) continue;
        let text: string;
        try { text = message(`app_srv_problem_${code}`, language, { name: safeName(rest.join(':')) }); }
        catch { text = message('app_srv_problem_other', language, { code: code.slice(0, 40) }); }
        problems.push({ code: code.slice(0, 40), message: text });
      }
      return { recordedAt: lastWake, problems };
    } catch { return { recordedAt: null, problems: [problem('wake_missing', 'app_srv_problem_wake_missing')] }; }
    finally { db?.close(); }
  }
  function read() {
    try {
      const bytes = readFileSync(path, 'utf8');
      if (bytes !== signature) {
        const value = JSON.parse(bytes);
        if (value.schema !== 1) throw new Error('version');
        if (!validBoard(value)) throw new Error('incomplete');
        cached = value; signature = bytes;
      }
    } catch (error) {
      const key = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'app_snapshot_missing' : (error as Error | null)?.message === 'version' ? 'app_snapshot_version' : 'app_snapshot_unreadable';
      cached = { schema: 1, project: '', projects: [], language, generatedAt: null, owner: { name: '' },
        stats: { inFlight: 0, firstTimeClean: null }, landed: [], fuel: [], tickets: [], details: {},
        mode: { key: '', short: '', label: '' }, health: { ok: false, problems: [problem('snapshot_invalid', key)], recordedAt: null } };
      signature = '';
    }
    const value = structuredClone(cached as LiveBoard);
    const wake = health();
    const problems = [...wake.problems];
    if (value.generatedAt) {
      const age = now() - Date.parse(value.generatedAt);
      if (!Number.isFinite(age)) problems.push(problem('snapshot_invalid', 'app_snapshot_unreadable'));
      else if (age > 3 * interval * 60000) problems.push(problem('snapshot_old', 'app_snapshot_old', { minutes: Math.floor(age / 60000) }));
    } else problems.unshift(...value.health.problems);
    value.health = { ok: problems.length === 0, problems, recordedAt: wake.recordedAt };
    return value;
  }
  return {
    snapshot: async () => read(),
    ticket: async (id: string) => {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
      const details = read().details;
      return Object.hasOwn(details, id) ? details[id] : null;
    },
    media: async (digest: string) => {
      if (!DIGEST.test(digest)) return null;
      const value = await read();
      const urls = JSON.stringify([value.tickets.map((t) => t.captures), Object.values(value.details).map((d) => d.show)]);
      if (!urls.includes(`/media/${digest}`)) return null;
      try {
        const body = readFileSync(join(dir, 'snapshot-captures', digest));
        const mime = body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
          : body.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg' : null;
        return mime ? { mime, body } : null;
      } catch { return null; }
    },
    watch(onChange: () => void) {
      try { const watcher = watch(dir, (_, file) => { if (file === 'snapshot.json') onChange(); }); return () => watcher.close(); }
      catch { return () => {}; }
    },
  };
}
