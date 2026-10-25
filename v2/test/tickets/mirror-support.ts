// What the mirror's tests share: the real ticket store with the owner's
// signing key, and a tracker kept in memory whose issues a test moves,
// edits, comments and hands over to Cleared (C3) as a person, an agent or
// the mirror itself.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { applyTables } from '../../src/store/db.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { MIRROR_TABLES, type Tracker, type TrackerChange, type TrackerComment, type TrackerDelegation, type TrackerEdit, type TrackerIssue } from '../../src/tickets/mirror.ts';
import { OWNER, keyPair, scratch } from '../approval/harness.ts';

export const OWNER_USER = 'user-uuid-1';
export const GUEST_USER = 'user-uuid-2';
export const AGENTS = { kind: 'agents' as const, id: 'cleared-v2' };
export const HUMAN = { kind: 'human' as const, id: OWNER_USER };

// A clock a test moves by hand, one second a tick by default.
export class Clock {
  #at: number;
  constructor(start = '2026-10-25T09:00:00.000Z') { this.#at = Date.parse(start); }
  get iso(): string { return new Date(this.#at).toISOString(); }
  now = (): Date => new Date(this.#at);
  tick(seconds = 1): string {
    this.#at += seconds * 1000;
    return this.iso;
  }
}

export function openStore(clock: Clock) {
  const dir = scratch('cleared-mirror-');
  const keys = keyPair();
  const keyFile = join(dir, 'signing.key');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  const db = new DatabaseSync(join(dir, 'ledger.db'));
  applyTables(db, [...TICKET_TABLES, ...MIRROR_TABLES]);
  const users = new MemoryUsers();
  users.users.set(OWNER_USER, { id: OWNER_USER, name: OWNER });
  users.users.set(GUEST_USER, { id: GUEST_USER, name: 'guest' });
  const store = new LocalTicketStore(db, {
    stateDir: dir, ownerId: OWNER, users, signer: ApprovalSigner.load(keyFile), publicKey: keys.publicKey, now: () => clock.iso,
  });
  return { db, store, dir };
}

type Held = { issue: TrackerIssue; comments: TrackerComment[] };
type Actor = TrackerChange['actor'];

// A tracker in memory. The mirror's own calls are recorded and stamped as
// the mirror's changes; a test makes a person's or an agent's with act().
export class MemoryTracker implements Tracker {
  readonly name: string;
  readonly title: string;
  readonly service?: string;
  readonly calls: string[] = [];
  readonly issues = new Map<string, Held>();
  failing = false;
  #clock: Clock;
  #next = 1;
  #comment = 1;

  constructor(clock: Clock, options: { name?: string; title?: string; service?: string } = {}) {
    this.#clock = clock;
    this.name = options.name ?? 'memory:team';
    this.title = options.title ?? 'Linear';
    if (options.service) this.service = options.service;
  }

  #fail(): void {
    if (this.failing) throw new Error('the tracker is down');
  }

  #held(id: string): Held {
    const held = this.issues.get(id);
    if (!held) throw new Error(`no issue ${id}`);
    return held;
  }

  #change(id: string, status: string | null, change: Omit<TrackerChange, 'status' | 'at'> | null): void {
    const held = this.#held(id);
    const at = this.#clock.iso;
    const changes = status !== null && change ? [...held.issue.changes, { ...change, status, at }] : held.issue.changes;
    held.issue = { ...held.issue, status, updatedAt: at, changes };
  }

  // A person's or an agent's issue, made on the tracker.
  open(input: { title: string; body?: string; labels?: string[]; status: string | null }): TrackerIssue {
    const id = `ISS-${this.#next++}`;
    const at = this.#clock.iso;
    const issue: TrackerIssue = {
      id, key: id, url: `https://tracker.example/${id}`, title: input.title, body: input.body ?? '', labels: input.labels ?? [],
      status: input.status, createdAt: at, updatedAt: at, changes: [], edits: [],
    };
    this.issues.set(id, { issue, comments: [] });
    return issue;
  }

  // A move on the tracker by someone other than the mirror.
  act(id: string, status: string | null, actor: 'person' | 'agent' | 'mirror' = 'person', who = actor === 'person' ? 'jane' : 'integration'): void {
    this.#change(id, status, { actor, who });
  }

  // An edit on the tracker by someone other than the mirror; an actor of
  // null leaves no record of who made it, as GitHub does for a description.
  editBy(id: string, fields: { title?: string; body?: string }, actor: Actor | null = 'person', who = actor === 'person' ? 'jane' : 'integration'): void {
    const held = this.#held(id);
    const at = this.#clock.iso;
    const edits: TrackerEdit[] = actor === null ? [] : (['title', 'body'] as const).filter((f) => fields[f] !== undefined).map((field) => ({ field, actor, who, at }));
    held.issue = { ...held.issue, ...fields, updatedAt: at, edits: [...held.issue.edits, ...edits] };
  }

  // The issue handed over to Cleared now (the delegation label put on, or
  // the issue assigned to the mirror's account), or taken back.
  delegate(id: string, actor: Actor = 'person', who = actor === 'person' ? 'jane' : 'integration', how: TrackerDelegation['how'] = 'label'): string {
    const held = this.#held(id);
    const at = this.#clock.iso;
    held.issue = { ...held.issue, updatedAt: at, delegation: { how, actor, who, at } };
    return at;
  }

  undelegate(id: string): void {
    const held = this.#held(id);
    held.issue = { ...held.issue, updatedAt: this.#clock.iso, delegation: null };
  }

  // A comment on the tracker by someone other than the mirror. It does not
  // change the issue's time: the mirror reads comments by their own.
  say(id: string, body: string, actor: Actor = 'person', who = actor === 'person' ? 'jane' : 'integration'): string {
    const comment: TrackerComment = { id: `C-${this.#comment++}`, issue: id, body, actor, who, at: this.#clock.iso };
    this.#held(id).comments.push(comment);
    return comment.id;
  }

  async changed(since: string): Promise<TrackerIssue[]> {
    this.calls.push(`changed ${since}`);
    this.#fail();
    return [...this.issues.values()].map((h) => h.issue).filter((i) => i.updatedAt >= since);
  }

  async create(input: { title: string; body: string; labels: readonly string[]; status: string }): Promise<TrackerIssue> {
    this.calls.push(`create ${input.title} ${input.status}`);
    this.#fail();
    const issue = this.open({ title: input.title, body: input.body, labels: [...input.labels], status: input.status });
    this.#change(issue.id, input.status, { actor: 'mirror', who: 'cleared-bot' });
    // A ticket's own `cleared` label, put on by the mirror's account as GitHub would say it.
    if (input.labels.some((l) => l.toLowerCase() === 'cleared')) this.delegate(issue.id, 'mirror', 'cleared-bot');
    return this.#held(issue.id).issue;
  }

  async move(id: string, status: string): Promise<void> {
    this.calls.push(`move ${id} ${status}`);
    this.#fail();
    this.#change(id, status, { actor: 'mirror', who: 'cleared-bot' });
  }

  async edit(id: string, fields: { title?: string; body?: string }): Promise<void> {
    this.calls.push(`edit ${id} ${Object.keys(fields).join(',')}`);
    this.#fail();
    this.editBy(id, fields, 'mirror', 'cleared-bot');
  }

  async comment(id: string, body: string): Promise<string> {
    this.calls.push(`comment ${id}`);
    this.#fail();
    return this.say(id, body, 'mirror', 'cleared-bot');
  }

  async commentsSince(since: string): Promise<TrackerComment[]> {
    this.calls.push(`comments ${since}`);
    this.#fail();
    return [...this.issues.values()].flatMap((h) => h.comments).filter((c) => c.at >= since);
  }

  status(id: string): string | null {
    return this.#held(id).issue.status;
  }

  issue(id: string): TrackerIssue {
    return this.#held(id).issue;
  }

  // The bodies of the issue's comments, oldest first.
  comments(id: string): string[] {
    return this.#held(id).comments.map((c) => c.body);
  }
}
