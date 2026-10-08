#!/usr/bin/env node
// The parts of a go-live that are read and compared, never judged: which
// agreement a pull request needs from the files it touches, whether the user
// wrote his agreement in the form of before the statuses, and what a
// reviewer concluded. merge-pr.sh asks, and does the rest with git and gh.
//
//   merge.mjs needs <files.json> [<settings before> <settings after>]   tooling | agreement | guarded
//   merge.mjs line <comments.json> <agent ids.txt> <ticket> <pr opened at> [<pr>]   exit 0 when such a line exists
//   merge.mjs verdict <report.md>                          exit 0 when the reviewer concluded what [merge] verdict says
import { readFileSync } from 'node:fs';
import { loadConf, runAsCommand, section } from './conf.mjs';
import { readReport } from './reviews.mjs';

const list = (text) => (text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const under = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

// The sections of a settings file, each as its lines without comments or
// spacing. Read as text, on purpose: a file that no longer parses must still
// compare as changed.
function sectionsOf(text) {
  const sections = new Map();
  let name = '';
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) name = header[1];
    if (!sections.has(name)) sections.set(name, []);
    if (!header) sections.get(name).push(line.replace(/\s*=\s*/, ' = '));
  }
  return sections;
}

// The settings are one file for everything. What [merge] guarded_settings
// names is what this script reads and what holds a limit or a right the
// user set: a section (a name ending with a dot is a prefix), or one key of
// a section (section:key). A change there is a change to the lock, the rest
// is tooling.
export function guardedSettingsChanged(before, after, merge) {
  const guarded = list(merge.guarded_settings);
  const was = sectionsOf(before);
  const is = sectionsOf(after);
  const names = [...new Set([...was.keys(), ...is.keys()])];
  const same = (a, b) => (a ?? ['∅']).join('\n') === (b ?? ['∅']).join('\n');
  return guarded.some((entry) => {
    const colon = entry.indexOf(':');
    if (colon > 0) {
      const section = entry.slice(0, colon);
      const key = (lines) => (lines ?? []).filter((line) => line.startsWith(`${entry.slice(colon + 1)} = `));
      return !same(key(was.get(section)), key(is.get(section)));
    }
    return names.filter((name) => (entry.endsWith('.') ? name.startsWith(entry) : name === entry)).some((name) => !same(was.get(name), is.get(name)));
  });
}

// guarded: it touches the checks of the CI, the deployment, or the lock of
// the go-lives itself (this script, the one that speaks to Linear, the
// settings they read, the written rules of the user): his own agreement is
// needed whatever else it is, or a change could open the lock by itself.
// tooling: every file is invisible tooling, it ships once reviewed and
// green. agreement: anything else. The settings file is guarded unless its
// two versions are given and differ only outside the guarded sections.
export function agreementNeeded(files, merge, settings = null) {
  if (!files.length) return 'agreement';
  if (files.some((file) => under(file, list(merge.guarded_paths)))) return 'guarded';
  const settingsFile = (merge.settings_file ?? '').trim();
  const others = files.filter((file) => file !== settingsFile);
  if (settingsFile && others.length !== files.length && (!settings || guardedSettingsChanged(settings.before, settings.after, merge))) return 'guarded';
  return others.every((file) => under(file, list(merge.tooling_paths))) ? 'tooling' : 'agreement';
}

// A branch may be behind the base only on what is not code.
export const lagIsHarmless = (files, merge) => !files.some((file) => under(file, list(merge.code_paths)));

// « Fusion : SEE-12 », as the user wrote it before the statuses (Linear turns
// the ticket into a link). Written by him: from the account that owns the
// key (linear.sh comments says so), not marked as written by an agent, and
// not one of the comments the scripts posted. Linear cannot tell him from a
// program that acts under his account, so a line only counts if it was
// written, and last rewritten, before his statuses replaced the lines
// (rules.until: no line counts when it is not set), and after the pull
// request was opened: he agreed to what existed, not to what the same
// ticket would bring later. For a pull request that needs a line of its
// own, the line names it: « Fusion : SEE-12 #34 ».
export function fusionLine(comments, agentIds, ticket, pr = null, rules = {}) {
  const named = new RegExp(`^\\s*Fusion\\s*:\\s*(?:\\[${ticket}\\]\\([^)]*\\)|${ticket})(?![0-9])(.*)$`, 'm');
  const until = Date.parse(rules.until ?? '');
  const openedAt = Date.parse(rules.openedAt ?? '');
  if (Number.isNaN(until) || Number.isNaN(openedAt)) return false;
  return comments.some((comment) => {
    const body = comment.body ?? '';
    const written = Date.parse(comment.createdAt ?? '');
    if (comment.byOwner !== true || Number.isNaN(written) || written > until || written < openedAt) return false;
    if (comment.editedAt && !(Date.parse(comment.editedAt) <= until)) return false;
    if (agentIds.has(comment.id) || /^>\s*(Écrit par un agent|Ticket ouvert par un agent)/.test(body.trimStart()) || /^Chef de projet\s*:/.test(body.trimStart())) return false;
    const found = named.exec(body);
    return Boolean(found) && (pr == null || new RegExp(`#${pr}(?![0-9])`).test(found[1]));
  });
}

// The first word of the reviewer on the matter: « Verdict : … ».
export function verdictIs(reportText, expected) {
  const said = /^\**\s*Verdict\s*\**\s*:\s*\**\s*(.+)$/im.exec(readReport(reportText).body)?.[1] ?? '';
  return said.replace(/[*«»"]/g, '').trim().toLowerCase().startsWith(expected.trim().toLowerCase());
}

if (runAsCommand(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const merge = section(loadConf(), 'merge');
  if (command === 'needs') {
    const settings = rest[2] ? { before: readFileSync(rest[1], 'utf8'), after: readFileSync(rest[2], 'utf8') } : null;
    process.stdout.write(`${agreementNeeded(JSON.parse(readFileSync(rest[0], 'utf8')), merge, settings)}\n`);
  }
  else if (command === 'lag') process.exit(lagIsHarmless(JSON.parse(readFileSync(rest[0], 'utf8')), merge) ? 0 : 1);
  else if (command === 'line') {
    const agentIds = new Set();
    try { for (const line of readFileSync(rest[1], 'utf8').split('\n')) if (line.trim()) agentIds.add(line.trim()); } catch { /* none */ }
    process.exit(fusionLine(JSON.parse(readFileSync(rest[0], 'utf8')), agentIds, rest[2], rest[4] ? Number(rest[4]) : null, { until: merge.lines_until, openedAt: rest[3] }) ? 0 : 1);
  } else if (command === 'verdict') process.exit(verdictIs(readFileSync(rest[0], 'utf8'), merge.verdict ?? 'rien de bloquant') ? 0 : 1);
  else { process.stderr.write('usage: merge.mjs needs|lag|line|verdict …\n'); process.exit(64); }
}
