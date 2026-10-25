// The change stream (docs/v2/ui-overhaul-plan.md, requirement 2.1.3 and
// decision U3, lane 34): GET /api/events answers text/event-stream, one
// thin event per resource that changed ({ kind, id, at }, ChangeEvent in
// types.ts), so the app's cache refetches that resource and nothing else.
// No payload travels on it: the routes stay the one way to read a session,
// a ticket or the inbox.
//
// Its sources, all inside the service: the flow's bus (a ticket's event,
// and its session's when it names one), the inbox store's writes
// (InboxStore.onChange) and each live session's journal (FlowEngine.watch):
// a session whose summary changed says so once its burst of events settled,
// at most once per SESSION_SETTLE_MS, and a lead session also says "lead".
// Changes of one turn are said once. The stream writes a comment every
// KEEPALIVE_MS, so no idle timeout of a front cuts a quiet stream, and keeps
// its last REPLAY events for a reconnect's Last-Event-ID.
//
// One hub per engine, started by the first stream and stopped with the
// last: nothing is watched while no page listens.
import type { ServerResponse } from 'node:http';
import type { FlowEngine } from '../flow/engine.ts';
import type { FlowEvent } from '../flow/events.ts';
import type { SessionId } from '../session/contract.ts';
import { changeFrame, type ChangeEvent, type ChangeKind } from './types.ts';

export const KEEPALIVE_MS = 20_000;
export const SESSION_SETTLE_MS = 250;
const REPLAY = 256;
const ENDED = new Set(['done', 'stopped', 'failed']);

type Watched = { close(): void };
type Client = (frame: string) => void;

export class ChangeHub {
  readonly #engine: FlowEngine;
  readonly #now: () => Date;
  readonly #settleMs: number;
  readonly #clients = new Set<Client>();
  readonly #pending = new Map<string, ChangeEvent>();
  readonly #recent: { readonly seq: number; readonly frame: string }[] = [];
  readonly #watched = new Map<SessionId, Watched>();
  #seq = 0;
  #flush: ReturnType<typeof setImmediate> | undefined;
  #stops: (() => void)[] = [];

  constructor(engine: FlowEngine, options: { readonly now?: () => Date; readonly settleMs?: number } = {}) {
    this.#engine = engine;
    this.#now = options.now ?? (() => new Date());
    this.#settleMs = options.settleMs ?? SESSION_SETTLE_MS;
  }

  get listening(): number {
    return this.#clients.size;
  }

  // A client gets the changes after `after` still kept, then each new one.
  join(client: Client, after?: number): () => void {
    if (this.#clients.size === 0) this.#start();
    if (after !== undefined) for (const kept of this.#recent) if (kept.seq > after) client(kept.frame);
    this.#clients.add(client);
    return () => {
      if (!this.#clients.delete(client)) return;
      if (this.#clients.size === 0) this.#stop();
    };
  }

  // Said once at the end of the turn, however many writes asked for it.
  say(kind: ChangeKind, id: string | null): void {
    this.#pending.set(`${kind}\u0000${id ?? ''}`, { kind, id, at: this.#now().toISOString() });
    this.#flush ??= setImmediate(() => {
      this.#flush = undefined;
      const events = [...this.#pending.values()];
      this.#pending.clear();
      for (const event of events) {
        this.#seq += 1;
        const frame = changeFrame(this.#seq, event);
        this.#recent.push({ seq: this.#seq, frame });
        if (this.#recent.length > REPLAY) this.#recent.shift();
        for (const client of [...this.#clients]) client(frame);
      }
    });
  }

  #start(): void {
    this.#stops.push(this.#engine.subscribe((event) => this.#heard(event)));
    this.#stops.push(this.#engine.inbox.onChange(() => this.say('inbox', null)));
    this.#scan();
  }

  #stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const watched of this.#watched.values()) watched.close();
    this.#watched.clear();
  }

  #heard(event: FlowEvent): void {
    this.say('ticket', event.ticket);
    if ('session' in event) this.say('session', event.session);
    // A ticket's event may start a session (an author, a reviewer): it is watched from now on.
    this.#scan();
  }

  // Every session not ended is watched; an ended one says its end and is left.
  #scan(): void {
    for (const summary of this.#engine.sessions()) {
      if (!ENDED.has(summary.phase) && !this.#watched.has(summary.id)) this.#watch(summary.id);
    }
  }

  #print(id: SessionId): { readonly print: string; readonly role: string; readonly ended: boolean } | undefined {
    const detail = this.#engine.sessionDetail(id);
    if (!detail) return undefined;
    const { lastSeq: _seq, updatedAt: _updated, ...rest } = detail;
    return { print: JSON.stringify(rest), role: detail.role, ended: ENDED.has(detail.phase) };
  }

  #watch(id: SessionId): void {
    const watcher = this.#engine.watch(id);
    let open = true;
    this.#watched.set(id, { close: () => { open = false; watcher.close(); } });
    void (async () => {
      let last = this.#print(id)?.print;
      while (open) {
        const started = Date.now();
        await watcher.wait(KEEPALIVE_MS);
        if (!open) return;
        if (Date.now() - started >= KEEPALIVE_MS) continue;          // a timeout: nothing was written
        await new Promise((done) => setTimeout(done, this.#settleMs));
        if (!open) return;
        const now = this.#print(id);
        if (!now) break;
        if (now.print !== last) {
          last = now.print;
          this.say('session', id);
          if (now.role === 'lead') this.say('lead', null);
        }
        if (now.ended) break;
      }
      if (open) {
        watcher.close();
        this.#watched.delete(id);
      }
    })();
  }
}

const hubs = new WeakMap<FlowEngine, ChangeHub>();

export function changeHub(engine: FlowEngine): ChangeHub {
  let hub = hubs.get(engine);
  if (!hub) {
    hub = new ChangeHub(engine);
    hubs.set(engine, hub);
  }
  return hub;
}

// The route's answer: the stream, open until the client leaves.
export function streamChanges(hub: ChangeHub, response: ServerResponse, request: { on(event: 'close', listener: () => void): unknown }, lastEventId: string | undefined): void {
  const after = lastEventId !== undefined && /^\d{1,15}$/.test(lastEventId) ? Number(lastEventId) : undefined;
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  response.write(': stream open\n\n');
  const leave = hub.join((frame) => { response.write(frame); }, after);
  const keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS);
  keepalive.unref();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    leave();
    if (!response.writableEnded) response.end();
  };
  request.on('close', close);
  response.on('close', close);
}
