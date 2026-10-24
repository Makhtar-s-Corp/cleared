// The ledger's session history, read only (issue 292): the sessions and
// their events that store/db.ts writes, searched by text, ticket, project,
// session, type and dates, a page at a time, and every value cleaned by the
// redactor before it is matched or shown.
//
// The file is opened read only (SQLITE_OPEN_READONLY, then query_only), so
// nothing here can write, whatever the statement: never through openStore,
// which makes the folder, sets the journal, creates the tables, migrates and
// copies the ledger before a migration.
//
// A search term is matched on the cleaned text, never on the stored one:
// otherwise the answer would tell whether a secret is in the ledger. A term
// that cleaning changes (shaped like a secret) is refused; a piece of a
// secret finds nothing, since the cleaned text no longer holds it. The whole
// cleaned text is read, not the part an answer shows. A LIKE on the stored
// text first narrows the rows, by the term or by its runs of ASCII.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { StoreError } from '../store/db.ts';
import { TEXT_LIMIT, TIMELINE_TEXT_LIMIT, cutStrings, type Redactor } from './redact.ts';
import type { Values } from '../../app/web/lib/i18n.ts';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// A search the server refuses: the key of its message in the catalog.
export class HistoryError extends Error {
  override name = 'HistoryError';
  readonly key: string;
  readonly values: Values;
  constructor(key: string, values: Values = {}) {
    super(key);
    this.key = key;
    this.values = values;
  }
}

export function openLedgerReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new StoreError(`no ledger at ${path}: start the service once, or set CLEARED_STATE_DIR (or ORCH_LEDGER) to the folder of an existing one`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return db;
  } catch (error) {
    db?.close();
    throw new StoreError(`cannot open the ledger at ${path} to read it: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type SessionView = {
  readonly id: string;
  readonly project: string;
  readonly ticket: string;
  readonly role: string;
  readonly harness: string;
  readonly model: string;
  readonly status: string;
  readonly service: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: number;
  readonly durationMs: number | null;      // from its creation to its last change
};

export type EventView = {
  readonly sessionId: string;
  readonly seq: number;
  readonly at: string;
  readonly ticket: string;
  readonly project: string;
  readonly service: string | null;
  readonly type: string;
  readonly name?: string;                   // a CUSTOM event's name, cleared.review_verdict for one
  readonly event: unknown;
};

export type Page<T> = { readonly items: T[]; readonly next: string | null };

type Common = { readonly text?: string; readonly ticket?: string; readonly project?: string; readonly from?: string; readonly to?: string; readonly limit?: number; readonly cursor?: string };
export type SessionQuery = Common & { readonly role?: string; readonly status?: string };
export type EventQuery = Common & { readonly sessionId?: string; readonly type?: string };
export type TimelineQuery = { readonly afterSeq?: number; readonly limit?: number };
export type Timeline = { readonly session: SessionView; readonly events: EventView[]; readonly next: number | null };

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

function limitOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new HistoryError('error_limit', { max: MAX_LIMIT });
  return Math.min(limit, MAX_LIMIT);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// A day or a moment as the ledger writes its times (toISOString). A day
// starts at its first moment as `from`, and ends after its last as `to`:
// the bound returned for `to` is the first moment after it.
function bound(value: string | undefined, side: 'from' | 'to'): string | undefined {
  if (value === undefined) return undefined;
  if (DAY.test(value)) {
    const start = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== value) throw new HistoryError('error_date', { value: side });
    return new Date(side === 'from' ? start : start + 86_400_000).toISOString();
  }
  const at = MOMENT.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new HistoryError('error_date', { value: side });
  return new Date(side === 'from' ? at : at + 1).toISOString();
}

function range(query: Common): { from?: string; until?: string } {
  const from = bound(query.from, 'from');
  const until = bound(query.to, 'to');
  if (from !== undefined && until !== undefined && from >= until) throw new HistoryError('error_dates_order');
  return { from, until };
}

// A cursor names the last item of a page: its kind and its sort key.
const encode = (key: readonly (string | number)[]): string => Buffer.from(JSON.stringify(key)).toString('base64url');
function decode(cursor: string | undefined, kind: 's' | 'e'): (string | number)[] | undefined {
  if (cursor === undefined) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(key) && key[0] === kind && key.length === (kind === 's' ? 3 : 4)) return key.slice(1) as (string | number)[];
  } catch { /* refused below */ }
  throw new HistoryError('error_cursor');
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
// The parts of a term the stored JSON holds as they are, for LIKE to narrow
// the rows: the term itself when it is printable ASCII with no character
// JSON escapes, else its runs of three such characters or more. JSON keeps
// other characters as they are, and LIKE ignores the case of ASCII letters
// only, so a run is found in the stored text whatever its case.
function narrowing(term: string): string[] {
  if (/^[\x20-\x7e]*$/.test(term) && !/["\\]/.test(term)) return [term];
  return term.split(/[^\x20-\x7e]|["\\]/).filter((run) => run.length >= 3);
}

export class LedgerHistory {
  readonly #db: DatabaseSync;
  readonly #redactor: Redactor;
  readonly #sessions: boolean;
  readonly #events: boolean;
  readonly #sessionService: boolean;
  readonly #eventService: boolean;

  constructor(db: DatabaseSync, redactor: Redactor) {
    this.#db = db;
    this.#redactor = redactor;
    const columns = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
    const sessions = columns('sessions');
    const events = columns('session_events');
    this.#sessions = sessions.length > 0;
    this.#events = events.length > 0;
    // The service columns come with migration 1 (store/migrations.ts).
    this.#sessionService = sessions.includes('service');
    this.#eventService = events.includes('service');
  }

  #term(text: string | undefined): string | undefined {
    const term = text?.trim();
    if (!term) return undefined;
    if (this.#redactor.changes(term)) throw new HistoryError('error_term_shape');
    return term;
  }

  #session(row: Row): SessionView {
    return this.#sessionShown(row).item;
  }

  // A session as shown, and the text a search reads in it.
  #sessionShown(row: Row): { item: SessionView; haystack: string } {
    const created = str(row.created_at);
    const updated = str(row.updated_at);
    const lasted = Date.parse(updated) - Date.parse(created);
    const r = this.#redactor;
    const fields = r.whole({ id: str(row.id), project: str(row.project), ticket: str(row.ticket), role: str(row.role), harness: str(row.harness), model: str(row.model), status: str(row.status), service: str(row.service) }) as Record<string, string>;
    const whole = { ...fields, id: r.whole(str(row.id), 'sessionId') as string };
    const shown = cutStrings(whole) as Record<string, string>;
    return {
      item: {
        id: shown.id as string, project: shown.project as string, ticket: shown.ticket as string, role: shown.role as string, harness: shown.harness as string,
        model: shown.model as string, status: shown.status as string, service: row.service === null || row.service === undefined ? null : shown.service as string,
        createdAt: created, updatedAt: updated, events: Number(row.events ?? 0), durationMs: Number.isNaN(lasted) ? null : Math.max(0, lasted),
      },
      haystack: Object.values(whole).join('\n'),
    };
  }

  // An event as shown, its strings cut to the limit, and the text a search
  // reads in it: its whole cleaned strings, then its cleaned JSON, so that a
  // term with a key ("verdict") is found too.
  #event(row: Row, limit: number): { item: EventView; haystack: string } {
    const r = this.#redactor;
    let parsed: unknown;
    try { parsed = JSON.parse(str(row.event)); } catch { parsed = str(row.event); }
    const whole = r.whole(parsed);
    const event = cutStrings(whole, limit);
    const name = typeof event === 'object' && event !== null && typeof (event as Row).name === 'string' && str(row.type) === 'CUSTOM' ? str((event as Row).name) : undefined;
    return {
      item: {
        sessionId: r.value(str(row.session_id), 'sessionId') as string, seq: Number(row.seq), at: str(row.at),
        ticket: r.text(str(row.ticket)), project: r.text(str(row.project)), service: row.service === null || row.service === undefined ? null : r.text(str(row.service)),
        type: r.text(str(row.type)), ...(name === undefined ? {} : { name }), event,
      },
      haystack: haystackOf(whole),
    };
  }

  // Reads rows in order and keeps those whose cleaned text holds the term,
  // until one more than the page: that one says there is a next page.
  #page<T, R>(sql: string, params: (string | number | null)[], term: string | undefined, view: (row: Row) => { item: T; haystack: string }, limit: number, key: (item: T) => R): { items: T[]; last: R | undefined; more: boolean } {
    const items: T[] = [];
    const needle = term?.toLowerCase();
    for (const row of this.#db.prepare(sql).iterate(...params) as Iterable<Row>) {
      const { item, haystack } = view(row);
      if (needle !== undefined && !haystack.toLowerCase().includes(needle)) continue;
      items.push(item);
      if (items.length > limit) break;
    }
    const more = items.length > limit;
    const page = items.slice(0, limit);
    return { items: page, last: more ? key(page[page.length - 1] as T) : undefined, more };
  }

  searchSessions(query: SessionQuery): Page<SessionView> {
    const limit = limitOf(query.limit);
    const { from, until } = range(query);
    const after = decode(query.cursor, 's');
    const term = this.#term(query.text);
    if (!this.#sessions) return { items: [], next: null };
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    const equal = (column: string, value: string | undefined) => { if (value !== undefined) { where.push(`${column} = ?`); params.push(value); } };
    equal('s.ticket', query.ticket);
    equal('s.project', query.project);
    equal('s.role', query.role);
    equal('s.status', query.status);
    if (from !== undefined) { where.push('s.updated_at >= ?'); params.push(from); }
    if (until !== undefined) { where.push('s.created_at < ?'); params.push(until); }
    if (after) { where.push('(s.created_at, s.id) < (?, ?)'); params.push(...after); }
    const service = this.#sessionService ? "COALESCE(s.service, '')" : "''";
    for (const part of term === undefined ? [] : narrowing(term)) {
      where.push(`(s.id || ' ' || s.project || ' ' || s.ticket || ' ' || s.role || ' ' || s.harness || ' ' || s.model || ' ' || s.status || ' ' || ${service}) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(part)}%`);
    }
    const count = this.#events ? '(SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id)' : '0';
    const sql = `SELECT s.id, s.project, s.ticket, s.role, s.harness, s.model, s.status, s.created_at, s.updated_at, ${this.#sessionService ? 's.service' : 'NULL'} AS service, ${count} AS events ` +
      `FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC, s.id DESC`;
    const page = this.#page(sql, params, term, (row) => this.#sessionShown(row), limit, (s) => ['s', s.createdAt, s.id]);
    return { items: page.items, next: page.last ? encode(page.last) : null };
  }

  searchEvents(query: EventQuery): Page<EventView> {
    const limit = limitOf(query.limit);
    const { from, until } = range(query);
    const after = decode(query.cursor, 'e');
    const term = this.#term(query.text);
    if (!this.#events) return { items: [], next: null };
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    const equal = (column: string, value: string | undefined) => { if (value !== undefined) { where.push(`${column} = ?`); params.push(value); } };
    equal('session_id', query.sessionId);
    equal('ticket', query.ticket);
    equal('project', query.project);
    if (query.type?.startsWith('cleared.')) { where.push("type = 'CUSTOM' AND json_extract(event, '$.name') = ?"); params.push(query.type); }
    else equal('type', query.type);
    if (from !== undefined) { where.push('at >= ?'); params.push(from); }
    if (until !== undefined) { where.push('at < ?'); params.push(until); }
    if (after) { where.push('(at, session_id, seq) < (?, ?, ?)'); params.push(...after); }
    for (const part of term === undefined ? [] : narrowing(term)) { where.push("event LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(part)}%`); }
    const sql = `SELECT session_id, seq, at, ticket, project, type, event, ${this.#eventService ? 'service' : 'NULL AS service'} FROM session_events ` +
      `${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, session_id DESC, seq DESC`;
    const page = this.#page(sql, params, term, (row) => this.#event(row, TEXT_LIMIT), limit, (e) => ['e', e.at, e.sessionId, e.seq]);
    return { items: page.items, next: page.last ? encode(page.last) : null };
  }

  timeline(id: string, query: TimelineQuery): Timeline | undefined {
    const limit = limitOf(query.limit);
    const afterSeq = query.afterSeq ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new HistoryError('error_after_seq');
    if (!this.#sessions) return undefined;
    const session = this.#sessionById(id);
    if (!session) return undefined;
    if (!this.#events) return { session, events: [], next: null };
    const rows = this.#db.prepare(`SELECT session_id, seq, at, ticket, project, type, event, ${this.#eventService ? 'service' : 'NULL AS service'} FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(id, afterSeq, limit + 1) as Row[];
    const events = rows.slice(0, limit).map((row) => this.#event(row, TIMELINE_TEXT_LIMIT).item);
    return { session, events, next: rows.length > limit ? (events[events.length - 1]?.seq ?? null) : null };
  }

  #sessionById(id: string): SessionView | undefined {
    const count = this.#events ? '(SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id)' : '0';
    const row = this.#db.prepare(`SELECT s.id, s.project, s.ticket, s.role, s.harness, s.model, s.status, s.created_at, s.updated_at, ${this.#sessionService ? 's.service' : 'NULL'} AS service, ${count} AS events FROM sessions s WHERE s.id = ?`).get(id) as Row | undefined;
    return row ? this.#session(row) : undefined;
  }
}

function haystackOf(event: unknown): string {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(event);
  return `${strings.join('\n')}\n${JSON.stringify(event)}`;
}
