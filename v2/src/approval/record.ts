// What ask-validation.ts keeps of a request for agreement
// (<state>/validations/<ticket>.json): the time of the request and the head
// of each pull request shown. The human's approval is to these versions and
// to nothing else (lib/validation-record.ts reads the same file).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Version = { readonly pr: number; readonly head: string };
export type ApprovalRecord = { readonly at: string; readonly versions: readonly Version[] };

const TICKET = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const HEAD = /^[0-9a-f]{40}$/;

export const byPr = (a: Version, b: Version) => a.pr - b.pr;

// As lib/validation-record.ts approvalOf: nothing is returned for a file
// that is not exactly what ask-validation.ts writes.
export function readApprovalRecord(stateDir: string, ticket: string): ApprovalRecord | undefined {
  if (!TICKET.test(ticket)) return undefined;
  try {
    const record = JSON.parse(readFileSync(join(stateDir, 'validations', `${ticket}.json`), 'utf8')) as { ticket?: unknown; at?: unknown; pulls?: unknown };
    const pulls = record.pulls;
    if (record.ticket !== ticket || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || !Array.isArray(pulls)
      || pulls.length === 0 || pulls.length > 8) return undefined;
    const versions: Version[] = [];
    for (const pull of pulls as { pr?: unknown; head?: unknown }[]) {
      if (typeof pull?.pr !== 'number' || !Number.isSafeInteger(pull.pr) || typeof pull.head !== 'string' || !HEAD.test(pull.head)) return undefined;
      versions.push({ pr: pull.pr, head: pull.head });
    }
    if (new Set(versions.map((v) => v.pr)).size !== versions.length) return undefined;
    return { at: record.at, versions: versions.sort(byPr) };
  } catch {
    return undefined;
  }
}

export function sameVersions(a: readonly Version[] | undefined, b: readonly Version[] | undefined): boolean {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x.pr === b[i]?.pr && x.head === b[i]?.head);
}

// The approval context local.ts binds a human's move to: the ticket, the
// time of the request and the shown versions, in pull request order.
export function approvalContext(ticket: string, at: string, versions: readonly Version[]): string {
  const shown = versions.map(({ pr, head }) => ({ pr, head })).sort(byPr);
  return createHash('sha256').update(JSON.stringify([ticket, at, shown])).digest('hex');
}
