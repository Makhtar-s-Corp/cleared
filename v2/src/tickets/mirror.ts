// The mirrors of the ticket store on GitHub Issues and Linear (milestone 4,
// issue #381, P230 to P232; the rule for a person: docs/v2/mirrors.md).
//
// A pass reads each tracker's issues changed since the last pass (polling:
// a webhook would need an address the tracker reaches, and the brief allows
// no tunnel), then for each ticket and tracker compares both sides with the
// state they last agreed on (mirror_links.agreed): the side that changed is
// written on the other, and when both changed, decide() settles it. A
// ticket created after the mirror's first pass is created on the tracker;
// an issue created there after it becomes a ticket.
//
// The mirror writes in the app as agents (MIRROR_ACTOR), never as a signed
// person: who made a change on the tracker is kept in mirror_applied and
// read back by the rule. Its own writes on a tracker are kept in
// mirror_writes, so that a stale read of one is not taken for a change.
//
// The follow-ups (issue #386, P237): a linked ticket's comments go both
// ways, each once (mirror_comments keeps each pair); its title and its body
// go both ways too, each settled by decide() against the value both sides
// last agreed on (mirror_fields); and each write in the app says its ticket
// to the change stream (MirrorDeps.changed), so an open page redraws.
//
// A delegation (C3, P243): a person hands an issue over on a tracker (the
// delegation label, or the issue assigned to the mirror's account). The
// mirror makes it a ticket if it is not one yet, whatever its age, and hands
// the ticket to the lead's plans (MirrorDeps.delegate), once per issue and
// time (mirror_delegations), then says on the issue what became of it. The
// plans propose it to the owner: the tracker still starts nothing (P232).
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../../app/src/catalog.ts';
import { translator, type Translate } from '../../app/web/lib/i18n.ts';
import type { UserId } from '../session/contract.ts';
import type { Actor, Comment, Ticket, TicketId, TicketStore } from './contract.ts';
import { GitHubTracker } from './mirror-github.ts';
import { LinearTracker } from './mirror-linear.ts';
import { DELEGATION_LABEL, type Tracker, type TrackerComment, type TrackerIssue } from './mirror-tracker.ts';

export {
  DELEGATION_LABEL, TrackerError, type Tracker, type TrackerChange, type TrackerComment, type TrackerDelegation, type TrackerEdit, type TrackerIssue,
} from './mirror-tracker.ts';

export const MIRROR_ACTOR: Actor = { kind: 'agents', id: 'cleared-mirror' };
export const MIRROR_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;

export const MIRROR_TABLES: string[] = [
  // Each tracker's first pass (nothing older is mirrored) and its last read.
  'CREATE TABLE IF NOT EXISTS mirror_trackers (tracker TEXT PRIMARY KEY, started_at TEXT NOT NULL, read_at TEXT NOT NULL)',
  // A ticket's issue on a tracker, the state both sides last agreed on, and
  // the tracker's side as last read: its state (null: one the app does not
  // have) and who made it, when.
  `CREATE TABLE IF NOT EXISTS mirror_links (
  ticket TEXT NOT NULL, tracker TEXT NOT NULL, issue TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, agreed TEXT NOT NULL,
  remote TEXT, remote_kind TEXT NOT NULL, remote_who TEXT NOT NULL, remote_at TEXT NOT NULL,
  PRIMARY KEY (ticket, tracker), UNIQUE (tracker, issue)
)`,
  // Who made, on a tracker, a state the mirror wrote in the app.
  `CREATE TABLE IF NOT EXISTS mirror_applied (
  ticket TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL, tracker TEXT NOT NULL, at TEXT NOT NULL, applied_at TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS mirror_applied_ticket ON mirror_applied(ticket)',
  // The mirror's own writes of a state on a tracker, kept a day.
  'CREATE TABLE IF NOT EXISTS mirror_writes (tracker TEXT NOT NULL, issue TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS mirror_writes_issue ON mirror_writes(tracker, issue)',
  // The follow-ups' tables (P237), new tables rather than new columns of the
  // ones above. The time the mirror began following a link's comments and
  // text: a comment older than it is not copied, either way.
  'CREATE TABLE IF NOT EXISTS mirror_followed (ticket TEXT NOT NULL, tracker TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (ticket, tracker))',
  // Per link and field (title, body): the value both sides last agreed on,
  // and the tracker's as last read, with who made it, when.
  `CREATE TABLE IF NOT EXISTS mirror_fields (
  ticket TEXT NOT NULL, tracker TEXT NOT NULL, field TEXT NOT NULL, agreed TEXT NOT NULL,
  remote TEXT NOT NULL, remote_kind TEXT NOT NULL, remote_who TEXT NOT NULL, remote_at TEXT NOT NULL,
  PRIMARY KEY (ticket, tracker, field)
)`,
  // Who made, on a tracker, a title or a body the mirror wrote in the app.
  `CREATE TABLE IF NOT EXISTS mirror_edits (
  ticket TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL, tracker TEXT NOT NULL, at TEXT NOT NULL, applied_at TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS mirror_edits_ticket ON mirror_edits(ticket, field)',
  // A comment's pair: its id in the app (none for the mirror's own comment
  // on a tracker) and on the tracker.
  `CREATE TABLE IF NOT EXISTS mirror_comments (
  ticket TEXT NOT NULL, tracker TEXT NOT NULL, local TEXT, remote TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (tracker, remote)
)`,
  'CREATE INDEX IF NOT EXISTS mirror_comments_local ON mirror_comments(tracker, local)',
  // Each delegation (P243), once per issue and time: its ticket, and what
  // the plans made of it once they were told (null until then).
  `CREATE TABLE IF NOT EXISTS mirror_delegations (
  tracker TEXT NOT NULL, issue TEXT NOT NULL, at TEXT NOT NULL, ticket TEXT NOT NULL, who TEXT NOT NULL, outcome TEXT, told_at TEXT,
  PRIMARY KEY (tracker, issue, at)
)`,
];

// ---- the rule ----------------------------------------------------------

// One side's state and who last made it: a person, or agents (the service,
// the flow, an integration, anyone the side cannot name).
export type Side = { readonly status: string; readonly kind: 'human' | 'agents'; readonly at: string };
export type Verdict = 'none' | 'agree' | 'push' | 'pull';

// push: the app's state is written on the tracker; pull: the tracker's in
// the app. A field's text (P237) is settled the same way, its value in
// place of the state. A remote of null is a state the app does not have (closed as not
// planned, Canceled): it is never written in the app, and since a person
// may have put it there, only the owner's change is written over it.
export function decide(input: { readonly agreed: string; readonly local: Side; readonly remote: Side | null }): Verdict {
  const { agreed, local, remote } = input;
  const localChanged = local.status !== agreed;
  if (remote === null) return localChanged && local.kind === 'human' ? 'push' : 'none';
  const remoteChanged = remote.status !== agreed;
  if (!remoteChanged) return localChanged ? 'push' : 'none';
  if (!localChanged) return 'pull';
  if (local.status === remote.status) return 'agree';
  if (local.kind !== remote.kind) return local.kind === 'human' ? 'push' : 'pull';
  if (local.kind === 'human' && Date.parse(remote.at) > Date.parse(local.at)) return 'pull';
  return 'push';
}

// ---- the settings ------------------------------------------------------

export type MirrorConfig = {
  readonly pollMs: number;
  readonly language: Language;
  readonly github?: { readonly api: string; readonly token: string };
  readonly linear?: { readonly api: string; readonly token: string; readonly team: string };
  readonly delegation?: { readonly label: string };    // none: CLEARED_V2_DELEGATION=off
};

export class MirrorConfigError extends Error {
  override name = 'MirrorConfigError';
}

const GITHUB_API = 'https://api.github.com';
const LINEAR_API = 'https://api.linear.app/graphql';
const POLL_DEFAULT_S = 60;
const POLL_MIN_S = 15;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

function tokenFrom(variable: string, file: string): string {
  let token: string;
  try { token = readFileSync(file, 'utf8').trim(); } catch { throw new MirrorConfigError(`${variable}: the file cannot be read`); }
  if (token === '') throw new MirrorConfigError(`${variable}: the file holds no token`);
  return token;
}

// The tracker's own address, or one on loopback (a test's fake).
function apiFrom(variable: string, value: string | undefined, own: string): string {
  const given = value?.trim();
  if (!given) return own;
  let url: URL;
  try { url = new URL(given); } catch { throw new MirrorConfigError(`${variable} must be an address such as ${own}`); }
  if (url.origin === new URL(own).origin) return given;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname)) return given;
  throw new MirrorConfigError(`${variable} must be ${own} or an address on loopback, got "${url.origin}"`);
}

// No token file named, no mirror: the app alone (D17).
export function loadMirrorConfig(env: NodeJS.ProcessEnv = process.env): MirrorConfig | undefined {
  const githubFile = env.CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE?.trim();
  const linearFile = env.CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE?.trim();
  if (!githubFile && !linearFile) return undefined;
  const seconds = env.CLEARED_V2_MIRROR_POLL_SECONDS?.trim();
  const poll = seconds ? Number(seconds) : POLL_DEFAULT_S;
  if (!Number.isInteger(poll) || poll < POLL_MIN_S) throw new MirrorConfigError(`CLEARED_V2_MIRROR_POLL_SECONDS must be a whole number of seconds, at least ${POLL_MIN_S}`);
  let linear: MirrorConfig['linear'];
  if (linearFile) {
    const team = env.CLEARED_V2_MIRROR_LINEAR_TEAM?.trim();
    if (!team) throw new MirrorConfigError('CLEARED_V2_MIRROR_LINEAR_TEAM must name the Linear team (its key, such as ENG)');
    linear = { api: apiFrom('CLEARED_V2_MIRROR_LINEAR_API', env.CLEARED_V2_MIRROR_LINEAR_API, LINEAR_API), token: tokenFrom('CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE', linearFile), team };
  }
  const switched = env.CLEARED_V2_DELEGATION?.trim() || 'on';
  if (switched !== 'on' && switched !== 'off') throw new MirrorConfigError(`CLEARED_V2_DELEGATION must be on or off, got "${switched}"`);
  const label = env.CLEARED_V2_DELEGATION_LABEL?.trim() || DELEGATION_LABEL;
  if (label.toLowerCase().startsWith('status:')) throw new MirrorConfigError('CLEARED_V2_DELEGATION_LABEL must not start with status:, which names a state');
  const github = githubFile
    ? { api: apiFrom('CLEARED_V2_MIRROR_GITHUB_API', env.CLEARED_V2_MIRROR_GITHUB_API, GITHUB_API), token: tokenFrom('CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE', githubFile) }
    : undefined;
  return {
    pollMs: poll * 1000, language: env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr',
    ...(github ? { github } : {}), ...(linear ? { linear } : {}), ...(switched === 'on' ? { delegation: { label } } : {}),
  };
}

// ---- the pass ----------------------------------------------------------

// What the mirror asks of the flow (flow/engine.ts): whether it works on a
// ticket, and to set one aside with the mirror's words.
export type MirrorFlow = {
  isActive(ticket: TicketId): boolean;
  setAside(ticket: TicketId, by: UserId, words: { readonly note: string; readonly message: string }): Promise<unknown>;
};

// A delegated ticket, as the mirror hands it to the lead's plans
// (tickets/delegation.ts), and what they made of it: a plan proposed, or
// the ticket already in hand (an item of a plan, or in a state past Todo).
// No outcome: the plans do not run yet, and the mirror asks again at its
// next pass.
export type DelegationRequest = {
  readonly ticket: Ticket; readonly tracker: string; readonly key: string; readonly url: string; readonly who: string;
};
export type DelegationOutcome = { readonly plan: string } | { readonly inPlan: string } | { readonly inState: string };
export type MirrorDelegate = (request: DelegationRequest) => Promise<DelegationOutcome | undefined>;

export type MirrorDeps = {
  readonly db: DatabaseSync;
  readonly tickets: TicketStore;
  readonly trackers: readonly Tracker[];
  readonly project: string;
  readonly services: readonly string[];          // the workspace's, in order
  readonly language: Language;
  readonly flow?: () => MirrorFlow | undefined;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  // A ticket the mirror wrote in the app (created, moved, edited, commented).
  readonly changed?: (ticket: TicketId) => void;
  // A delegation's ticket handed to the plans; none: delegations are not read.
  readonly delegate?: MirrorDelegate;
};

// A tracker's list is read from a little before the last read, so that a
// change stamped while the last pass ran is read again, never missed.
const READ_OVERLAP_MS = 120_000;
// A change by the mirror's account within this time of the mirror's write
// of the same state is that write.
const ECHO_WINDOW_MS = 60_000;
const WRITES_KEPT_MS = 24 * 3600_000;

type Row = Record<string, unknown>;
type Link = {
  readonly ticket: TicketId; readonly tracker: string; readonly issue: string; readonly agreed: string;
  readonly remote: string | null; readonly remoteKind: Side['kind']; readonly remoteWho: string; readonly remoteAt: string;
};
type Remote = Side & { readonly who: string };
type Field = 'title' | 'body';
const FIELDS: readonly Field[] = ['title', 'body'];

const linkOf = (row: Row): Link => ({
  ticket: String(row.ticket), tracker: String(row.tracker), issue: String(row.issue), agreed: String(row.agreed),
  remote: row.remote === null ? null : String(row.remote), remoteKind: row.remote_kind === 'human' ? 'human' : 'agents',
  remoteWho: String(row.remote_who), remoteAt: String(row.remote_at),
});

function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'TrackerError') return error.message;
  return error instanceof Error ? error.name : typeof error;
}

export class Mirror {
  readonly #deps: MirrorDeps;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #t: Translate;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(deps: MirrorDeps) {
    this.#deps = deps;
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
    this.#log = deps.log ?? ((line) => console.error(line));
    for (const table of MIRROR_TABLES) this.#db.exec(table);
    const read = (lang: Language) => JSON.parse(readFileSync(`${MIRROR_MESSAGES_DIR}mirror.${lang}.json`, 'utf8')) as Record<string, string>;
    this.#t = translator({ ...read('en'), ...(deps.language === 'en' ? {} : read(deps.language)) });
  }

  get trackerNames(): string[] {
    return this.#deps.trackers.map((t) => t.name);
  }

  // A pass now, then one every interval after the last ended; never two at once.
  start(intervalMs: number): void {
    if (this.#timer || this.#closed) return;
    const run = () => {
      this.#running = this.pass().finally(() => {
        this.#running = undefined;
        if (!this.#closed) this.#timer = setTimeout(run, intervalMs).unref();
      });
    };
    this.#timer = setTimeout(run, Math.min(intervalMs, 1000)).unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  // Each tracker in turn; one that fails is said in one line and is read
  // again at the next pass, the others go on.
  async pass(): Promise<void> {
    for (const tracker of this.#deps.trackers) {
      try {
        await this.#passOn(tracker);
      } catch (error) {
        this.#log(`cleared-v2: the mirror on ${tracker.name} stopped its pass (${describe(error)}); it reads it again at the next one`);
      }
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  async #passOn(tracker: Tracker): Promise<void> {
    const at = this.#iso();
    const started = this.#db.prepare('SELECT started_at, read_at FROM mirror_trackers WHERE tracker = ?').get(tracker.name) as Row | undefined;
    if (!started) {
      this.#db.prepare('INSERT INTO mirror_trackers (tracker, started_at, read_at) VALUES (?, ?, ?)').run(tracker.name, at, at);
      return;
    }
    const startedAt = String(started.started_at);
    const since = new Date(Math.max(Date.parse(startedAt), Date.parse(String(started.read_at)) - READ_OVERLAP_MS)).toISOString();
    for (const issue of await tracker.changed(since)) {
      const row = this.#db.prepare('SELECT * FROM mirror_links WHERE tracker = ? AND issue = ?').get(tracker.name, issue.id) as Row | undefined;
      if (row) this.#read(tracker, linkOf(row), issue);
      else if (Date.parse(issue.createdAt) >= Date.parse(startedAt) && issue.status !== null) await this.#import(tracker, issue, issue.status);
      if (this.#deps.delegate) await this.#delegated(tracker, issue, startedAt);
    }
    if (this.#deps.delegate) await this.#handOver(tracker, this.#deps.delegate);
    for (const comment of await tracker.commentsSince(since)) await this.#comeIn(tracker, comment);
    for (const ticket of await this.#deps.tickets.list({ project: this.#deps.project })) {
      if (Date.parse(ticket.createdAt) < Date.parse(startedAt) || !this.#holds(tracker, ticket) || this.#link(ticket.id, tracker.name)) continue;
      await this.#export(tracker, ticket);
    }
    for (const row of this.#db.prepare('SELECT * FROM mirror_links WHERE tracker = ? ORDER BY rowid').all(tracker.name) as Row[]) {
      const link = linkOf(row);
      const ticket = await this.#deps.tickets.get(link.ticket);
      if (!ticket) continue;
      await this.#settle(tracker, link, ticket);
      // A link made before the follow-ups' code is followed from now on.
      const since = this.#followed(link.ticket, tracker.name);
      if (since === undefined) {
        this.#follow(link.ticket, tracker.name, this.#iso(), ticket);
        continue;
      }
      const now = await this.#deps.tickets.get(link.ticket) ?? ticket;
      await this.#settleFields(tracker, link, now);
      await this.#goOut(tracker, link, now, since);
    }
    this.#db.prepare('UPDATE mirror_trackers SET read_at = ? WHERE tracker = ?').run(at, tracker.name);
    this.#db.prepare('DELETE FROM mirror_writes WHERE at < ?').run(new Date(Date.parse(at) - WRITES_KEPT_MS).toISOString());
  }

  #link(ticket: TicketId, tracker: string): Link | undefined {
    const row = this.#db.prepare('SELECT * FROM mirror_links WHERE ticket = ? AND tracker = ?').get(ticket, tracker) as Row | undefined;
    return row ? linkOf(row) : undefined;
  }

  // A repository's tracker holds the tickets of its service: the ticket's
  // first service, else the workspace's first; any tracker holds a ticket
  // when no service is known.
  #holds(tracker: Tracker, ticket: Ticket): boolean {
    if (tracker.service === undefined) return true;
    const service = ticket.services?.[0]?.name ?? this.#deps.services[0];
    return service === undefined || service === tracker.service;
  }

  #changed(ticket: TicketId): void {
    this.#deps.changed?.(ticket);
  }

  #followed(ticket: TicketId, tracker: string): string | undefined {
    const row = this.#db.prepare('SELECT since FROM mirror_followed WHERE ticket = ? AND tracker = ?').get(ticket, tracker) as Row | undefined;
    return row ? String(row.since) : undefined;
  }

  // Both sides agree on the text they hold now.
  #follow(ticket: TicketId, tracker: string, since: string, text: { readonly title: string; readonly body: string }): void {
    this.#db.prepare('INSERT OR IGNORE INTO mirror_followed (ticket, tracker, since) VALUES (?, ?, ?)').run(ticket, tracker, since);
    const field = this.#db.prepare('INSERT OR IGNORE INTO mirror_fields (ticket, tracker, field, agreed, remote, remote_kind, remote_who, remote_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const name of FIELDS) field.run(ticket, tracker, name, text[name], text[name], 'agents', MIRROR_ACTOR.id, this.#iso());
  }

  #paired(ticket: TicketId, tracker: string, local: string | null, remote: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO mirror_comments (ticket, tracker, local, remote, at) VALUES (?, ?, ?, ?, ?)').run(ticket, tracker, local, remote, this.#iso());
  }

  #wrote(tracker: string, issue: string, status: string): void {
    this.#db.prepare('INSERT INTO mirror_writes (tracker, issue, status, at) VALUES (?, ?, ?, ?)').run(tracker, issue, status, this.#iso());
  }

  #isEcho(tracker: string, issue: string, status: string, at: string): boolean {
    const writes = this.#db.prepare('SELECT at FROM mirror_writes WHERE tracker = ? AND issue = ? AND status = ?').all(tracker, issue, status) as Row[];
    return writes.some((w) => Math.abs(Date.parse(String(w.at)) - Date.parse(at)) <= ECHO_WINDOW_MS);
  }

  // The tracker's side of an issue: its state, and who made it. A change by
  // the mirror's account that is one of its writes is the mirror's; one it
  // did not write is a person's (an account shared with a person).
  #remoteOf(tracker: Tracker, issue: TrackerIssue, status: string): Remote & { readonly echo: boolean } {
    const change = [...issue.changes].reverse().find((c) => c.status === status);
    if (!change) return { status, kind: 'agents', who: 'unknown', at: issue.updatedAt, echo: false };
    const echo = change.actor === 'mirror' && this.#isEcho(tracker.name, issue.id, status, change.at);
    return { status, kind: change.actor === 'agent' || echo ? 'agents' : 'human', who: change.who, at: change.at, echo };
  }

  #read(tracker: Tracker, link: Link, issue: TrackerIssue): void {
    this.#readFields(tracker, link, issue);
    if (issue.status === null) {
      this.#db.prepare('UPDATE mirror_links SET remote = NULL WHERE ticket = ? AND tracker = ?').run(link.ticket, tracker.name);
      return;
    }
    const remote = this.#remoteOf(tracker, issue, issue.status);
    // An older state the mirror wrote itself: a stale read, not a change.
    if (remote.echo && remote.status !== link.agreed) return;
    this.#setRemote(link, remote);
  }

  // The tracker's text as read, and who last changed each field. A field no
  // one is named for (GitHub's description) reads as an agent's; a change
  // by the mirror's account of a value it did not write is a person's.
  #readFields(tracker: Tracker, link: Link, issue: TrackerIssue): void {
    for (const field of FIELDS) {
      const row = this.#db.prepare('SELECT remote FROM mirror_fields WHERE ticket = ? AND tracker = ? AND field = ?').get(link.ticket, tracker.name, field) as Row | undefined;
      if (!row || String(row.remote) === issue[field]) continue;
      const edit = [...issue.edits].reverse().find((e) => e.field === field);
      this.#db.prepare('UPDATE mirror_fields SET remote = ?, remote_kind = ?, remote_who = ?, remote_at = ? WHERE ticket = ? AND tracker = ? AND field = ?')
        .run(issue[field], edit && edit.actor !== 'agent' ? 'human' : 'agents', edit?.who ?? 'unknown', edit?.at ?? issue.updatedAt, link.ticket, tracker.name, field);
    }
  }

  #setRemote(link: Pick<Link, 'ticket' | 'tracker'>, remote: Remote, agreed?: string): void {
    this.#db.prepare('UPDATE mirror_links SET remote = ?, remote_kind = ?, remote_who = ?, remote_at = ?, agreed = coalesce(?, agreed) WHERE ticket = ? AND tracker = ?')
      .run(remote.status, remote.kind, remote.who, remote.at, agreed ?? null, link.ticket, link.tracker);
  }

  #applied(ticket: TicketId, remote: Remote, tracker: Tracker): void {
    this.#db.prepare('INSERT INTO mirror_applied (ticket, status, kind, who, tracker, at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ticket, remote.status, remote.kind, remote.who, tracker.name, remote.at, this.#iso());
  }

  // An issue created on the tracker becomes a ticket in its state; the go
  // state is not an approval, so such an issue comes in Todo.
  async #import(tracker: Tracker, issue: TrackerIssue, wanted: string): Promise<void> {
    const states = this.#deps.tickets.states;
    const services = tracker.service !== undefined && this.#deps.services.length > 1 ? [tracker.service] : undefined;
    const ticket = await this.#deps.tickets.create({
      title: issue.title, body: issue.body, labels: [...issue.labels], project: this.#deps.project, ...(services ? { services } : {}),
    }, MIRROR_ACTOR);
    const remote = this.#remoteOf(tracker, issue, wanted);
    const status = wanted === states.go ? states.todo : wanted;
    if (status !== ticket.status) await this.#deps.tickets.move(ticket.id, status, MIRROR_ACTOR);
    this.#applied(ticket.id, { ...remote, status }, tracker);
    this.#db.prepare('INSERT INTO mirror_links (ticket, tracker, issue, key, url, agreed, remote, remote_kind, remote_who, remote_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket.id, tracker.name, issue.id, issue.key, issue.url, status, remote.status, remote.kind, remote.who, remote.at);
    this.#follow(ticket.id, tracker.name, issue.createdAt, issue);
    this.#changed(ticket.id);
    if (wanted === states.go) await this.#putBack(tracker, { ticket: ticket.id, tracker: tracker.name, issue: issue.id }, { ...ticket, status }, 'refused_go', wanted);
  }

  async #export(tracker: Tracker, ticket: Ticket): Promise<void> {
    const made = await tracker.create({ title: ticket.title, body: ticket.body, labels: ticket.labels, status: ticket.status });
    this.#wrote(tracker.name, made.id, ticket.status);
    this.#db.prepare('INSERT INTO mirror_links (ticket, tracker, issue, key, url, agreed, remote, remote_kind, remote_who, remote_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket.id, tracker.name, made.id, made.key, made.url, ticket.status, ticket.status, 'agents', MIRROR_ACTOR.id, this.#iso());
    this.#follow(ticket.id, tracker.name, ticket.createdAt, ticket);
  }

  // The app's side: who made the ticket's state. The mirror's own row is
  // the tracker's person or agent, as mirror_applied keeps it; the owner's
  // signed row is a person; any other row is agents.
  async #localOf(ticket: Ticket): Promise<Side> {
    const last = (await this.#deps.tickets.history(ticket.id)).at(-1);
    if (last?.by.id === MIRROR_ACTOR.id) {
      const applied = this.#db.prepare('SELECT kind, at FROM mirror_applied WHERE ticket = ? ORDER BY rowid DESC LIMIT 1').get(ticket.id) as Row | undefined;
      if (applied) return { status: ticket.status, kind: applied.kind === 'human' ? 'human' : 'agents', at: String(applied.at) };
    }
    return { status: ticket.status, kind: last?.by.kind === 'human' ? 'human' : 'agents', at: last?.at ?? ticket.updatedAt };
  }

  async #settle(tracker: Tracker, link: Link, ticket: Ticket): Promise<void> {
    const local = await this.#localOf(ticket);
    const remote: Remote | null = link.remote === null ? null : { status: link.remote, kind: link.remoteKind, who: link.remoteWho, at: link.remoteAt };
    const verdict = decide({ agreed: link.agreed, local, remote });
    if (verdict === 'none') return;
    if (verdict === 'agree') {
      this.#db.prepare('UPDATE mirror_links SET agreed = ? WHERE ticket = ? AND tracker = ?').run(local.status, link.ticket, link.tracker);
      return;
    }
    if (verdict === 'push') {
      await this.#push(tracker, link, local.status);
      return;
    }
    await this.#pull(tracker, link, ticket, remote as Remote);
  }

  async #push(tracker: Tracker, link: Pick<Link, 'ticket' | 'tracker' | 'issue'>, status: string): Promise<void> {
    await tracker.move(link.issue, status);
    this.#wrote(tracker.name, link.issue, status);
    this.#setRemote(link, { status, kind: 'agents', who: MIRROR_ACTOR.id, at: this.#iso() }, status);
  }

  // The tracker's state is written in the app, unless it would approve, or
  // move an approved ticket or one the flow cannot let go: then the tracker
  // is put back to the app's state, and a comment says why.
  async #pull(tracker: Tracker, link: Link, ticket: Ticket, remote: Remote): Promise<void> {
    const states = this.#deps.tickets.states;
    if (remote.status === states.go) return this.#putBack(tracker, link, ticket, 'refused_go', remote.status);
    if (ticket.status === states.go) return this.#putBack(tracker, link, ticket, 'refused_approved', remote.status);
    const flow = this.#deps.flow?.();
    if (flow?.isActive(ticket.id)) {
      const words = { who: remote.who, tracker: tracker.title, state: remote.status };
      try {
        await flow.setAside(ticket.id, MIRROR_ACTOR.id as UserId, { note: this.#t('set_aside_note', words), message: this.#t('set_aside_message', words) });
      } catch (error) {
        if (error instanceof Error && error.name === 'FlowError' && (error as Error & { kind?: string }).kind === 'conflict') {
          return this.#putBack(tracker, link, ticket, 'refused_landing', remote.status);
        }
        throw error;
      }
    }
    await this.#deps.tickets.move(ticket.id, remote.status, MIRROR_ACTOR);
    this.#applied(ticket.id, remote, tracker);
    this.#db.prepare('UPDATE mirror_links SET agreed = ? WHERE ticket = ? AND tracker = ?').run(remote.status, link.ticket, link.tracker);
    this.#changed(ticket.id);
  }

  async #putBack(tracker: Tracker, link: Pick<Link, 'ticket' | 'tracker' | 'issue'>, ticket: Ticket, why: 'refused_go' | 'refused_approved' | 'refused_landing', asked: string): Promise<void> {
    await this.#push(tracker, link, ticket.status);
    const values = { state: asked, back: ticket.status, ticket: ticket.id };
    const text = why === 'refused_go' ? this.#t('refused_go', values) : why === 'refused_approved' ? this.#t('refused_approved', values) : this.#t('refused_landing', values);
    this.#paired(link.ticket, tracker.name, null, await tracker.comment(link.issue, text));
  }

  // ---- a delegation (C3, P243) ----------------------------------------

  // A person's delegation made after the tracker's first pass, recorded
  // once with its ticket. The mirror's account labels an issue only when it
  // creates one from a ticket that has the label: within a minute of one of
  // its writes, its delegation is that. An issue in a state the app does
  // not have comes in Todo, and the tracker is moved there with it.
  async #delegated(tracker: Tracker, issue: TrackerIssue, startedAt: string): Promise<void> {
    const delegation = issue.delegation;
    if (!delegation || delegation.actor === 'agent' || Date.parse(delegation.at) < Date.parse(startedAt)) return;
    if (this.#db.prepare('SELECT 1 FROM mirror_delegations WHERE tracker = ? AND issue = ? AND at = ?').get(tracker.name, issue.id, delegation.at)) return;
    if (delegation.actor === 'mirror' && this.#wroteNear(tracker.name, issue.id, delegation.at)) return;
    const states = this.#deps.tickets.states;
    if (!this.#issueLink(tracker, issue.id)) await this.#import(tracker, issue, issue.status ?? states.todo);
    const link = this.#issueLink(tracker, issue.id) as Link;
    if (issue.status === null && (await this.#deps.tickets.get(link.ticket))?.status === states.todo) await this.#push(tracker, link, states.todo);
    this.#db.prepare('INSERT OR IGNORE INTO mirror_delegations (tracker, issue, at, ticket, who) VALUES (?, ?, ?, ?, ?)').run(tracker.name, issue.id, delegation.at, link.ticket, delegation.who);
  }

  // Each delegation not yet told to the plans, in order; once told, the
  // issue says what became of it. Plans that do not run yet: the rest waits.
  async #handOver(tracker: Tracker, delegate: MirrorDelegate): Promise<void> {
    const waiting = this.#db.prepare('SELECT * FROM mirror_delegations WHERE tracker = ? AND told_at IS NULL ORDER BY at, rowid').all(tracker.name) as Row[];
    for (const row of waiting) {
      const link = this.#link(String(row.ticket) as TicketId, tracker.name);
      const ticket = link ? await this.#deps.tickets.get(link.ticket) : undefined;
      const told = this.#db.prepare('UPDATE mirror_delegations SET outcome = ?, told_at = ? WHERE tracker = ? AND issue = ? AND at = ?');
      if (!link || !ticket) {
        told.run('gone', this.#iso(), tracker.name, String(row.issue), String(row.at));
        continue;
      }
      const where = this.#db.prepare('SELECT key, url FROM mirror_links WHERE ticket = ? AND tracker = ?').get(link.ticket, tracker.name) as Row;
      const who = String(row.who);
      const outcome = await delegate({ ticket, tracker: tracker.title, key: String(where.key), url: String(where.url), who });
      if (!outcome) return;
      const text = 'plan' in outcome ? this.#t('delegated', { who, ticket: ticket.id, plan: outcome.plan })
        : 'inPlan' in outcome ? this.#t('delegated_in_plan', { who, ticket: ticket.id, plan: outcome.inPlan })
        : this.#t('delegated_in_state', { who, ticket: ticket.id, state: outcome.inState });
      told.run(JSON.stringify(outcome), this.#iso(), tracker.name, String(row.issue), String(row.at));
      this.#paired(ticket.id, tracker.name, null, await tracker.comment(link.issue, text));
    }
  }

  #issueLink(tracker: Tracker, issue: string): Link | undefined {
    const row = this.#db.prepare('SELECT * FROM mirror_links WHERE tracker = ? AND issue = ?').get(tracker.name, issue) as Row | undefined;
    return row ? linkOf(row) : undefined;
  }

  #wroteNear(tracker: string, issue: string, at: string): boolean {
    const writes = this.#db.prepare('SELECT at FROM mirror_writes WHERE tracker = ? AND issue = ?').all(tracker, issue) as Row[];
    return writes.some((w) => Math.abs(Date.parse(String(w.at)) - Date.parse(at)) <= ECHO_WINDOW_MS);
  }

  // ---- the follow-ups: the text and the comments (P237) ---------------

  // The app's side of a field: who made the value the mirror wrote, as
  // mirror_edits keeps it; agents for a value the mirror did not write.
  #localField(ticket: Ticket, field: Field): Side {
    const row = this.#db.prepare('SELECT kind, at FROM mirror_edits WHERE ticket = ? AND field = ? AND value = ? ORDER BY rowid DESC LIMIT 1').get(ticket.id, field, ticket[field]) as Row | undefined;
    return { status: ticket[field], kind: row?.kind === 'human' ? 'human' : 'agents', at: row ? String(row.at) : ticket.updatedAt };
  }

  // Each field as the state is (decide()); the tracker never edits a ticket
  // the owner approved, and an empty title is not written in the app.
  async #settleFields(tracker: Tracker, link: Link, ticket: Ticket): Promise<void> {
    const back: [Field, string][] = [];
    const fieldRow = this.#db.prepare('SELECT * FROM mirror_fields WHERE ticket = ? AND tracker = ? AND field = ?');
    const remoteOf = this.#db.prepare('UPDATE mirror_fields SET remote = ?, remote_kind = ?, remote_who = ?, remote_at = ?, agreed = ? WHERE ticket = ? AND tracker = ? AND field = ?');
    for (const field of FIELDS) {
      const row = fieldRow.get(ticket.id, tracker.name, field) as Row | undefined;
      if (!row) continue;
      const local = this.#localField(ticket, field);
      const remote: Remote = { status: String(row.remote), kind: row.remote_kind === 'human' ? 'human' : 'agents', who: String(row.remote_who), at: String(row.remote_at) };
      const verdict = decide({ agreed: String(row.agreed), local, remote });
      if (verdict === 'none') continue;
      if (verdict === 'agree') {
        this.#db.prepare('UPDATE mirror_fields SET agreed = ? WHERE ticket = ? AND tracker = ? AND field = ?').run(local.status, ticket.id, tracker.name, field);
      } else if (verdict === 'push') {
        await tracker.edit(link.issue, { [field]: local.status });
        remoteOf.run(local.status, 'agents', MIRROR_ACTOR.id, this.#iso(), local.status, ticket.id, tracker.name, field);
      } else if (field === 'title' && !remote.status.trim()) {
        continue;
      } else if (ticket.status === this.#deps.tickets.states.go) {
        back.push([field, local.status]);
      } else {
        await this.#deps.tickets.edit(ticket.id, { [field]: remote.status }, MIRROR_ACTOR);
        this.#db.prepare('INSERT INTO mirror_edits (ticket, field, value, kind, who, tracker, at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ticket.id, field, remote.status, remote.kind, remote.who, tracker.name, remote.at, this.#iso());
        this.#db.prepare('UPDATE mirror_fields SET agreed = ? WHERE ticket = ? AND tracker = ? AND field = ?').run(remote.status, ticket.id, tracker.name, field);
        this.#changed(ticket.id);
      }
    }
    if (back.length === 0) return;
    await tracker.edit(link.issue, Object.fromEntries(back));
    for (const [field, value] of back) remoteOf.run(value, 'agents', MIRROR_ACTOR.id, this.#iso(), value, ticket.id, tracker.name, field);
    this.#paired(ticket.id, tracker.name, null, await tracker.comment(link.issue, this.#t('refused_edit', { ticket: ticket.id })));
  }

  // A tracker's comment on a linked issue, written once in the app as the
  // mirror, with who wrote it and where.
  async #comeIn(tracker: Tracker, comment: TrackerComment): Promise<void> {
    const link = this.#db.prepare('SELECT ticket FROM mirror_links WHERE tracker = ? AND issue = ?').get(tracker.name, comment.issue) as Row | undefined;
    if (!link) return;
    const ticket = String(link.ticket);
    const since = this.#followed(ticket, tracker.name);
    if (since === undefined || Date.parse(comment.at) < Date.parse(since)) return;
    if (this.#db.prepare('SELECT 1 FROM mirror_comments WHERE tracker = ? AND remote = ?').get(tracker.name, comment.id)) return;
    const made = await this.#deps.tickets.comment(ticket, `${this.#t('comment_in', { who: comment.who, tracker: tracker.title })}\n\n${comment.body}`, MIRROR_ACTOR);
    this.#paired(ticket, tracker.name, made.id, comment.id);
    this.#changed(ticket);
  }

  // Who wrote an app's comment, as its first line on a tracker.
  #byLine(comment: Comment): string {
    if (comment.by.kind === 'human') return this.#t('comment_out_owner', { who: comment.by.id });
    if (comment.by.kind === 'other') return this.#t('comment_out_user');
    return this.#t('comment_out_service');
  }

  // The app's comments not yet on this tracker. One that came from another
  // tracker goes as it is; one that came from this one is paired already.
  async #goOut(tracker: Tracker, link: Link, ticket: Ticket, since: string): Promise<void> {
    const paired = this.#db.prepare('SELECT 1 FROM mirror_comments WHERE tracker = ? AND local = ?');
    for (const comment of await this.#deps.tickets.comments(ticket.id)) {
      if (Date.parse(comment.createdAt) < Date.parse(since) || paired.get(tracker.name, comment.id)) continue;
      const mirrored = comment.by.kind === 'agents' && comment.by.id === MIRROR_ACTOR.id;
      const remote = await tracker.comment(link.issue, mirrored ? comment.body : `${this.#byLine(comment)}\n\n${comment.body}`);
      this.#paired(ticket.id, tracker.name, comment.id, remote);
    }
  }
}

// The mirror the settings ask for: a GitHub tracker per repository of the
// workspace's services (a service of a monorepo shares its repository's),
// a Linear tracker for the team; none without settings.
export function createMirror(config: MirrorConfig | undefined, deps: {
  readonly db: DatabaseSync; readonly tickets: TicketStore; readonly project: string;
  readonly services: readonly { readonly name: string; readonly repo: string }[];
  readonly flow?: () => MirrorFlow | undefined; readonly now?: () => Date; readonly log?: (line: string) => void;
  readonly changed?: (ticket: TicketId) => void; readonly delegate?: MirrorDelegate;
}): Mirror | undefined {
  if (!config) return undefined;
  const trackers: Tracker[] = [];
  const states = deps.tickets.states;
  const delegationLabel = config.delegation?.label ?? DELEGATION_LABEL;
  if (config.github) {
    const seen = new Set<string>();
    for (const service of deps.services) {
      if (seen.has(service.repo)) continue;
      seen.add(service.repo);
      trackers.push(new GitHubTracker({ api: config.github.api, token: config.github.token, repo: service.repo, service: service.name, states, delegationLabel }));
    }
  }
  if (config.linear) trackers.push(new LinearTracker({ api: config.linear.api, token: config.linear.token, team: config.linear.team, states, delegationLabel }));
  return new Mirror({
    db: deps.db, tickets: deps.tickets, trackers, project: deps.project, services: deps.services.map((s) => s.name), language: config.language,
    ...(deps.flow ? { flow: deps.flow } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}),
    ...(deps.changed ? { changed: deps.changed } : {}), ...(deps.delegate && config.delegation ? { delegate: deps.delegate } : {}),
  });
}
