// A read-only question to the code, or to the platform, with its cost
// (docs/v2/milestone-2-plan.md, decision 28, lane 25).
//
//   An ask is one row of the asks table and, while it is live, one reader
//   session: role `reader`, on a folder holding every named service at its
//   base branch, read only (the reader policy of session/policy.ts and the
//   read-only mark of container/session-runtime.ts). It is started here,
//   through the registry's adapter, never by the flow: a reader has no
//   ticket, no review and no publish, and the flow's tick, idle rule and
//   restart recovery leave its role alone.
//
//   POST /api/asks answers at once with the ask `starting`; the start runs
//   in the background. Each turn's answer is the assistant's text of that
//   turn; its cost is the session's total at the turn's end minus the total
//   at the end of the turn before (Claude Code's result carries the
//   session's running total), its tokens the turn's usage. A follow-up is
//   sent to the live session, or, once the idle rule stopped it, to a new
//   one briefed with the turns before. The week share is the seven-day
//   window as the reader's session last reported it. The code an answer
//   cites is checked and linked before the turn is written (citations.ts,
//   P215): the app never sees an answer without its links.
//
//   Nobody answers a reader's requests: the policy refuses what would ask,
//   and a question or a request that still reaches the service is refused
//   at once, so a reader never waits.
import { randomUUID } from 'node:crypto';
import type { Ask, AskAnswer } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { SessionAdapter, SessionHandle, SessionId, StartInput, UserId } from '../session/contract.ts';
import type { SessionEvent, Usage } from '../session/events.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import { readerBriefing, readerPrompt } from './briefing.ts';
import { citationsOf } from './citations.ts';
import { AskStore, type AskRecord } from './store.ts';
import { ReaderError, excerpt, parseTarget, type AskTarget } from './target.ts';

export const MAX_QUESTION = 4000;
export const MAX_LIVE = 3;
// An ask's id, which stands for its ticket in the session row: no tracker
// gives a ticket this form, nor the lead's.
export const READER_TICKET_PREFIX = 'ask-';
const TICK_MS = 30_000;
const HARNESS = 'claude-code' as const;

// What the reader does on the host (workdir.ts): a file of a service at its
// base branch; the lines of a file at a commit, for a citation; the ask's
// folder, made again for each session, with the commit each service was
// exported at; and, at a stop, the folder, the session's containers and its
// config volume removed.
export type ReaderEffects = {
  fileAt(service: string, path: string): Promise<string>;
  linesAt(service: string, commit: string, path: string): Promise<number>;
  prepare(input: { readonly id: string; readonly services: readonly string[]; readonly briefing: string }): Promise<{ readonly dir: string; readonly commits: Readonly<Record<string, string>> }>;
  release(input: { readonly id: string; readonly session: SessionId | null }): Promise<void>;
};

// A service as the reader names it: its repository (owner/name) and, for a
// folder of a monorepo, that folder, for the links of its citations.
export type ReaderServiceInfo = { readonly name: string; readonly base: string; readonly repo: string; readonly path: string | null };

export type ReaderDeps = {
  readonly store: Pick<Store, 'db' | 'events' | 'sessions'>;
  readonly adapter: SessionAdapter;
  readonly effects: ReaderEffects;
  readonly workspace: { readonly id: string; readonly services: readonly ReaderServiceInfo[] };
  readonly model: string;
  readonly idleMs: number;
  readonly maxLive?: number;
  readonly now?: () => Date;
  readonly clean?: (text: string) => string;
};

type Live = {
  readonly ask: string;
  readonly handle: SessionHandle;
  readonly startedAt: string;
  readonly commits: Readonly<Record<string, string>>;   // what its folder was exported at
  lastActivity: number;
  total: number;                         // the session's cost at the end of its last turn
  text: string[];                        // the assistant's text of the turn that runs
  readonly open: Map<string, string>;    // assistant messages being written
  running: boolean;
  ending: boolean;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
const inputOf = (usage: readonly Usage[]) => usage.reduce((sum, u) => sum + (u.inputTokens ?? 0) + (u.cachedInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0), 0);
const outputOf = (usage: readonly Usage[]) => usage.reduce((sum, u) => sum + (u.outputTokens ?? 0), 0);

export class ReaderService {
  readonly #deps: ReaderDeps;
  readonly #asks: AskStore;
  readonly #live = new Map<string, Live>();         // by ask
  readonly #starting = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(deps: ReaderDeps) {
    this.#deps = deps;
    this.#asks = new AskStore(deps.store.db);
    recoverAsks({ store: deps.store, effects: deps.effects, project: deps.workspace.id, at: this.#at() });
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #at(): string {
    return this.#now().toISOString();
  }

  #clean(text: string): string {
    return this.#deps.clean ? this.#deps.clean(text) : text;
  }

  get(id: string): Ask | undefined {
    const record = this.#asks.get(id);
    if (!record || record.project !== this.#deps.workspace.id) return undefined;
    const { project: _project, ...ask } = record;
    return ask;
  }

  async ask(body: { readonly question: string; readonly service?: string; readonly target?: string }, by: UserId): Promise<Ask> {
    const question = this.#question(body.question);
    const target = body.target === undefined ? undefined : parseTarget(body.target);
    if (target && body.service !== undefined && body.service !== target.service) throw new ReaderError('invalid', `the target names ${target.service}, not ${body.service}`);
    const service = target?.service ?? body.service ?? null;
    if (service !== null && !this.#deps.workspace.services.some((s) => s.name === service)) throw new ReaderError('invalid', `${service} is not a service of the workspace ${this.#deps.workspace.id}`);
    // Read before anything is written: a file the base does not hold, or a line past its end, is refused here.
    const lines = target ? excerpt(await this.#deps.effects.fileAt(target.service, target.path), target.line) : undefined;
    this.#room();
    const id = `${READER_TICKET_PREFIX}${randomUUID()}`;
    this.#asks.create({ id, project: this.#deps.workspace.id, question, service, target: target ?? null, by, at: this.#at() });
    const services = this.#servicesOf(service);
    this.#launch(id, readerPrompt({ question, services, target, excerpt: lines && { ...lines, text: this.#clean(lines.text) } }));
    return this.get(id) as Ask;
  }

  async follow(id: string, text: string, by: UserId): Promise<Ask> {
    const question = this.#question(text);
    const ask = this.#asks.get(id);
    if (!ask || ask.project !== this.#deps.workspace.id) throw new ReaderError('not_found', `no ask ${id}`);
    if (ask.state === 'starting' || ask.state === 'running') throw new ReaderError('conflict', 'a turn of this ask runs: wait for its answer');
    const turns: AskAnswer[] = [...ask.turns, { question, answer: null, at: this.#at(), costUsd: null, inputTokens: 0, outputTokens: 0, citations: [] }];
    const live = this.#live.get(id);
    if (live && !live.ending) {
      live.running = true;
      live.text = [];
      live.lastActivity = this.#now().getTime();
      this.#asks.update(id, { state: 'running', turns, at: this.#at() });
      this.#row(live, 'working');
      try {
        await live.handle.send({ text: question, by });
      } catch (error) {
        console.error(`cleared-v2: a follow-up could not be sent to the reader of ${id} (${errorName(error)})`);
        await this.#end(live, 'failed');
      }
      return this.get(id) as Ask;
    }
    this.#room();
    this.#asks.update(id, { state: 'starting', session: null, turns, at: this.#at() });
    const earlier = ask.turns.map((turn) => ({ question: turn.question, answer: turn.answer }));
    this.#launch(id, readerPrompt({ question, services: this.#servicesOf(ask.service), earlier }));
    return this.get(id) as Ask;
  }

  // The idle rule: a reader with no activity for idleMs is stopped.
  async tick(): Promise<void> {
    const now = this.#now().getTime();
    for (const live of [...this.#live.values()]) {
      if (live.ending || now - live.lastActivity < this.#deps.idleMs) continue;
      await this.#end(live, 'stopped');
    }
  }

  startTimer(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => {
      this.tick().catch((error) => console.error(`cleared-v2: the readers' idle check failed (${errorName(error)})`));
    }, TICK_MS);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // ---- internals -------------------------------------------------------------------

  #question(text: string): string {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_QUESTION) throw new ReaderError('invalid', `a question is a non-empty text of at most ${MAX_QUESTION} characters`);
    return text.trim();
  }

  #servicesOf(service: string | null): string[] {
    return service === null ? this.#deps.workspace.services.map((s) => s.name) : [service];
  }

  #room(): void {
    if (this.#live.size + this.#starting.size >= (this.#deps.maxLive ?? MAX_LIVE))
      throw new ReaderError('conflict', `${this.#deps.maxLive ?? MAX_LIVE} questions are being answered: ask again once one is answered`);
  }

  #policy(service: string | null): Policy {
    const base = this.#deps.workspace.services.find((s) => s.name === service)?.base ?? this.#deps.workspace.services[0]?.base ?? 'main';
    return {
      role: 'reader', base, workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
    };
  }

  // Starts a session for the ask in the background; the ask fails, and
  // what was made is removed, when it cannot start.
  #launch(id: string, prompt: string): void {
    this.#starting.add(id);
    void (async () => {
      const ask = this.#asks.get(id) as AskRecord;
      try {
        const services = this.#servicesOf(ask.service);
        const named = this.#deps.workspace.services.filter((s) => services.includes(s.name));
        const { dir: workdir, commits } = await this.#deps.effects.prepare({ id, services, briefing: readerBriefing({ workspace: this.#deps.workspace.id, services: named }) });
        const input: StartInput = {
          project: this.#deps.workspace.id, ticket: id, role: 'reader', harness: HARNESS, model: this.#deps.model, workdir,
          briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
          policy: this.#policy(ask.service), prompt, services: [], siblings: [],
          ...(ask.service === null ? {} : { service: ask.service }),
        };
        const handle = await this.#deps.adapter.start(input);
        const at = this.#at();
        const live: Live = { ask: id, handle, startedAt: at, commits, lastActivity: this.#now().getTime(), total: 0, text: [], open: new Map(), running: true, ending: false };
        this.#live.set(id, live);
        this.#asks.update(id, { state: 'running', session: handle.id, at });
        this.#row(live, 'working');
        if (this.#closed) {
          await this.#end(live, 'stopped');
          return;
        }
        this.#supervise(live);
      } catch (error) {
        console.error(`cleared-v2: a reader could not start for ${id} (${errorName(error)})`);
        this.#asks.update(id, { state: 'failed', at: this.#at() });
        await this.#deps.effects.release({ id, session: null }).catch((cleanup) => console.error(`cleared-v2: the reader of ${id} could not be cleaned up (${errorName(cleanup)})`));
      } finally {
        this.#starting.delete(id);
      }
    })();
  }

  #row(live: Live, status: 'working' | 'done' | 'stopped' | 'failed'): void {
    const ask = this.#asks.get(live.ask) as AskRecord;
    this.#deps.store.sessions.put({
      id: live.handle.id, project: ask.project, ticket: ask.id, role: 'reader', harness: HARNESS, model: this.#deps.model,
      status, createdAt: live.startedAt, updatedAt: this.#at(), service: ask.service,
    });
  }

  #supervise(live: Live): void {
    void (async () => {
      try {
        for await (const stored of live.handle.events(0)) {
          if (live.ending) break;
          live.lastActivity = this.#now().getTime();
          await this.#onEvent(live, stored);
        }
      } catch (error) {
        console.error(`cleared-v2: the reader's event stream failed (${errorName(error)})`);
      }
      // A session that ends by itself is over: what it answered stays.
      if (!live.ending) await this.#end(live, live.running ? 'failed' : 'stopped');
    })();
  }

  async #onEvent(live: Live, stored: SessionEvent): Promise<void> {
    const event = stored.event;
    switch (event.type) {
      case 'TEXT_MESSAGE_START':
        if (event.role === 'assistant') live.open.set(event.messageId, '');
        return;
      case 'TEXT_MESSAGE_CONTENT': {
        const open = live.open.get(event.messageId);
        if (open !== undefined) live.open.set(event.messageId, open + event.delta);
        return;
      }
      case 'TEXT_MESSAGE_END': {
        const text = live.open.get(event.messageId)?.trim();
        live.open.delete(event.messageId);
        if (text) live.text.push(text);
        return;
      }
      case 'RUN_FINISHED': {
        const total = event.result.total_cost_usd;
        const answer = live.text.join('\n\n');
        live.text = [];
        const citations = await citationsOf(answer, {
          services: this.#deps.workspace.services, read: this.#servicesOf((this.#asks.get(live.ask) as AskRecord).service), commits: live.commits,
          linesAt: (service, commit, path) => this.#deps.effects.linesAt(service, commit, path),
        });
        const ask = this.#asks.get(live.ask) as AskRecord;
        const turns = [...ask.turns];
        const last = turns.at(-1);
        if (last) {
          turns[turns.length - 1] = {
            ...last, answer, citations, costUsd: total === null ? null : rounded(Math.max(0, total - live.total)),
            inputTokens: last.inputTokens + inputOf(event.usage), outputTokens: last.outputTokens + outputOf(event.usage),
          };
        }
        if (total !== null) live.total = total;
        live.running = false;
        // Stopped while its citations were checked: the answer is kept, the state the stop wrote too.
        if (live.ending) {
          this.#asks.update(live.ask, { turns, at: this.#at() });
          return;
        }
        this.#asks.update(live.ask, { state: 'answered', turns, at: this.#at() });
        this.#row(live, 'done');
        return;
      }
      case 'RUN_ERROR':
        await this.#end(live, 'failed');
        return;
      case 'CUSTOM':
        if (event.name === 'cleared.rate_limit' && event.value.window === 'seven_day') {
          this.#asks.update(live.ask, { weekPercent: event.value.usedPercent, at: this.#at() });
        } else if (event.name === 'cleared.question') {
          await this.#refuse(live, event.value.requestId, 'reader.question', 'Nobody answers a reader\'s questions: answer from what the code shows, and say what it does not.');
        } else if (event.name === 'cleared.permission_request' && event.value.suggestion.decision === 'ask') {
          await this.#refuse(live, event.value.requestId, 'reader.ask', `A reader reads only and waits for nobody: ${event.value.suggestion.reason}`);
        }
        return;
      default:
        return;
    }
  }

  async #refuse(live: Live, requestId: string, rule: string, message: string): Promise<void> {
    try {
      await live.handle.answer(requestId, { decision: { kind: 'reject_once', message }, by: 'policy', rule });
    } catch (error) {
      console.error(`cleared-v2: a reader's request could not be refused (${errorName(error)})`);
    }
  }

  // Stops the session and removes what it had; the ask keeps its turns.
  async #end(live: Live, state: 'stopped' | 'failed'): Promise<void> {
    if (live.ending) return;
    live.ending = true;
    this.#live.delete(live.ask);
    try {
      await live.handle.stop();
    } catch (error) {
      console.error(`cleared-v2: the reader of ${live.ask} could not be stopped (${errorName(error)})`);
    }
    this.#asks.update(live.ask, { state, at: this.#at() });
    this.#row(live, state);
    await this.#deps.effects.release({ id: live.ask, session: live.handle.id })
      .catch((error) => console.error(`cleared-v2: the reader of ${live.ask} could not be cleaned up (${errorName(error)})`));
  }

}

// What the last process left live has no session here any more: each such
// ask of the project is stopped, its session row too, and its containers,
// its volume and its folder are removed. Run by the sessions module at the
// service's start, before any route builds the reader, and by the reader.
export function recoverAsks(deps: { readonly store: Pick<Store, 'db' | 'sessions'>; readonly effects: Pick<ReaderEffects, 'release'>; readonly project: string; readonly at: string }): void {
  const asks = new AskStore(deps.store.db);
  for (const ask of asks.live()) {
    if (ask.project !== deps.project) continue;
    asks.update(ask.id, { state: 'stopped', at: deps.at });
    const row = ask.session ? deps.store.sessions.get(ask.session) : undefined;
    if (row) deps.store.sessions.put({ ...row, status: 'stopped', updatedAt: deps.at });
    void deps.effects.release({ id: ask.id, session: ask.session })
      .catch((error) => console.error(`cleared-v2: the reader of ${ask.id} could not be cleaned up after the restart (${errorName(error)})`));
  }
}
