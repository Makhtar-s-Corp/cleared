// A ticket's branch name (issues #508 and #510). A new install numbers its
// tickets from LOCAL-1, and a repository may already hold cleared/LOCAL-1 from
// another install: the push of a ticket on that name is refused, since nothing
// is ever forced, and only after the author and the reviewer were paid for.
//
// So the name is chosen once, when the ticket first starts, from what the remote
// holds, and kept here. A later round or a restart reads it back rather than
// asking the remote again: by then the branch on the remote is the ticket's own,
// and its open pull request is reused.
//
// The next names are cleared/<ticket>.2, .3 and so on. A ticket id holds no dot
// (workspace/checkout.ts), so none of them is another ticket's branch, and a
// resume's stays cleared/<ticket>.r<n>.
import type { DatabaseSync } from 'node:sqlite';
import { ticketBranch } from '../workspace/checkout.ts';

export const BRANCH_NAMES_TABLE = `CREATE TABLE IF NOT EXISTS ticket_branches (
  ticket TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL
)`;

// The first name of this ticket the remote does not hold. git cannot hold
// cleared/<ticket> beside a branch under cleared/<ticket>/, so one of those takes it.
export function freeBranch(ticket: string, taken: readonly string[]): string {
  const own = ticketBranch(ticket);
  const held = new Set(taken);
  if (!held.has(own) && !taken.some((name) => name.startsWith(`${own}/`))) return own;
  for (let n = 2; ; n += 1) if (!held.has(`${own}.${n}`)) return `${own}.${n}`;
}

// Whether a branch is one of this ticket's own names, as a checkout's HEAD may say it.
export const isTicketBranch = (ticket: string, branch: string): boolean => {
  const own = ticketBranch(ticket);
  return branch === own || new RegExp(`^${own.replace(/[-.]/g, '\\$&')}\\.(?:r?[0-9]+)$`).test(branch);
};

export class BranchNames {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(BRANCH_NAMES_TABLE);
  }

  get(ticket: string): string | undefined {
    const row = this.#db.prepare('SELECT branch FROM ticket_branches WHERE ticket = ?').get(ticket) as { branch: string } | undefined;
    return row?.branch;
  }

  keep(ticket: string, project: string, branch: string): void {
    this.#db.prepare('INSERT INTO ticket_branches (ticket, project, branch) VALUES (?, ?, ?) ON CONFLICT(ticket) DO NOTHING').run(ticket, project, branch);
  }
}
