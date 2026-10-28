// Learning from past sessions (issue #455): once a night per service, the
// reviewers' change requests of its sessions are read again, the defects
// that came back on two tickets or more are grouped, and each group is
// proposed as a knowledge item that cites the sessions it came from. The
// item is the handovers' (service.ts): only the owner's Approve writes it
// into the memory and queues it for the service's skill, whose daily
// ticket lands through the lock. The pass itself writes nothing else.
//
//   Read: the requests on the review channel (flow/engine.ts journals each
//   on the reviewer's session and on the author's; the reviewer's alone is
//   read), from DREAM_DAYS back, the newest first, at most MAX_REPORTS.
//   A request's defects are the lines of its Defects section (defectsOf).
//
//   Grouped: by their words (fingerprint.ts), one source per ticket, the
//   newest session of each. A group with fewer than MIN_SOURCES tickets is
//   no proposal: a reviewer resumed over its rounds is one session, and two
//   reviewers of one ticket are one ticket.
//
//   Left out: a defect that holds anything that looks like a secret, or
//   that the cleaner would change, whatever group it is in; a group whose
//   rule the owner rejected, approved, or has waiting, under any wording
//   with the same words. Then at most MAX_PROPOSALS per service, the groups
//   seen on the most tickets first.
//
// No model is called: the pass reads and compares words, so it spends no
// quota. It still waits below the week stop, as the plans and the
// schedules do (CLEARED_V2_WEEK_STOP_PERCENT), and the owner turns it off
// per service.
import type { DatabaseSync } from 'node:sqlite';
import type { DreamingView, DreamOutcome, KnowledgeItem, KnowledgeSource } from '../api/types.ts';
import { quotaStop } from '../consumption/quota.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { User } from '../modules/registry.ts';
import { TOKEN_PATTERNS } from '../profiles/store.ts';
import { GUARD_PATTERNS } from '../session/clean.ts';
import type { WorkspaceConfig } from '../workspace/config.ts';
import { SAME_RULE, fingerprint, likeness, words } from './fingerprint.ts';
import { MAX_PROPOSAL } from './proposals.ts';
import { KnowledgeError } from './service.ts';
import { KnowledgeStore } from './store.ts';

export { fingerprint } from './fingerprint.ts';

// The ticket of the pass's proposals, which no ticket of a tracker has.
export const DREAM_TICKET = 'dreaming';
// The hour of the server's day from which the pass runs, before the skill tickets (SKILL_HOUR).
export const DREAM_HOUR = 2;
export const DREAM_DAYS = 30;
export const MAX_REPORTS = 500;
export const MIN_SOURCES = 2;
export const MAX_PROPOSALS = 5;
// The most sources a proposal cites, the newest.
export const MAX_SOURCES = 10;
// A defect with fewer words says too little to be a rule.
const MIN_WORDS = 4;

export const DREAMING_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dreaming_settings (
  service TEXT PRIMARY KEY, enabled INTEGER NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS dreaming_passes (
  service TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, proposed INTEGER NOT NULL,
  PRIMARY KEY (service, day)
)`,
];

export type DreamPass = { readonly service: string; readonly outcome: DreamOutcome | 'off'; readonly proposed: number };

export type DreamingDeps = {
  readonly db: DatabaseSync;
  readonly inbox: InboxStore;
  readonly workspace: WorkspaceConfig;
  readonly project: string;                              // the sessions' project, as the quota reads it
  readonly ownerId: string | undefined;                  // [tracker] owner_id: the one user who turns the pass on or off
  readonly clean: (text: string) => string;
  readonly weekStopPercent: () => number;
  readonly now?: () => Date;
};

// ---- the defects of a report -------------------------------------------------

// A label of the report's end (flow/prompts.ts reviewPrompt), maybe in bold or as a list item.
const LABEL = /^\s*(?:[-*+]\s+)?\**\s*(verdict|defects|tests|to verify|questions for the user)\s*\**\s*:\s*\**\s*(.*)$/i;
const LIST_MARK = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
// The `file:line` a defect starts with, as the prompt asks for it.
const LEADING_PLACE = /^`?[^\s`]+:\d+(?:-\d+)?`?\s*[,:;.–-]?\s*/;

// The lines of the report's Defects section, each without its list mark
// and its file and line; none for "None."
export function defectsOf(report: string): string[] {
  const out: string[] = [];
  let inside = false;
  const take = (line: string) => {
    const text = line.replace(LIST_MARK, '').replace(LEADING_PLACE, '').trim();
    if (text !== '' && !/^none\.?$/i.test(text)) out.push(text.length <= MAX_PROPOSAL ? text : text.slice(0, MAX_PROPOSAL));
  };
  for (const line of report.split('\n')) {
    const label = LABEL.exec(line);
    if (label) {
      inside = (label[1] as string).toLowerCase() === 'defects';
      if (inside) take(label[2] as string);
    } else if (inside) take(line);
  }
  return out;
}

// ---- no secret ---------------------------------------------------------------

const SECRET_SHAPES = [...GUARD_PATTERNS, ...TOKEN_PATTERNS].map(([, pattern]) => pattern);

// A text that looks like it holds a secret, or that the cleaner already
// cut or would change: such a defect is never part of a proposal.
function looksSensitive(text: string, clean: (text: string) => string): boolean {
  return text.includes('[removed') || SECRET_SHAPES.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '') + 'm').test(text)) || clean(text) !== text;
}

// ---- the pass ----------------------------------------------------------------

type Defect = { readonly text: string; readonly words: string[]; readonly source: KnowledgeSource };
type Group = { readonly rule: Defect; readonly defects: Defect[] };

type Row = Record<string, unknown>;

function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// One source per ticket, the newest session of each, newest first.
function sourcesOf(group: Group): KnowledgeSource[] {
  const byTicket = new Map<string, KnowledgeSource>();
  for (const { source } of group.defects) if (!byTicket.has(source.ticket)) byTicket.set(source.ticket, source);
  return [...byTicket.values()];
}

export class Dreaming {
  readonly #deps: DreamingDeps;
  readonly #knowledge: KnowledgeStore;
  readonly #now: () => Date;
  #running: Promise<DreamPass[]> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: DreamingDeps) {
    this.#deps = deps;
    this.#knowledge = new KnowledgeStore(deps.db);
    this.#now = deps.now ?? (() => new Date());
  }

  #enabled(service: string): boolean {
    const row = this.#deps.db.prepare('SELECT enabled FROM dreaming_settings WHERE service = ?').get(service) as Row | undefined;
    return row === undefined || Number(row.enabled) === 1;
  }

  view(): DreamingView {
    const last = this.#deps.db.prepare('SELECT at, outcome, proposed FROM dreaming_passes WHERE service = ? ORDER BY at DESC LIMIT 1');
    return {
      services: this.#deps.workspace.services.map(({ name }) => {
        const row = last.get(name) as Row | undefined;
        return { service: name, enabled: this.#enabled(name), last: row ? { at: String(row.at), outcome: String(row.outcome) as DreamOutcome, proposed: Number(row.proposed) } : null };
      }),
    };
  }

  // On or off for one service: the owner's, as Approve is.
  set(service: string, enabled: boolean, user: User): void {
    const owner = this.#deps.ownerId;
    if (!owner) throw new KnowledgeError('unavailable', 'knowledge is not set up: no [tracker] owner_id (npm run setup)');
    if (user.name !== owner) throw new KnowledgeError('forbidden', `only the owner (${owner}) turns the nightly pass on or off`);
    if (!this.#deps.workspace.services.some(({ name }) => name === service)) throw new KnowledgeError('not_found', `${service} is not a service of the workspace ${this.#deps.workspace.id}`);
    this.#deps.db.prepare('INSERT OR REPLACE INTO dreaming_settings (service, enabled, set_by, set_at) VALUES (?, ?, ?, ?)')
      .run(service, enabled ? 1 : 0, user.id, this.#now().toISOString());
  }

  // The reviewers' requests of the window, the newest first, each read as its service's.
  #defects(since: string): Map<string, Defect[]> {
    const first = this.#deps.workspace.services[0]?.name;
    const rows = this.#deps.db.prepare(`SELECT e.session_id AS session, e.ticket AS ticket, e.at AS at, s.service AS service,
        json_extract(e.event, '$.value.text') AS text
      FROM session_events e JOIN sessions s ON s.id = e.session_id
      WHERE e.project = ? AND e.type = 'CUSTOM' AND e.at >= ? AND s.role = 'reviewer'
        AND json_extract(e.event, '$.name') = 'cleared.review_channel' AND json_extract(e.event, '$.value.from') = 'reviewer'
      ORDER BY e.at DESC, e.rowid DESC LIMIT ?`).all(this.#deps.project, since, MAX_REPORTS) as Row[];
    const out = new Map<string, Defect[]>();
    for (const row of rows) {
      const service = row.service === null || row.service === undefined ? first : String(row.service);
      if (!service || typeof row.text !== 'string') continue;
      const source: KnowledgeSource = { session: String(row.session), ticket: String(row.ticket), at: String(row.at) };
      for (const text of defectsOf(row.text)) {
        const found = words(text);
        if (found.length < MIN_WORDS || looksSensitive(text, this.#deps.clean)) continue;
        out.set(service, [...(out.get(service) ?? []), { text, words: found, source }]);
      }
    }
    return out;
  }

  // The rules the owner already answered or has waiting: every knowledge
  // item's, every approved entry's, every rejected one's.
  #known(): string[][] {
    const items = [...this.#deps.inbox.knowledge(), ...this.#deps.inbox.knowledge({ state: 'handled' })].map((item) => item.text);
    return [
      ...[...items, ...this.#knowledge.approvedTexts()].map(words),
      ...this.#knowledge.rejectedFingerprints().map((print) => print === '' ? [] : print.split(' ')),
    ];
  }

  // The proposals of one service's defects, the newest first.
  #propose(service: string, defects: readonly Defect[]): KnowledgeItem[] {
    const groups: Group[] = [];
    for (const defect of defects) {
      const group = groups.find((candidate) => likeness(candidate.rule.words, defect.words) >= SAME_RULE);
      if (group) group.defects.push(defect);
      else groups.push({ rule: defect, defects: [defect] });
    }
    const known = this.#known();
    const isKnown = (group: Group) => group.defects.some((defect) => known.some((other) => likeness(defect.words, other) >= SAME_RULE));
    const items: KnowledgeItem[] = [];
    const ranked = groups.map((group) => ({ group, sources: sourcesOf(group) })).filter(({ sources }) => sources.length >= MIN_SOURCES)
      .sort((a, b) => b.sources.length - a.sources.length);
    for (const { group, sources } of ranked) {
      if (items.length >= MAX_PROPOSALS) break;
      if (isKnown(group)) continue;
      const text = group.rule.text;
      // Read again as it would be stored: nothing that looks like a secret leaves.
      if (looksSensitive(text, this.#deps.clean)) continue;
      items.push(this.#deps.inbox.addDreamed({ ticket: DREAM_TICKET, project: this.#deps.workspace.id, service, text, sources: sources.slice(0, MAX_SOURCES) }));
      known.push(group.rule.words);
    }
    return items;
  }

  #record(service: string, day: string, outcome: DreamOutcome, proposed: number): void {
    this.#deps.db.prepare('INSERT OR REPLACE INTO dreaming_passes (service, day, at, outcome, proposed) VALUES (?, ?, ?, ?, ?)')
      .run(service, day, this.#now().toISOString(), outcome, proposed);
  }

  #doneOn(service: string, day: string): boolean {
    return this.#deps.db.prepare("SELECT 1 FROM dreaming_passes WHERE service = ? AND day = ? AND outcome = 'done'").get(service, day) !== undefined;
  }

  // From DREAM_HOUR, the pass of each service not done that day, in the
  // workspace's order: off, skipped at the week stop (tried again at the
  // next tick), or done with the proposals it made.
  async tick(): Promise<DreamPass[]> {
    if (this.#running) return this.#running;
    this.#running = Promise.resolve().then(() => this.#tick());
    try {
      return await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  #tick(): DreamPass[] {
    const now = this.#now();
    if (now.getHours() < DREAM_HOUR) return [];
    const day = dayOf(now);
    const due = this.#deps.workspace.services.map(({ name }) => name).filter((name) => !this.#doneOn(name, day));
    if (due.length === 0) return [];
    const passes: DreamPass[] = [];
    const on = due.filter((name) => {
      if (this.#enabled(name)) return true;
      passes.push({ service: name, outcome: 'off', proposed: 0 });
      return false;
    });
    if (on.length === 0) return this.#ordered(passes);
    if (quotaStop(this.#deps.db, { project: this.#deps.project, now, limit: this.#deps.weekStopPercent() })) {
      for (const name of on) {
        this.#record(name, day, 'quota', 0);
        passes.push({ service: name, outcome: 'quota', proposed: 0 });
      }
      return this.#ordered(passes);
    }
    const defects = this.#defects(new Date(now.getTime() - DREAM_DAYS * 86_400_000).toISOString());
    for (const name of on) {
      const proposed = this.#propose(name, defects.get(name) ?? []).length;
      this.#record(name, day, 'done', proposed);
      passes.push({ service: name, outcome: 'done', proposed });
    }
    return this.#ordered(passes);
  }

  #ordered(passes: DreamPass[]): DreamPass[] {
    const order = this.#deps.workspace.services.map(({ name }) => name);
    return passes.sort((a, b) => order.indexOf(a.service) - order.indexOf(b.service));
  }

  startTimer(ms: number): void {
    if (this.#timer) return;
    const run = () => { void this.tick().catch((error) => console.error(`cleared-v2: the nightly pass failed (${error instanceof Error ? error.name : typeof error})`)); };
    this.#timer = setInterval(run, ms);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
