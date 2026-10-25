import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCH_HOME, loadConf } from '../../conf.ts';
import { LocalTracker } from './local.ts';
import { GithubTracker } from './github.ts';
import type { ConfSections } from '../../conf.ts';
import type { LocalTrackerOptions } from './local.ts';
import type { GithubTrackerOptions } from './github.ts';
import type { Identity, LabelActors, NewTicket, StatusChange, Ticket, TicketChange, TicketComment, TicketTracker } from '../contract.ts';

export type TrackerOptions = Omit<LocalTrackerOptions, 'conf'> & Omit<GithubTrackerOptions, 'conf'>;

const parse = <T>(text: string): T => JSON.parse(text) as T;
class ShellTracker {
  conf: ConfSections;
  path: string;
  constructor(conf: ConfSections) { this.conf = conf; this.path = join(ORCH_HOME, 'lib/tracker/adapters/linear.ts'); }
  run(...args: string[]): string { return execFileSync(this.path, args, { encoding: 'utf8' }).trim(); }
  downloadCapture(url: string): Buffer { return execFileSync(this.path, ['download-capture', url], { timeout: 20000, maxBuffer: 5_100_000 }); }
  listTickets({ status }: { status?: string }): Ticket[] { return parse<Ticket[]>(this.run('list', status as string)); }
  getTicket(id: string): Ticket {
    const ticket = parse<Ticket>(this.run('issue', id));
    return { ...ticket, status: ticket.state, body: ticket.description };
  }
  createTicket({ title, body = '', labels = [], project }: NewTicket): Ticket {
    const settings = this.conf.sections.tracker || {};
    const targetProject = project || settings.create_project;
    const label = labels[0] || settings.create_label;
    if (!targetProject || !label) throw new Error('Linear ticket creation requires [tracker] create_project and create_label, or an explicit project and label');
    const dir = mkdtempSync(join(tmpdir(), 'cleared-ticket-'));
    try { const path = join(dir, 'body'); writeFileSync(path, body); const [id] = this.run('create', targetProject, label, title, path).split(/\s+/); return this.getTicket(id!); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  moveTicket(id: string, status: string): Ticket { this.run('move', id, status); return this.getTicket(id); }
  history(id: string): StatusChange[] { return parse<StatusChange[]>(this.run('history', id)); }
  labelActors(id: string): LabelActors { return parse<LabelActors>(this.run('label-actors', id)); }
  comments(id: string, { since }: { since?: string } = {}): TicketComment[] { const list = parse<TicketComment[]>(this.run('comments', id)); return since ? list.filter((item) => item.createdAt > since || (item.editedAt as string) > since) : list; }
  comment(id: string, body: string, { images = [] }: { images?: string[] } = {}): TicketComment | { url: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-comment-'));
    try { const path = join(dir, 'body'); writeFileSync(path, `${body}${images.map((image) => `\n![capture](${this.run('upload', image)})`).join('')}`); const url = this.run('comment', id, path); return this.comments(id).find((item) => item.url === url) || { url }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  editComment(id: string, commentId: string, body: string): TicketComment | undefined {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-edit-'));
    try { const path = join(dir, 'body'); writeFileSync(path, body); this.run('edit-comment', id, commentId, path); return this.comments(id).find((item) => item.id === commentId); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  whoAmI(): Identity { const id = this.run('identity'); return { kind: id === 'app' ? 'agents' : 'shared', id }; }
  changesSince(cursor?: string): { events: TicketChange[]; cursor: string } { const readAt = new Date().toISOString(); return { events: parse<TicketChange[]>(this.run('changes', cursor || '1970-01-01T00:00:00Z')), cursor: readAt }; }
}

export function createTracker(conf: ConfSections = loadConf(), options: TrackerOptions = {}): TicketTracker {
  const adapter = conf.sections.tracker?.adapter;
  switch (adapter) {
    case 'linear': return new ShellTracker(conf);
    case 'github': return new GithubTracker({ conf, ...options });
    case 'local': return new LocalTracker({ conf, ...options });
    default: throw new Error('Missing or invalid [tracker] adapter (linear | github | local)');
  }
}
