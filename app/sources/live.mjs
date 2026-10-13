// The app reads only the wake's complete board snapshot, the ledger health
// record, and locally cached captures. No tracker or forge code is imported.
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { loadConf, section, stateDir } from '../../lib/conf.mjs';
import { ledgerPath, openLedger } from '../../lib/ledger.mjs';
import { message } from '../../lib/i18n.mjs';
import { scrub } from '../../lib/board-scrub.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string';
const time = (value) => string(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const mediaUrl = (value) => string(value) && /^\/media\/[a-f0-9]{64}$/.test(value);
const validDetail = (detail) => record(detail) && string(detail.id) && string(detail.title)
  && string(detail.column) && string(detail.kind) && typeof detail.waiting === 'boolean'
  && Number.isFinite(detail.flightMinutes) && Number.isFinite(detail.quotaShare)
  && Array.isArray(detail.where) && detail.where.every(string)
  && Array.isArray(detail.squad) && detail.squad.every((entry) => record(entry)
    && string(entry.role) && string(entry.harness) && string(entry.model))
  && record(detail.show) && (
    detail.show.kind === 'screen'
      ? ['before', 'after'].every((side) => Array.isArray(detail.show[side])
        && detail.show[side].every((image) => record(image) && mediaUrl(image.url) && string(image.caption)))
      : detail.show.kind === 'code' && Array.isArray(detail.show.tests)
        && detail.show.tests.every((test) => record(test) && string(test.name) && string(test.change) && string(test.state))
        && (detail.show.example === null || record(detail.show.example)) && string(detail.show.touches))
  && Array.isArray(detail.blackBox) && detail.blackBox.every((event) => record(event)
    && time(event.at) && string(event.text) && string(event.stage) && record(event.raw));
export function validBoard(value) {
  return record(value) && value.schema === 1 && string(value.project)
    && Array.isArray(value.projects) && value.projects.every((project) => record(project) && string(project.id) && string(project.name))
    && ['en', 'fr'].includes(value.language) && time(value.generatedAt)
    && record(value.owner) && string(value.owner.name)
    && record(value.stats) && Number.isFinite(value.stats.inFlight)
    && (value.stats.firstTimeClean === null || Number.isFinite(value.stats.firstTimeClean))
    && Array.isArray(value.landed) && value.landed.every((row) => record(row) && time(row.at)
      && string(row.id) && string(row.title) && string(row.model) && string(row.harness)
      && Number.isFinite(row.fixes) && (row.rolledBackAt === null || time(row.rolledBackAt)) && Number.isFinite(row.share))
    && Array.isArray(value.fuel) && value.fuel.every((entry) => record(entry) && string(entry.adapter)
      && typeof entry.measured === 'boolean' && (!entry.measured || Number.isFinite(entry.left)))
    && Array.isArray(value.tickets) && record(value.details)
    && record(value.mode) && string(value.mode.short) && string(value.mode.label)
    && record(value.health) && Array.isArray(value.health.problems)
    && value.health.problems.every((entry) => record(entry) && string(entry.message))
    && value.tickets.every((ticket) => record(ticket) && /^[A-Za-z0-9._-]{1,40}$/.test(ticket.id)
      && string(ticket.title) && ['progress', 'checks', 'review', 'awaiting'].includes(ticket.column)
      && string(ticket.kind) && string(ticket.model) && string(ticket.statusLine)
      && Number.isFinite(ticket.flightMinutes) && Number.isFinite(ticket.quotaShare)
      && (ticket.captures === null || record(ticket.captures) && mediaUrl(ticket.captures.before) && mediaUrl(ticket.captures.after))
      && Object.hasOwn(value.details, ticket.id) && validDetail(value.details[ticket.id]))
    && Object.values(value.details).every(validDetail);
}
export function liveSource({ conf = loadConf(), now = () => Date.now(), dir = stateDir() } = {}) {
  const language = section(conf, 'owner').language || 'en';
  const interval = Number(section(conf, 'heartbeat').wake_interval_minutes) || 1;
  const path = join(dir, 'snapshot.json');
  let cached, signature = '';
  const safeName = (value) => scrub(value, 60);
  const problem = (code, key, values = {}) => ({ code, message: message(key, language, values) });
  function health() {
    let db;
    try {
      db = openLedger(ledgerPath(), { readOnly: true });
      const get = (key) => { try { return db.prepare('SELECT value FROM heartbeat_state WHERE key = ?').get(key)?.value || null; } catch { return null; } };
      const lastWakeRaw = get('last_wake_at');
      const lastWake = lastWakeRaw && /^\d{4}-\d{2}-\d{2}T/.test(lastWakeRaw) && Number.isFinite(Date.parse(lastWakeRaw)) ? lastWakeRaw : null;
      const age = lastWake ? now() - Date.parse(lastWake) : null;
      const problems = [];
      if (!lastWake) problems.push(problem('wake_missing', 'app_srv_problem_wake_missing'));
      else if (age > 3 * interval * 60000) problems.push(problem('wake_late', 'app_srv_problem_wake_late', { minutes: Math.floor(age / 60000) }));
      else if (get('last_wake_ok') === 'false') problems.push(problem('wake_failed', 'app_srv_problem_wake_failed'));
      let incidents = [];
      try { incidents = db.prepare('SELECT id FROM heartbeat_incidents WHERE active = 1 ORDER BY first_seen').all(); } catch { /* no incidents yet */ }
      for (const { id } of incidents) {
        const [rawCode, ...rest] = String(id).split(':');
        const code = safeName(rawCode);
        if (['wake_late', 'wake_missing', 'wake_failed'].includes(code)) continue;
        let text;
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
      const key = error?.code === 'ENOENT' ? 'app_snapshot_missing' : error?.message === 'version' ? 'app_snapshot_version' : 'app_snapshot_unreadable';
      cached = { schema: 1, project: '', projects: [], language, generatedAt: null, owner: { name: '' },
        stats: { inFlight: 0, firstTimeClean: null }, landed: [], fuel: [], tickets: [], details: {},
        mode: { key: '', short: '', label: '' }, health: { ok: false, problems: [problem('snapshot_invalid', key)], recordedAt: null } };
      signature = '';
    }
    const value = structuredClone(cached);
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
    ticket: async (id) => {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
      const details = read().details;
      return Object.hasOwn(details, id) ? details[id] : null;
    },
    media: async (digest) => {
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
    watch(onChange) {
      try { const watcher = watch(dir, (_, file) => { if (file === 'snapshot.json') onChange(); }); return () => watcher.close(); }
      catch { return () => {}; }
    },
  };
}
