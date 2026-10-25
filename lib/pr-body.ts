// The team's report to the user, for the body of the pull request push-lane.sh
// opens: the text between "## Report" and "## Changed files" of the run's
// report (sections Done, Remaining work, Questions for the user), as the team
// wrote it, in its language. What names this machine is taken out: the
// folders of Cleared, the project, its state and its lanes, the home folder,
// the usual system roots, and anything shaped like a token. A route of the
// application ("the /invoices page", "/api/users") stays. The guard of the
// repository reads the whole body afterwards, like everything that leaves.
//
//   node lib/pr-body.ts <report file>     prints the text, or nothing
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reportBody } from './board-report.ts';
import { ORCH_HOME, expandHome, loadConf, projectDir, section, stateDir } from './conf.ts';

// The roots under which a path names a machine, never an application route.
export const SYSTEM_ROOTS = ['/home/', '/root/', '/srv/', '/tmp/', '/var/', '/etc/', '/opt/', '/usr/', '/mnt/', '/proc/', '/run/'];
// The folders of this installation, as given and as resolved: Cleared, the project, its state, its lanes, the home folder.
export function machineFolders() {
  const out = new Set();
  const add = (path) => {
    if (!path || typeof path !== 'string' || !path.startsWith('/') || path === '/') return;
    out.add(path.replace(/\/+$/, ''));
    try { out.add(realpathSync(path).replace(/\/+$/, '')); } catch { /* not there: as given */ }
  };
  add(ORCH_HOME); add(homedir());
  for (const read of [() => projectDir(), () => stateDir(), () => expandHome(section(loadConf(), 'lanes').root)]) {
    try { add(read()); } catch { /* not configured here */ }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_LINES = 80, MAX_CHARS = 6000;
export function prReport(text, { folders = machineFolders() } = {}) {
  const all = String(text ?? '');
  // A folder of this machine, alone or followed by more of its path; a system root with its slash.
  const roots = [...folders.map((f) => `${escape(f)}(?![\\w.-])`), ...SYSTEM_ROOTS.map(escape)].join('|');
  // The same folders reached by climbing out of a worktree: ../../<name of the checkout>/…
  const names = [...new Set(folders.map((f) => f.split('/').pop()).filter((n) => n && n.length >= 3))];
  const climbs = names.length ? `|(?:\\.\\./)+(?:${names.map(escape).join('|')})(?![\\w.-])` : '';
  // A path that starts with one of them, with ~/, or a file:// address (always a file of some machine), up to the next blank or closing mark.
  const machine = new RegExp(`(?:\\bfile://|~/|(?<![\\w.~:/\\]-])(?:${roots}${climbs}))[^\\s'"\`)\\]]*`, 'gi');
  const body = /^## (?:Report|Compte rendu)[ \t]*$/m.test(all) ? reportBody(all) : all.trim();
  const clean = body
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/!\[[^\]\n]*\]\((?:\/|~\/|file:)[^)\n]*\)/g, '')
    .replace(machine, (path) => `[path]${/[,.;:!?]+$/.exec(path)?.[0] ?? ''}`)
    // A JSON Web Token is one secret: header, payload and signature together.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[secret]')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (word) => (/^[0-9a-f]{40}$/.test(word) ? word : '[secret]'));
  const lines = clean.split('\n');
  const kept = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_CHARS).trim();
  return kept.length < clean.trim().length ? `${kept}\n\n…` : kept;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(prReport(readFileSync(process.argv[2], 'utf8'))); } catch { /* no report: nothing */ }
}
