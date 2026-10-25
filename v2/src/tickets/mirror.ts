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
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../../app/src/catalog.ts';
import { translator, type Translate } from '../../app/web/lib/i18n.ts';
import type { UserId } from '../session/contract.ts';
import type { Actor, Ticket, TicketId, TicketStore } from './contract.ts';
import { GitHubTracker } from './mirror-github.ts';
import { LinearTracker } from './mirror-linear.ts';
import type { Tracker, TrackerIssue } from './mirror-tracker.ts';

export { TrackerError, type Tracker, type TrackerChange, type TrackerIssue } from './mirror-tracker.ts';

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
];

// ---- the rule ----------------------------------------------------------

// One side's state and who last made it: a person, or agents (the service,
// the flow, an integration, anyone the side cannot name).
export type Side = { readonly status: string; readonly kind: 'human' | 'agents'; readonly at: string };
export type Verdict = 'none' | 'agree' | 'push' | 'pull';

// push: the app's state is written on the tracker; pull: the tracker's in
// the app. A remote of null is a state the app does not have: no change.
export function decide(input: { readonly agreed: string; readonly local: Side; readonly remote: Side | null }): Verdict {
  const { agreed, local, remote } = input;
  const localChanged = local.status !== agreed;
  const remoteChanged = remote !== null && remote.status !== agreed;
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
  const github = githubFile
    ? { api: apiFrom('CLEARED_V2_MIRROR_GITHUB_API', env.CLEARED_V2_MIRROR_GITHUB_API, GITHUB_API), token: tokenFrom('CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE', githubFile) }
    : undefined;
  return {
    pollMs: poll * 1000, language: env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr',
    ...(github ? { github } : {}), ...(linear ? { linear } : {}),
  };
}

// ---- the pass ----------------------------------------------------------

// What the mirror asks of the flow (flow/engine.ts): whether it works on a
// ticket, and to set one aside with the mirror's words.
export type MirrorFlow = {
  isActive(ticket: TicketId): boolean;
  setAside(ticket: TicketId, by: UserId, words: { readonly note: string; readonly message: string }): Promise<unknown>;
};

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
    }
    for (const ticket of await this.#deps.tickets.list({ project: this.#deps.project })) {
      if (Date.parse(ticket.createdAt) < Date.parse(startedAt) || !this.#holds(tracker, ticket) || this.#link(ticket.id, tracker.name)) continue;
      await this.#export(tracker, ticket);
    }
    for (const row of this.#db.prepare('SELECT * FROM mirror_links WHERE tracker = ? ORDER BY rowid').all(tracker.name) as Row[]) {
      const link = linkOf(row);
      const ticket = await this.#deps.tickets.get(link.ticket);
      if (ticket) await this.#settle(tracker, link, ticket);
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
    if (issue.status === null) {
      this.#db.prepare('UPDATE mirror_links SET remote = NULL WHERE ticket = ? AND tracker = ?').run(link.ticket, tracker.name);
      return;
    }
    const remote = this.#remoteOf(tracker, issue, issue.status);
    // An older state the mirror wrote itself: a stale read, not a change.
    if (remote.echo && remote.status !== link.agreed) return;
    this.#setRemote(link, remote);
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
    if (wanted === states.go) await this.#putBack(tracker, { ticket: ticket.id, tracker: tracker.name, issue: issue.id }, { ...ticket, status }, 'refused_go', wanted);
  }

  async #export(tracker: Tracker, ticket: Ticket): Promise<void> {
    const made = await tracker.create({ title: ticket.title, body: ticket.body, labels: ticket.labels, status: ticket.status });
    this.#wrote(tracker.name, made.id, ticket.status);
    this.#db.prepare('INSERT INTO mirror_links (ticket, tracker, issue, key, url, agreed, remote, remote_kind, remote_who, remote_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket.id, tracker.name, made.id, made.key, made.url, ticket.status, ticket.status, 'agents', MIRROR_ACTOR.id, this.#iso());
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
  }

  async #putBack(tracker: Tracker, link: Pick<Link, 'ticket' | 'tracker' | 'issue'>, ticket: Ticket, why: 'refused_go' | 'refused_approved' | 'refused_landing', asked: string): Promise<void> {
    await this.#push(tracker, link, ticket.status);
    const values = { state: asked, back: ticket.status, ticket: ticket.id };
    const text = why === 'refused_go' ? this.#t('refused_go', values) : why === 'refused_approved' ? this.#t('refused_approved', values) : this.#t('refused_landing', values);
    await tracker.comment(link.issue, text);
  }
}

// The mirror the settings ask for: a GitHub tracker per repository of the
// workspace's services (a service of a monorepo shares its repository's),
// a Linear tracker for the team; none without settings.
export function createMirror(config: MirrorConfig | undefined, deps: {
  readonly db: DatabaseSync; readonly tickets: TicketStore; readonly project: string;
  readonly services: readonly { readonly name: string; readonly repo: string }[];
  readonly flow?: () => MirrorFlow | undefined; readonly now?: () => Date; readonly log?: (line: string) => void;
}): Mirror | undefined {
  if (!config) return undefined;
  const trackers: Tracker[] = [];
  const states = deps.tickets.states;
  if (config.github) {
    const seen = new Set<string>();
    for (const service of deps.services) {
      if (seen.has(service.repo)) continue;
      seen.add(service.repo);
      trackers.push(new GitHubTracker({ api: config.github.api, token: config.github.token, repo: service.repo, service: service.name, states }));
    }
  }
  if (config.linear) trackers.push(new LinearTracker({ api: config.linear.api, token: config.linear.token, team: config.linear.team, states }));
  return new Mirror({
    db: deps.db, tickets: deps.tickets, trackers, project: deps.project, services: deps.services.map((s) => s.name), language: config.language,
    ...(deps.flow ? { flow: deps.flow } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}),
  });
}
