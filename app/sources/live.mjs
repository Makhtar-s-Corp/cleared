// The app reads only the wake's complete board snapshot, the ledger health
// record, and locally cached captures. No tracker or forge code is imported.
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { loadConf, section, stateDir } from '../../lib/conf.mjs';
import { ledgerPath, openLedger } from '../../lib/ledger.mjs';
import { message } from '../../lib/i18n.mjs';
import { scrub } from '../../lib/board-scrub.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
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
      const lastWake = get('last_wake_at');
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
        if (value.schema !== 1 || !Array.isArray(value.tickets) || !value.details || !Array.isArray(value.landed) || !Array.isArray(value.fuel))
          throw new Error('version');
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
