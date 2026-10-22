// The web terminals of the sessions taken over (docs/v2/milestone-2-plan.md,
// decision 32, lane 31): one per session at a time, a shell in the
// session's own container (container.ts), opened by the user who took the
// session over and closed at Give back, after TERMINAL_IDLE_MS without
// input, when its shell exits, or on the user's close.
//
// What is typed is journaled line by line (lines.ts), each line through the
// events' cleaner as a whole, as `cleared.terminal_input` with who typed it;
// `cleared.terminal_opened` and `cleared.terminal_closed` (why, and how many
// bytes the shell wrote) frame it. The output is never journaled: it can
// hold a file's content. It is kept in memory only, its last
// OUTPUT_KEPT_CHARS characters, so that a stream that reconnects gets what
// it missed.
import type { TerminalChunk, TerminalClosed, TerminalOpened } from '../api/types.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { AgUiEvent } from '../session/events.ts';
import type { SessionContainer, TerminalProcess } from './container.ts';
import { TypedLines } from './lines.ts';

export const TERMINAL_IDLE_MS = 15 * 60_000;
export const OUTPUT_KEPT_CHARS = 1024 * 1024;
export const TERMINAL_SIZE = { min: 2, max: 500 } as const;

export type TerminalEvent = { readonly kind: 'data'; readonly chunk: TerminalChunk } | { readonly kind: 'closed'; readonly closed: TerminalClosed };

export class TerminalError extends Error {
  readonly kind: 'conflict' | 'invalid';
  constructor(kind: 'conflict' | 'invalid', message: string) {
    super(message);
    this.kind = kind;
  }
}

export type TerminalsDeps = {
  readonly container: SessionContainer;
  readonly journal: (session: SessionId, event: AgUiEvent) => void;
  readonly clean: (text: string) => string;
  readonly now?: () => number;
  readonly idleMs?: number;
};

type Open = {
  readonly by: UserId;
  readonly process: TerminalProcess;
  readonly lines: TypedLines;
  readonly decoder: InstanceType<typeof TextDecoder>;
  readonly chunks: TerminalChunk[];
  readonly listeners: Set<(event: TerminalEvent) => void>;
  kept: number;
  seq: number;
  outputBytes: number;
  lastInput: number;
  closing?: Promise<void>;
};

// The command that resumes the session's harness inside the terminal, shown on its first line.
export const resumeCommand = (session: SessionId): string => `claude --resume ${session}`;

export class Terminals {
  readonly #deps: TerminalsDeps;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #open = new Map<SessionId, Open>();
  readonly #opening = new Set<SessionId>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: TerminalsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#idleMs = deps.idleMs ?? TERMINAL_IDLE_MS;
  }

  openBy(session: SessionId): UserId | undefined {
    return this.#open.get(session)?.by;
  }

  async open(session: SessionId, by: UserId, size: { readonly cols: number; readonly rows: number }): Promise<TerminalOpened> {
    checkSize(size);
    if (this.#open.has(session) || this.#opening.has(session)) throw new TerminalError('conflict', 'a terminal is already open for this session: one at a time');
    this.#opening.add(session);
    let process: TerminalProcess;
    try {
      process = await this.#deps.container.terminal(session, size);
    } finally {
      this.#opening.delete(session);
    }
    const open: Open = {
      by, process, lines: new TypedLines(), decoder: new TextDecoder('utf-8'), chunks: [], listeners: new Set(),
      kept: 0, seq: 0, outputBytes: 0, lastInput: this.#now(),
    };
    this.#open.set(session, open);
    this.#deps.journal(session, { type: 'CUSTOM', name: 'cleared.terminal_opened', value: { by, cols: size.cols, rows: size.rows } });
    const resume = resumeCommand(session);
    this.#push(open, `\u001b[2m# The session is paused. To run its harness here: ${resume}\u001b[0m\r\n`);
    process.onOutput((chunk) => {
      open.outputBytes += chunk.length;
      const text = open.decoder.decode(chunk, { stream: true });
      if (text !== '') this.#push(open, text);
    });
    process.onExit(() => { void this.close(session, 'system', 'exit'); });
    return { opened: true, cols: size.cols, rows: size.rows, resume };
  }

  input(session: SessionId, data: string): void {
    const open = this.#must(session);
    open.lastInput = this.#now();
    for (const line of open.lines.feed(data)) this.#line(session, open, line);
    open.process.write(data);
  }

  async resize(session: SessionId, size: { readonly cols: number; readonly rows: number }): Promise<void> {
    checkSize(size);
    await this.#must(session).process.resize(size.cols, size.rows);
  }

  // Closes the session's terminal, if one is open: the rest of the typed
  // line journaled, the shell ended, then `cleared.terminal_closed`.
  close(session: SessionId, by: UserId | 'system', reason: TerminalClosed['reason']): Promise<void> {
    const open = this.#open.get(session);
    if (!open) return Promise.resolve();
    open.closing ??= (async () => {
      const rest = open.lines.rest();
      if (rest !== undefined) this.#line(session, open, rest);
      await open.process.end().catch(() => undefined);
      const tail = open.decoder.decode();
      if (tail !== '') this.#push(open, tail);
      this.#open.delete(session);
      this.#deps.journal(session, { type: 'CUSTOM', name: 'cleared.terminal_closed', value: { by, reason, outputBytes: open.outputBytes } });
      for (const listener of open.listeners) listener({ kind: 'closed', closed: { reason } });
      open.listeners.clear();
    })();
    return open.closing;
  }

  // The stream of a terminal: what it kept after `after`, then what comes,
  // then its close. Undefined when no terminal is open.
  stream(session: SessionId, after: number, listener: (event: TerminalEvent) => void): (() => void) | undefined {
    const open = this.#open.get(session);
    if (!open || open.closing) return undefined;
    for (const chunk of open.chunks) if (chunk.seq > after) listener({ kind: 'data', chunk });
    open.listeners.add(listener);
    return () => { open.listeners.delete(listener); };
  }

  // Closes what waited too long for input, and what `keep` no longer allows
  // (a session given back, stopped or ended meanwhile).
  async sweep(keep: (session: SessionId) => boolean = () => true): Promise<void> {
    const now = this.#now();
    await Promise.all([...this.#open].map(([session, open]) =>
      !keep(session) ? this.close(session, 'system', 'closed')
        : now - open.lastInput >= this.#idleMs ? this.close(session, 'system', 'idle') : undefined));
  }

  startTimer(keep?: (session: SessionId) => boolean, ms = 30_000): void {
    this.#timer ??= setInterval(() => { void this.sweep(keep); }, ms);
    this.#timer.unref();
  }

  async closeAll(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#open.keys()].map((session) => this.close(session, 'system', 'closed')));
  }

  #must(session: SessionId): Open {
    const open = this.#open.get(session);
    if (!open || open.closing) throw new TerminalError('conflict', 'no terminal is open for this session: open it first');
    return open;
  }

  #line(session: SessionId, open: Open, line: string): void {
    if (line.trim() === '') return;
    this.#deps.journal(session, { type: 'CUSTOM', name: 'cleared.terminal_input', value: { by: open.by, line: this.#deps.clean(line) } });
  }

  #push(open: Open, data: string): void {
    const chunk = { seq: ++open.seq, data };
    open.chunks.push(chunk);
    open.kept += data.length;
    while (open.kept > OUTPUT_KEPT_CHARS && open.chunks.length > 1) open.kept -= (open.chunks.shift() as TerminalChunk).data.length;
    for (const listener of open.listeners) listener({ kind: 'data', chunk });
  }
}

function checkSize(size: { readonly cols: unknown; readonly rows: unknown }): void {
  const ok = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= TERMINAL_SIZE.min && value <= TERMINAL_SIZE.max;
  if (!ok(size.cols) || !ok(size.rows)) throw new TerminalError('invalid', `cols and rows are whole numbers from ${TERMINAL_SIZE.min} to ${TERMINAL_SIZE.max}`);
}
