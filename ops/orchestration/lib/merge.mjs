#!/usr/bin/env node
// The parts of a go-live that are read and compared, never judged: which
// agreement a pull request needs from the files it touches, whether the user
// wrote his agreement in the form of before the statuses, and what a
// reviewer concluded. merge-pr.sh asks, and does the rest with git and gh.
//
//   merge.mjs needs <files.json>                           tooling | agreement | guarded
//   merge.mjs line <comments.json> <agent ids.txt> <ticket> [<pr>]     exit 0 when such a line exists
//   merge.mjs verdict <report.md>                          exit 0 when the reviewer concluded what [merge] verdict says
import { readFileSync } from 'node:fs';
import { loadConf, runAsCommand, section } from './conf.mjs';
import { readReport } from './reviews.mjs';

const list = (text) => (text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const under = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

// guarded: it touches the checks of the CI or the deployment, the user's own
// agreement is needed whatever else it is. tooling: every file is invisible
// tooling, it ships once reviewed and green. agreement: anything else.
export function agreementNeeded(files, merge) {
  if (!files.length) return 'agreement';
  if (files.some((file) => under(file, list(merge.guarded_paths)))) return 'guarded';
  return files.every((file) => under(file, list(merge.tooling_paths))) ? 'tooling' : 'agreement';
}

// A branch may be behind the base only on what is not code.
export const lagIsHarmless = (files, merge) => !files.some((file) => under(file, list(merge.code_paths)));

// « Fusion : SEE-12 », as the user wrote it before the statuses (Linear turns
// the ticket into a link). Written by him: not marked as written by an
// agent, and not one of the comments the scripts posted. For a pull request
// that needs a line of its own, the line names it: « Fusion : SEE-12 #34 ».
export function fusionLine(comments, agentIds, ticket, pr = null) {
  const named = new RegExp(`^\\s*Fusion\\s*:\\s*(?:\\[${ticket}\\]\\([^)]*\\)|${ticket})(?![0-9])(.*)$`, 'm');
  return comments.some((comment) => {
    const body = comment.body ?? '';
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
  if (command === 'needs') process.stdout.write(`${agreementNeeded(JSON.parse(readFileSync(rest[0], 'utf8')), merge)}\n`);
  else if (command === 'lag') process.exit(lagIsHarmless(JSON.parse(readFileSync(rest[0], 'utf8')), merge) ? 0 : 1);
  else if (command === 'line') {
    const agentIds = new Set();
    try { for (const line of readFileSync(rest[1], 'utf8').split('\n')) if (line.trim()) agentIds.add(line.trim()); } catch { /* none */ }
    process.exit(fusionLine(JSON.parse(readFileSync(rest[0], 'utf8')), agentIds, rest[2], rest[3] ? Number(rest[3]) : null) ? 0 : 1);
  } else if (command === 'verdict') process.exit(verdictIs(readFileSync(rest[0], 'utf8'), merge.verdict ?? 'rien de bloquant') ? 0 : 1);
  else { process.stderr.write('usage: merge.mjs needs|lag|line|verdict …\n'); process.exit(64); }
}
