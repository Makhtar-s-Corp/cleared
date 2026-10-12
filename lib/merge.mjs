#!/usr/bin/env node
// The parts of a go-live that are read and compared, never judged: which
// agreement a pull request needs from the files it touches, whether the user
// wrote his agreement in the form of before the statuses, and what a
// reviewer concluded. merge-pr.sh asks, and does the rest with git and gh.
//
//   merge.mjs needs <files.json>                           tooling | agreement | guarded
//   merge.mjs line <comments.json> <agent ids.txt> <ticket> <pr opened at> [<pr>]   exit 0 when such a line exists
//   merge.mjs verdict <report.md>                          exit 0 when the reviewer concluded what [merge] verdict says
import { readFileSync } from 'node:fs';
import { loadConf, requireSetting, runAsCommand, section } from './conf.mjs';
import { readReport } from './reviews.mjs';

const list = (text) => (text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const under = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

// tooling: every file is invisible tooling, it ships once reviewed and
// green. guarded: one file at least touches the checks of the CI, the
// deployment, the written rules of the user or the lock of the go-lives
// (this script and all it runs or reads to decide): his own agreement is
// needed whatever else it is, or a change could open the lock by itself.
// agreement: anything else. Of two prefixes that hold a file, the longer one
// says what it is: a manual inside a guarded folder may be tooling, a script
// inside a folder of tooling may be guarded.
export function agreementNeeded(files, merge) {
  if (!files.length) return 'agreement';
  const prefixes = [...list(merge.guarded_paths).map((prefix) => ({ prefix, kind: 'guarded' })), ...list(merge.tooling_paths).map((prefix) => ({ prefix, kind: 'tooling' }))];
  // What ships by itself is named exactly: a file is that file, only a name
  // ending with a slash is a folder. What is guarded stays a beginning.
  const holds = ({ prefix, kind }, file) => (kind === 'tooling' && !prefix.endsWith('/') ? file === prefix : file.startsWith(prefix));
  const kinds = files.map((file) => prefixes.filter((entry) => holds(entry, file)).sort((a, b) => b.prefix.length - a.prefix.length || (a.kind === 'guarded' ? -1 : 1))[0]?.kind ?? 'agreement');
  if (kinds.includes('guarded')) return 'guarded';
  return kinds.every((kind) => kind === 'tooling') ? 'tooling' : 'agreement';
}

// A branch may be behind the base only on what is not code.
export const lagIsHarmless = (files, merge) => !files.some((file) => under(file, list(merge.code_paths)));

// « Fusion : EX-12 », as the user wrote it before the statuses (tracker turns
// the ticket into a link). Written by him: from the account that owns the
// key (tracker.sh comments says so), not marked as written by an agent, and
// not one of the comments the scripts posted. tracker cannot tell him from a
// program that acts under his account, so a line only counts if it was
// written, and last rewritten, before his statuses replaced the lines
// (rules.until: no line counts when it is not set), and after the pull
// request was opened: he agreed to what existed, not to what the same
// ticket would bring later. For a pull request that needs a line of its
// own, the line names it: “Merge: EX-12 #34”.
export function legacyMergeApprovalLine(comments, agentIds, ticket, pr = null, rules = {}) {
  const named = new RegExp(`^\\s*(?:Fusion|Merge)\\s*:\\s*(?:\\[${ticket}\\]\\([^)]*\\)|${ticket})(?![0-9])(.*)$`, 'mi');
  const until = Date.parse(rules.until ?? '');
  const openedAt = Date.parse(rules.openedAt ?? '');
  if (Number.isNaN(until) || Number.isNaN(openedAt)) return false;
  return comments.some((comment) => {
    const body = comment.body ?? '';
    const written = Date.parse(comment.createdAt ?? '');
    if (comment.byOwner !== true || Number.isNaN(written) || written > until || written < openedAt) return false;
    if (comment.editedAt && !(Date.parse(comment.editedAt) <= until)) return false;
    if (agentIds.has(comment.id) || /^>\s*(Écrit par un agent|Ticket ouvert par un agent|Written by an agent|Ticket opened by an agent)/.test(body.trimStart()) || /^(?:Chef de projet|Project lead)\s*:/.test(body.trimStart())) return false;
    const found = named.exec(body);
    return Boolean(found) && (pr == null || new RegExp(`#${pr}(?![0-9])`).test(found[1]));
  });
}
export const fusionLine = legacyMergeApprovalLine;

// The first word of the reviewer on the matter: « Verdict : … ».
export function verdictIs(reportText, expected) {
  const said = /^\**\s*Verdict\s*\**\s*:\s*\**\s*(.+)$/im.exec(readReport(reportText).body)?.[1] ?? '';
  const normalized = said.replace(/[*«»"]/g, '').trim().toLowerCase();
  const wanted = expected.trim().toLowerCase();
  const noBlocking = /^(?:no blocking issues|rien de bloquant)/;
  return noBlocking.test(wanted) ? noBlocking.test(normalized) : normalized.startsWith(wanted);
}

if (runAsCommand(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const merge = section(loadConf(), 'merge');
  if (command === 'needs') process.stdout.write(`${agreementNeeded(JSON.parse(readFileSync(rest[0], 'utf8')), merge)}\n`);
  else if (command === 'lag') process.exit(lagIsHarmless(JSON.parse(readFileSync(rest[0], 'utf8')), merge) ? 0 : 1);
  else if (command === 'line') {
    const agentIds = new Set();
    try { for (const line of readFileSync(rest[1], 'utf8').split('\n')) if (line.trim()) agentIds.add(line.trim()); } catch { /* none */ }
    process.exit(legacyMergeApprovalLine(JSON.parse(readFileSync(rest[0], 'utf8')), agentIds, rest[2], rest[4] ? Number(rest[4]) : null, { until: merge.lines_until, openedAt: rest[3] }) ? 0 : 1);
  } else if (command === 'verdict') process.exit(verdictIs(readFileSync(rest[0], 'utf8'), requireSetting(loadConf(), 'merge', 'verdict')) ? 0 : 1);
  else { process.stderr.write('usage: merge.mjs needs|lag|line|verdict …\n'); process.exit(64); }
}
