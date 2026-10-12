import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCH_HOME, loadConf } from '../../conf.mjs';
import { LocalTracker } from './local.mjs';
import { GithubTracker } from './github.mjs';

const parse = (text) => JSON.parse(text);
class ShellTracker {
  constructor(conf) { this.conf = conf; this.path = join(ORCH_HOME, 'lib/tracker/adapters/linear.sh'); }
  run(...args) { return execFileSync(this.path, args, { encoding: 'utf8' }).trim(); }
  listTickets({ status }) { return parse(this.run('list', status)); }
  getTicket(id) {
    const ticket = parse(this.run('issue', id));
    return { ...ticket, status: ticket.state, body: ticket.description };
  }
  createTicket({ title, body = '', labels = [], project }) {
    const settings = this.conf.sections.tracker || {};
    const targetProject = project || settings.create_project;
    const label = labels[0] || settings.create_label;
    if (!targetProject || !label) throw new Error('Linear ticket creation requires [tracker] create_project and create_label, or an explicit project and label');
    const dir = mkdtempSync(join(tmpdir(), 'cleared-ticket-'));
    try { const path = join(dir, 'body'); writeFileSync(path, body); const [id] = this.run('create', targetProject, label, title, path).split(/\s+/); return this.getTicket(id); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  moveTicket(id, status) { this.run('move', id, status); return this.getTicket(id); }
  history(id) { return parse(this.run('history', id)); }
  comments(id, { since } = {}) { const list = parse(this.run('comments', id)); return since ? list.filter((item) => item.createdAt > since || item.editedAt > since) : list; }
  comment(id, body, { images = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-comment-'));
    try { const path = join(dir, 'body'); writeFileSync(path, `${body}${images.map((image) => `\n![capture](${this.run('upload', image)})`).join('')}`); const url = this.run('comment', id, path); return this.comments(id).find((item) => item.url === url) || { url }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  editComment(id, commentId, body) {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-edit-'));
    try { const path = join(dir, 'body'); writeFileSync(path, body); this.run('edit-comment', id, commentId, path); return this.comments(id).find((item) => item.id === commentId); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  whoAmI() { const id = this.run('identity'); return { kind: id === 'app' ? 'agents' : 'shared', id }; }
  changesSince(cursor) { const readAt = new Date().toISOString(); return { events: parse(this.run('changes', cursor || '1970-01-01T00:00:00Z')), cursor: readAt }; }
}

export function createTracker(conf = loadConf(), options = {}) {
  const adapter = conf.sections.tracker?.adapter;
  switch (adapter) {
    case 'linear': return new ShellTracker(conf);
    case 'github': return new GithubTracker({ conf, ...options });
    case 'local': return new LocalTracker({ conf, ...options });
    default: throw new Error('Missing or invalid [tracker] adapter (linear | github | local)');
  }
}
