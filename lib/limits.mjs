// Where a subscription stands, as the sessions themselves say it.
//
// A backend that runs on a subscription may say, with the usage of each
// session, how much of each of its windows is used and when the window starts
// over (`limits` in the usage file: {windows: {<name>: {used: <percent>,
// resets_at: <ISO time>}}, beyond: <what happens past the limit>}). Nothing is
// asked for it: a reading costs nothing. The readings are kept, one line each,
// per adapter, in state/limits/<adapter>.jsonl.
//
//   limits.mjs note <adapter> <usage file>   keeps the reading of a session, if it gave one
//   limits.mjs reached <adapter>             exit 0 and "<window> <used> <resets at>" when a window
//                                            is at or over [limits] subscription_stop; exit 1 otherwise
//   limits.mjs summary                       every adapter that said something, as JSON (the dashboard, the digest)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConf, section, stateDir, runAsCommand } from './conf.mjs';

const round1 = (value) => Math.round(value * 10) / 10;

// summary(history, now, stop, dayStart): for each window that has not started
// over since it was last read: the percent used, the points the day took (from
// the last reading before the day began, or the first of the day), the pace in
// points an hour over the last three hours, the hours left at that pace before
// the stop and before the limit, and whether the stop is reached. A window
// read once has no pace; a project that names no stop is never stopped.
export function summary(history, nowMs, stop, dayStartMs) {
  const out = {};
  const names = new Set(history.flatMap((row) => Object.keys(row.windows ?? {})));
  for (const name of names) {
    const all = history.filter((row) => row.windows?.[name]).sort((a, b) => a.at.localeCompare(b.at));
    const last = all.at(-1);
    const window = last.windows[name];
    if (Date.parse(window.resets_at) <= nowMs) continue;
    const rows = all.filter((row) => row.windows[name].resets_at === window.resets_at);
    const used = window.used;
    const before = rows.filter((row) => Date.parse(row.at) < dayStartMs).at(-1);
    const base = before ?? rows.find((row) => Date.parse(row.at) >= dayStartMs) ?? last;
    const recent = rows.filter((row) => Date.parse(row.at) >= nowMs - 3 * 3600e3);
    const hours = recent.length > 1 ? (Date.parse(recent.at(-1).at) - Date.parse(recent[0].at)) / 3600e3 : 0;
    const pace = hours >= 0.25 ? round1((recent.at(-1).windows[name].used - recent[0].windows[name].used) / hours) : null;
    const left = (target) => (target != null && pace > 0 && used < target ? Math.round((target - used) / pace) : null);
    out[name] = {
      used, resets_at: window.resets_at, read_at: last.at,
      today: used - base.windows[name].used,
      pace, hours_to_stop: left(stop), hours_to_full: left(100),
      stopped: stop != null && used >= stop,
    };
  }
  return out;
}

function historyOf(adapter) {
  const file = join(stateDir(), 'limits', `${adapter}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function stopOf(conf) {
  const stop = Number(section(conf, 'limits').subscription_stop);
  return Number.isFinite(stop) && stop > 0 ? stop : null;
}

function dayStart(nowMs) {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

if (runAsCommand(import.meta.url)) {
  const [command, adapter, file] = process.argv.slice(2);
  const now = Date.now();
  if (command === 'note') {
    let limits = null;
    try { limits = JSON.parse(readFileSync(file, 'utf8')).limits ?? null; } catch { /* no usage, no reading */ }
    const windows = Object.fromEntries(Object.entries(limits?.windows ?? {}).filter(([, window]) => Number.isFinite(window?.used) && !Number.isNaN(Date.parse(window?.resets_at))));
    if (Object.keys(windows).length) {
      const dir = join(stateDir(), 'limits');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${adapter}.jsonl`);
      appendFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString(), windows, beyond: limits.beyond ?? null })}\n`);
      // Kept for a while, not for ever.
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 4000) writeFileSync(path, `${lines.slice(-2000).join('\n')}\n`);
    }
  } else if (command === 'reached') {
    const stop = stopOf(loadConf());
    const over = Object.entries(summary(historyOf(adapter), now, stop, dayStart(now))).filter(([, window]) => window.stopped).sort((a, b) => b[1].used - a[1].used)[0];
    if (!over) process.exit(1);
    console.log(`${over[0]}\t${over[1].used}\t${over[1].resets_at}\t${stop}`);
  } else if (command === 'summary') {
    const conf = loadConf();
    const stop = stopOf(conf);
    const dir = join(stateDir(), 'limits');
    const adapters = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -6)) : [];
    console.log(JSON.stringify(adapters.map((name) => ({ adapter: name, stop, windows: summary(historyOf(name), now, stop, dayStart(now)) })).filter((one) => Object.keys(one.windows).length)));
  } else {
    console.error('usage: limits.mjs note <adapter> <usage file> | reached <adapter> | summary');
    process.exit(64);
  }
}
