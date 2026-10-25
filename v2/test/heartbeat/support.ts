// A ledger with the tables the heartbeat reads, and rows written as their
// modules write them, for the heartbeat's tests (docs/v2/milestone-4-plan.md,
// section 7). The monitor is a fake on loopback, port 0: never a real service.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { HEARTBEAT_TABLES } from '../../src/heartbeat/beat.ts';
import { INBOX_TABLE } from '../../src/inbox/store.ts';
import { TRAIN_TABLE } from '../../src/release/store.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import { MIRROR_TABLES } from '../../src/tickets/mirror.ts';

export const NOW = new Date('2026-10-25T12:00:00.000Z');
export const minutesBefore = (minutes: number, from: Date = NOW) => new Date(from.getTime() - minutes * 60_000).toISOString();

export const ALL_TABLES = [...RUNS_TABLES, INBOX_TABLE, ...MIRROR_TABLES, TRAIN_TABLE, ...QUOTA_TABLES, ...HEARTBEAT_TABLES];

export function ledger(path = ':memory:'): Store {
  const store = openStore(path);
  applyTables(store.db, ALL_TABLES);
  return store;
}

export function session(db: DatabaseSync, row: { id: string; ticket: string; role?: string; status?: string; updatedAt: string; lastEventAt?: string; project?: string }): void {
  const project = row.project ?? 'shop';
  db.prepare('INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, project, row.ticket, row.role ?? 'author', 'claude-code', 'claude-opus-5-5', row.status ?? 'working', row.updatedAt, row.updatedAt);
  if (row.lastEventAt) {
    db.prepare('INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, 1, row.lastEventAt, row.ticket, project, 'TEXT_MESSAGE_CONTENT', JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: 'working' }));
  }
}

export function inboxItem(db: DatabaseSync, row: { id: string; ticket: string; kind: string; since: string; state?: string }): void {
  db.prepare('INSERT INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.kind, row.ticket, 'shop', 's-inbox', row.id, row.since, row.state ?? 'waiting', '{}');
}

export function trackerRead(db: DatabaseSync, tracker: string, readAt: string): void {
  db.prepare('INSERT INTO mirror_trackers (tracker, started_at, read_at) VALUES (?, ?, ?)').run(tracker, minutesBefore(600), readAt);
}

export function train(db: DatabaseSync, row: { item: string; ticket: string; state: string; updatedAt: string }): void {
  db.prepare('INSERT INTO release_trains (item, ticket, project, state, stops, compatibility, blocked, announcement, approver, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.item, row.ticket, 'shop', row.state, '[]', null, null, '', null, row.updatedAt, row.updatedAt);
}

export function quotaReading(db: DatabaseSync, row: { window: 'five_hour' | 'seven_day'; usedPercent: number; at: string; resetsAt: string }): void {
  db.prepare('INSERT INTO quota_readings (project, harness, source, at, ok, "window", used_percent, resets_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('shop', 'claude-code', 'oauth', row.at, 1, row.window, row.usedPercent, row.resetsAt, null);
}

// What the service's beat writes, for the status's tests.
export function beatRow(db: DatabaseSync, row: { at: string; ok?: boolean; everyMs?: number; monitor?: 'on' | 'off' | 'invalid' }): void {
  const put = db.prepare('INSERT INTO v2_heartbeat_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  put.run('last_beat_at', row.at);
  put.run('last_beat_ok', String(row.ok ?? true));
  put.run('beat_every_ms', String(row.everyMs ?? 60_000));
  put.run('monitor', row.monitor ?? 'on');
}

export function events(db: DatabaseSync, kind?: string): { kind: string; detail: string | null }[] {
  return (kind
    ? db.prepare('SELECT kind, detail FROM events WHERE kind = ? ORDER BY event_id').all(kind)
    : db.prepare('SELECT kind, detail FROM events ORDER BY event_id').all()) as { kind: string; detail: string | null }[];
}

export type Received = { readonly method: string; readonly path: string; readonly body: string };

// A push monitor on loopback that records each request and answers `status`.
export async function fakeMonitor(status = 200): Promise<{ base: string; received: Received[]; status: { value: number }; close(): Promise<void> }> {
  const received: Received[] = [];
  const answer = { value: status };
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method ?? '', path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(answer.value, { 'content-type': 'text/plain' });
      response.end('OK');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    status: answer,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
