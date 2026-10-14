// The team's report to the user, for the body of the pull request push-lane.sh
// opens: the text between "## Report" and "## Changed files" of the run's
// report (sections Done, Remaining work, Questions for the user), as the team
// wrote it, in its language. What names this machine is taken out: a path
// from the root or the home folder, and anything shaped like a token. The
// guard of the repository reads the whole body afterwards, like everything
// that leaves.
//
//   node lib/pr-body.mjs <report file>     prints the text, or nothing
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportBody } from './board-report.mjs';

const MAX_LINES = 80, MAX_CHARS = 6000;
export function prReport(text) {
  const all = String(text ?? '');
  const body = /^## (?:Report|Compte rendu)[ \t]*$/m.test(all) ? reportBody(all) : all.trim();
  const clean = body
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/!\[[^\]\n]*\]\((?:\/|~\/|file:)[^)\n]*\)/g, '')
    .replace(/(?:~\/|(?<![\w.~:/\]-])\/)[^\s'"`)\]]+/g, '[path]')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (word) => (/^[0-9a-f]{40}$/.test(word) ? word : '[secret]'));
  const lines = clean.split('\n');
  const kept = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_CHARS).trim();
  return kept.length < clean.trim().length ? `${kept}\n\n…` : kept;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(prReport(readFileSync(process.argv[2], 'utf8'))); } catch { /* no report: nothing */ }
}
