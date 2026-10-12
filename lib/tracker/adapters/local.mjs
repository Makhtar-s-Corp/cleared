import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { createPublicKey, sign, verify } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from '../../conf.mjs';
import { openLedger } from '../../ledger.mjs';
import { createHash } from 'node:crypto';
import { checkedImage } from '../images.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracker_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  labels TEXT NOT NULL, project TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, status TEXT NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, at TEXT NOT NULL
  , proof TEXT, approval_context TEXT
);
CREATE TABLE IF NOT EXISTS tracker_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, body TEXT NOT NULL,
  images TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL, edited_at TEXT, proof TEXT
);
CREATE INDEX IF NOT EXISTS tracker_tickets_status ON tracker_tickets(status);
CREATE INDEX IF NOT EXISTS tracker_history_ticket ON tracker_history(ticket, id);
CREATE INDEX IF NOT EXISTS tracker_comments_ticket ON tracker_comments(ticket, id);
CREATE TABLE IF NOT EXISTS tracker_images (
  digest TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL
);
`;
const now = () => new Date().toISOString();
const ticketNumber = (id) => {
  const match = /^(?:LOCAL-)?([1-9][0-9]*)$/.exec(String(id));
  if (!match) throw new Error(`Invalid local ticket: ${id}`);
  return Number(match[1]);
};

export class LocalTracker {
  constructor({ conf, db = openLedger(), actor, approvalDir = join(stateDir(), 'validations') } = {}) {
    this.conf = conf;
    this.db = db;
    this.db.exec(SCHEMA);
    if (!this.db.prepare('PRAGMA table_info(tracker_history)').all().some((column) => column.name === 'proof'))
      this.db.exec('ALTER TABLE tracker_history ADD COLUMN proof TEXT');
    if (!this.db.prepare('PRAGMA table_info(tracker_history)').all().some((column) => column.name === 'approval_context'))
      this.db.exec('ALTER TABLE tracker_history ADD COLUMN approval_context TEXT');
    if (!this.db.prepare('PRAGMA table_info(tracker_comments)').all().some((column) => column.name === 'proof'))
      this.db.exec('ALTER TABLE tracker_comments ADD COLUMN proof TEXT');
    // Production identity comes only from the operating system. Injecting an
    // actor is reserved for in-process tests; the CLI never accepts one.
    const name = userInfo().username;
    const agentUid = conf?.sections?.tracker?.agents_uid;
    const owner = conf?.sections?.tracker?.owner_id;
    if (!actor && (!agentUid || !owner)) throw new Error('Local tracking requires [tracker] agents_uid and owner_id for separate accounts');
    if (!actor && String(process.getuid()) === agentUid && name === owner) throw new Error('Agent and human accounts must be separate');
    this.actor = actor ?? (agentUid && String(process.getuid()) === agentUid
      ? { kind: 'agents', id: name }
      : owner && name === owner && (!agentUid || String(process.getuid()) !== agentUid)
        ? { kind: 'human', id: name }
        : { kind: 'shared', id: name });
    this.approvalDir = approvalDir;
  }
  whoAmI() { return this.actor; }
  approvalContext(id) {
    const ticket = `LOCAL-${ticketNumber(id)}`;
    let record;
    try { record = JSON.parse(readFileSync(join(this.approvalDir, `${ticket}.json`), 'utf8')); }
    catch { return null; }
    if (record.ticket !== ticket || !Number.isFinite(Date.parse(record.at)) || !Array.isArray(record.pulls) || !record.pulls.length
      || record.pulls.some((pull) => !Number.isSafeInteger(pull.pr) || !/^[0-9a-f]{40}$/.test(pull.head))) return null;
    const versions = record.pulls.map(({ pr, head }) => ({ pr, head })).sort((a, b) => a.pr - b.pr);
    return createHash('sha256').update(JSON.stringify([ticket, record.at, versions])).digest('hex');
  }
  proof(ticket, status, at, approvalContext = null) {
    if (this.actor.kind !== 'human') return null;
    const path = this.conf?.sections?.tracker?.human_private_key;
    if (!path) throw new Error('Local human actions require [tracker] human_private_key');
    const payload = JSON.stringify([Number(ticket), status, at, this.actor.id, approvalContext]);
    return sign(null, Buffer.from(payload), readFileSync(path)).toString('base64');
  }
  verifiedKind(row, ticket) {
    if (row.actor_kind !== 'human') return row.actor_kind === 'agents' ? 'agents' : 'other';
    const publicKey = this.conf?.sections?.tracker?.human_public_key;
    if (!publicKey || !row.proof) return 'other';
    const payload = JSON.stringify([Number(ticket), row.status, row.at, row.actor_id, row.approval_context]);
    try { return verify(null, Buffer.from(payload), createPublicKey(Buffer.from(publicKey, 'base64')),
      Buffer.from(row.proof, 'base64')) ? 'human' : 'other'; }
    catch { return 'other'; }
  }
  commentProof(ticket, body, at, images = '[]') {
    if (this.actor.kind !== 'human') return null;
    const path = this.conf?.sections?.tracker?.human_private_key;
    if (!path) throw new Error('Local human actions require [tracker] human_private_key');
    return sign(null, Buffer.from(JSON.stringify(['comment', Number(ticket), body, images, at, this.actor.id])), readFileSync(path)).toString('base64');
  }
  verifiedCommentKind(row, ticket) {
    if (row.actor_kind !== 'human') return row.actor_kind === 'agents' ? 'agents' : 'other';
    const publicKey = this.conf?.sections?.tracker?.human_public_key;
    if (!publicKey || !row.proof) return 'other';
    const payload = JSON.stringify(['comment', ticketNumber(ticket), row.body, row.images, row.edited_at || row.created_at, row.actor_id]);
    try { return verify(null, Buffer.from(payload), createPublicKey(Buffer.from(publicKey, 'base64')),
      Buffer.from(row.proof, 'base64')) ? 'human' : 'other'; }
    catch { return 'other'; }
  }
  ticket(row) {
    if (!row) return null;
    return { id: String(row.id), identifier: `LOCAL-${row.id}`, title: row.title,
      description: row.body, body: row.body, labels: JSON.parse(row.labels), project: row.project,
      state: row.status, status: row.status, createdAt: row.created_at,
      updatedAt: row.updated_at, url: `local://ticket/${row.id}` };
  }
  listTickets({ status } = {}) {
    return (status ? this.db.prepare('SELECT * FROM tracker_tickets WHERE status = ? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM tracker_tickets ORDER BY id').all()).map((row) => this.ticket(row));
  }
  getTicket(id) { return this.ticket(this.db.prepare('SELECT * FROM tracker_tickets WHERE id = ?').get(ticketNumber(id))); }
  createTicket({ title, body = '', labels = [], project = null }) {
    if (!title?.trim()) throw new Error('Ticket title is required');
    const status = this.conf?.sections?.tracker?.todo_state;
    if (!status) throw new Error('Missing required [tracker] todo_state');
    const at = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO tracker_tickets(title, body, labels, project, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, body, JSON.stringify(labels), project, status, at, at);
      this.db.prepare('INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at, proof, approval_context) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(result.lastInsertRowid, status, this.actor.kind, this.actor.id, at, this.proof(result.lastInsertRowid, status, at), null);
      this.db.exec('COMMIT');
      return this.getTicket(result.lastInsertRowid);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  moveTicket(id, status) {
    const number = ticketNumber(id);
    if (!this.getTicket(number)) throw new Error(`No such ticket: ${id}`);
    const statuses = ['todo_state', 'progress_state', 'review_state', 'validate_state', 'go_state', 'done_state']
      .map((key) => this.conf?.sections?.tracker?.[key]).filter(Boolean);
    if (!statuses.includes(status)) throw new Error(`Unknown configured ticket status: ${status}`);
    const go = this.conf?.sections?.tracker?.go_state;
    if (status === go && (this.actor.kind !== 'human' || this.actor.id !== this.conf?.sections?.tracker?.owner_id)) throw new Error('Only the configured human account can approve a ticket');
    const at = now();
    const approvalContext = status === go && this.actor.kind === 'human' ? this.approvalContext(id) : null;
    const proof = this.proof(number, status, at, approvalContext);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE tracker_tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, at, number);
      this.db.prepare('INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at, proof, approval_context) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(number, status, this.actor.kind, this.actor.id, at, proof, approvalContext);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getTicket(number);
  }
  history(id) {
    return this.db.prepare('SELECT status, actor_kind, actor_id, at, proof, approval_context FROM tracker_history WHERE ticket = ? ORDER BY id').all(ticketNumber(id))
      .map((row) => ({ status: row.status, by: { kind: this.verifiedKind(row, ticketNumber(id)), id: row.actor_id },
        at: row.at, approvalContext: row.approval_context }));
  }
  comments(id, { since } = {}) {
    const rows = since
      ? this.db.prepare('SELECT * FROM tracker_comments WHERE ticket = ? AND (created_at > ? OR edited_at > ?) ORDER BY id DESC').all(ticketNumber(id), since, since)
      : this.db.prepare('SELECT * FROM tracker_comments WHERE ticket = ? ORDER BY id DESC').all(ticketNumber(id));
    return rows.map((row) => ({ id: String(row.id), body: row.body, images: JSON.parse(row.images),
      createdAt: row.created_at, editedAt: row.edited_at, agent: this.verifiedCommentKind(row, id) === 'agents',
      by: { kind: this.verifiedCommentKind(row, id), id: row.actor_id },
      byOwner: this.verifiedCommentKind(row, id) === 'human' && row.actor_id === this.conf?.sections?.tracker?.owner_id,
      url: `local://ticket/${id}#comment-${row.id}` }));
  }
  comment(id, body, { images = [] } = {}) {
    if (!this.getTicket(id)) throw new Error(`No such ticket: ${id}`);
    const imageRefs = images.map((path) => path.startsWith('local://capture/') ? path : this.upload(path));
    const serializedImages = JSON.stringify(imageRefs);
    const at = now();
    const proof = this.commentProof(ticketNumber(id), body, at, serializedImages);
    this.db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = this.db.prepare('INSERT INTO tracker_comments(ticket, body, images, actor_kind, actor_id, created_at, proof) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ticketNumber(id), body, serializedImages, this.actor.kind, this.actor.id, at, proof);
      this.db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = ?').run(at, ticketNumber(id));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.comments(id).find((item) => item.id === String(result.lastInsertRowid));
  }
  editComment(id, commentId, body) {
    const row = this.db.prepare('SELECT * FROM tracker_comments WHERE ticket = ? AND id = ?').get(ticketNumber(id), Number(commentId));
    if (!row) throw new Error(`No such comment: ${commentId}`);
    if (row.actor_kind !== this.actor.kind || row.actor_id !== this.actor.id) throw new Error('Cannot edit another actor’s comment');
    const at = now();
    const proof = this.commentProof(ticketNumber(id), body, at, row.images);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE tracker_comments SET body = ?, edited_at = ?, proof = ? WHERE id = ?').run(body, at, proof, row.id);
      this.db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = ?').run(at, ticketNumber(id));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.comments(id).find((item) => item.id === String(row.id));
  }
  upload(path) {
    const image = checkedImage(path, this.conf?.sections?.tracker?.capture_roots);
    const digest = createHash('sha256').update(image.bytes).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO tracker_images(digest, mime, body, created_at) VALUES (?, ?, ?, ?)')
      .run(digest, image.mime, image.bytes, now());
    return `local://capture/${digest}`;
  }
  changesSince(cursor) {
    const readAt = now();
    const since = cursor || '1970-01-01T00:00:00.000Z';
    const events = this.db.prepare('SELECT * FROM tracker_tickets WHERE updated_at > ? ORDER BY updated_at, id').all(since)
      .map((row) => ({ ...this.ticket(row), comments: this.comments(row.id), agent: this.history(row.id)[0]?.by.kind === 'agents' }));
    return { events, cursor: readAt };
  }
  close() { this.db.close(); }
}
