// The record ask-validation.sh keeps of what the user was shown when asked for
// his agreement: the version (commit) of each pull request. His agreement is to
// these versions and to nothing else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './conf.mjs';

export function approvalOf(ref, dir = stateDir()) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(String(ref))) return null;
  try {
    const record = JSON.parse(readFileSync(join(dir, 'validations', `${ref}.json`), 'utf8'));
    if (record.ticket !== ref || !Number.isFinite(Date.parse(record.at)) || !Array.isArray(record.pulls) || !record.pulls.length || record.pulls.length > 8
      || new Set(record.pulls.map((pull) => pull.pr)).size !== record.pulls.length
      || record.pulls.some((pull) => !Number.isSafeInteger(pull.pr) || !/^[0-9a-f]{40}$/.test(pull.head))) return null;
    return { at: record.at, versions: record.pulls.map(({ pr, head }) => ({ pr, head })).sort((a, b) => a.pr - b.pr) };
  } catch { return null; }
}
export const sameVersions = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((x, i) => x?.pr === b[i]?.pr && x?.head === b[i]?.head);
