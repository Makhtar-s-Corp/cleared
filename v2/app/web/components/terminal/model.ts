// The web terminal of a session taken over (decision 32, lane 32), as pure
// parts the tests run under Node; Terminal.tsx mounts xterm on them.
//   - The keys typed are batched: one post at most every 30 ms, at most
//     TERMINAL_INPUT_MAX_BYTES of UTF-8 each, never a character cut in two,
//     sent one at a time so they reach the shell in order.
//   - The output comes from the stream (server-sent events of TerminalChunk,
//     then one TerminalClosed); a chunk is written once, by its seq, so a
//     reconnection that replays what was missed writes nothing twice.
//   - The terminal is the signed-in user's who took the session over, on
//     the app's loopback address only (Me.terminal); elsewhere the tab says
//     why, and gives no command to run on the server (owner request of
//     2026-10-22 17:26).
//   - It runs the session's own harness first, resumed on the session
//     through its adapter; Shell, the second choice, closes it and opens a
//     shell in the container, and a button goes back. A harness its adapter
//     cannot resume says why, with the Shell beside it.
//   - xterm writes <style> elements and colour attributes the page's policy
//     refuses without its nonce: the two shims of lib/style-nonce.ts are
//     held while a terminal is mounted, installed once for the screen, so
//     a second mount (React's StrictMode, another terminal) can never remove
//     them from under a live one.
import { TERMINAL_INPUT_MAX_BYTES, type TerminalChunk, type TerminalClosed, type TerminalMode } from '../../../../src/api/types.ts';
import type { Harness } from '../../../../src/session/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError } from '../../lib/screen.ts';
import { installStyleAttributeCssom, installStyleNonce } from '../../lib/style-nonce.ts';
import type { TakeoverView } from '../../screens/session/tabs.ts';

export const BATCH_MS = 30;

// ------------------------------------------------------------------ input

const utf8Length = (point: number): number => (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);

// The text in pieces of at most `max` bytes of UTF-8, cut between characters.
export function splitBytes(text: string, max: number = TERMINAL_INPUT_MAX_BYTES): string[] {
  const pieces: string[] = [];
  let piece = '';
  let size = 0;
  for (const char of text) {
    const length = utf8Length(char.codePointAt(0) ?? 0);
    if (size + length > max && piece) {
      pieces.push(piece);
      piece = '';
      size = 0;
    }
    piece += char;
    size += length;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

type Schedule = (run: () => void, ms: number) => () => void;
const timeout: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

// What is typed, posted at most every BATCH_MS, one post at a time. A
// refused post stops it: the terminal is closed or gone, and what follows
// would be refused too.
export class InputBatcher {
  readonly #send: (data: string) => Promise<void>;
  readonly #schedule: Schedule;
  readonly #onError: ((error: unknown) => void) | undefined;
  #buffer = '';
  #queue: string[] = [];
  #cancel: (() => void) | undefined;
  #sending = false;
  #stopped = false;

  constructor(options: { readonly send: (data: string) => Promise<void>; readonly schedule?: Schedule; readonly onError?: (error: unknown) => void }) {
    this.#send = options.send;
    this.#schedule = options.schedule ?? timeout;
    this.#onError = options.onError;
  }

  push(data: string): void {
    if (this.#stopped || !data) return;
    this.#buffer += data;
    this.#cancel ??= this.#schedule(() => {
      this.#cancel = undefined;
      this.#flush();
    }, BATCH_MS);
  }

  dispose(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#buffer = '';
    this.#queue = [];
  }

  #flush(): void {
    if (this.#stopped || !this.#buffer) return;
    this.#queue.push(...splitBytes(this.#buffer));
    this.#buffer = '';
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined && !this.#stopped; next = this.#queue.shift()) {
        try {
          await this.#send(next);
        } catch (error) {
          this.dispose();
          this.#onError?.(error);
        }
      }
    } finally {
      this.#sending = false;
    }
  }
}

// ----------------------------------------------------------------- choice

export type TerminalChoice =
  | { readonly kind: 'web' }                                                // the web terminal
  | { readonly kind: 'notice'; readonly why: 'here_only' | 'other' }       // the notice only, and why
  | { readonly kind: 'none' };                                              // not taken over

export function terminalChoice(options: { readonly offered: boolean | undefined; readonly takeover: TakeoverView }): TerminalChoice {
  if (options.takeover.kind === 'other') return { kind: 'notice', why: 'other' };
  if (options.takeover.kind !== 'mine') return { kind: 'none' };
  return options.offered === true ? { kind: 'web' } : { kind: 'notice', why: 'here_only' };
}

// ------------------------------------------------------------------ modes

export const DEFAULT_MODE: TerminalMode = 'harness';
export const otherMode = (mode: TerminalMode): TerminalMode => (mode === 'harness' ? 'shell' : 'harness');

// The harness's name before the service says it (TerminalOpened.name).
const HARNESS_NAMES: Readonly<Record<Harness, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
export const harnessName = (harness: Harness): string => HARNESS_NAMES[harness] ?? harness;

// ----------------------------------------------------------------- stream

// lost: the stream gave up (the terminal ended while it was away);
// refused: the open was refused, with the service's reason;
// unsupported: the harness cannot be resumed here, with the adapter's reason.
export type CloseReason = TerminalClosed['reason'] | 'lost' | 'refused' | 'unsupported';
export type TerminalStatus =
  | { readonly kind: 'opening' }
  | { readonly kind: 'open'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'closed'; readonly reason: CloseReason; readonly detail?: string };

export const freshChunk = (lastSeq: number, chunk: Pick<TerminalChunk, 'seq'>): boolean => chunk.seq > lastSeq;

// The harness's own exit is said apart from the shell's.
export const closedLine = (reason: CloseReason, t: Translate, mode: TerminalMode = 'shell'): string =>
  t(reason === 'exit' && mode === 'harness' ? 'terminal_closed_exit_harness' : `terminal_closed_${reason}`);

// ----------------------------------------------------------------- routes

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type OpenResult =
  | { readonly kind: 'opened'; readonly cols: number; readonly rows: number; readonly mode: TerminalMode; readonly name?: string }
  | { readonly kind: 'attach'; readonly mode: TerminalMode }               // already open, in that mode: a reload of the page
  | { readonly kind: 'unsupported'; readonly reason: string }              // the harness cannot be resumed here: the Shell can
  | { readonly kind: 'refused'; readonly reason: string };

type ErrorBody = { error?: unknown; mode?: unknown };
const errorText = (body: ErrorBody, status: number): string => (typeof body.error === 'string' ? body.error : String(status));
async function errorOf(response: Response): Promise<string> {
  return errorText(await response.json().catch(() => ({})) as ErrorBody, response.status);
}

// The terminal's routes through the app (/api/service/...), each post with
// the anti-forgery token; the stream is read by an EventSource at streamUrl.
export function terminalApi(session: string, csrf: string, fetcher: Fetch = (url, init) => fetch(url, init)) {
  const root = `/api/service/sessions/${encodeURIComponent(session)}/terminal`;
  const post = (name: string, body: unknown) => fetcher(`${root}/${name}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
  const accepted = async (name: string, body: unknown): Promise<void> => {
    const response = await post(name, body);
    if (!response.ok) throw new ApiError(response.status, await errorOf(response));
  };
  return {
    streamUrl: `${root}/stream`,
    async open(size: { readonly cols: number; readonly rows: number }, mode: TerminalMode): Promise<OpenResult> {
      const response = await post('open', { ...size, mode });
      if (response.ok) {
        const opened = await response.json() as { cols: number; rows: number; mode?: TerminalMode; name?: string };
        return { kind: 'opened', cols: opened.cols, rows: opened.rows, mode: opened.mode ?? mode, ...(opened.name ? { name: opened.name } : {}) };
      }
      const body = await response.json().catch(() => ({})) as ErrorBody;
      if (response.status === 409) return { kind: 'attach', mode: body.mode === 'harness' || body.mode === 'shell' ? body.mode : mode };
      if (response.status === 501) return { kind: 'unsupported', reason: errorText(body, response.status) };
      return { kind: 'refused', reason: errorText(body, response.status) };
    },
    input: (data: string) => accepted('input', { data }),
    resize: (size: { readonly cols: number; readonly rows: number }) => accepted('resize', size),
    close: () => accepted('close', {}),
  };
}

// ------------------------------------------------------------------ nonce

// The page's style nonce, from the element's nonce property: Chromium hides
// the attribute once the page is parsed.
export const pageNonce = (doc: { querySelector(selector: string): { readonly nonce?: string } | null }): string =>
  doc.querySelector('meta[property="csp-nonce"]')?.nonce ?? '';

type Install = { readonly nonce: (nonce: string) => () => void; readonly cssom: () => () => void };

// The shims held by count: installed at the first hold, removed at the last
// release; each release counts once.
export function styleShims(install: Install = { nonce: (nonce) => installStyleNonce(nonce), cssom: () => installStyleAttributeCssom() }) {
  let holders = 0;
  let remove: (() => void) | undefined;
  return {
    hold(nonce: string): () => void {
      if (!nonce) throw new Error('the page has no style nonce: the terminal cannot style itself under the policy');
      if (holders === 0) {
        const nonceOff = install.nonce(nonce);
        const cssomOff = install.cssom();
        remove = () => { nonceOff(); cssomOff(); };
      }
      holders += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holders -= 1;
        if (holders === 0) {
          remove?.();
          remove = undefined;
        }
      };
    },
  };
}

// The screen's one holder.
export const screenShims = styleShims();
