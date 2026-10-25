// A reader on the fake adapter, with the effects faked and the time in the
// test's hands (docs/v2/milestone-2-plan.md, decision 28, lane 25).
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionAdapter, SessionId, StartInput } from '../../src/session/contract.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import { ASK_TABLES } from '../../src/reader/store.ts';
import { ReaderService, type ReaderEffects } from '../../src/reader/service.ts';
import { ReaderError } from '../../src/reader/target.ts';

export const PAGE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// The commits the fake exports, as a forge's base would hold them.
export const COMMIT_1 = '1'.repeat(40);
export const COMMIT_2 = '2'.repeat(40);

// One turn of a reader: its text, then its result with the session's total
// cost so far (Claude Code's result says the session's, not the turn's).
export function turn(id: string, text: string, total: number | null, extra: readonly FakeStep[] = []): FakeStep[] {
  return [
    { emit: { type: 'RUN_STARTED', threadId: 'reader', runId: id } },
    ...extra,
    { emit: { type: 'TEXT_MESSAGE_START', messageId: `${id}-a`, role: 'assistant' } },
    { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: `${id}-a`, delta: text } },
    { emit: { type: 'TEXT_MESSAGE_END', messageId: `${id}-a` } },
    {
      emit: {
        type: 'RUN_FINISHED', threadId: 'reader', runId: id, outcome: { type: 'success' },
        usage: [{ model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 200, cachedInputTokens: 300, cacheWriteInputTokens: 50 }],
        result: { stopReason: 'end_turn', total_cost_usd: total },
      },
    },
    { awaitMessage: true },
  ];
}

export const week = (usedPercent: number, window: 'seven_day' | 'five_hour' = 'seven_day'): FakeStep =>
  ({ emit: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window, usedPercent, resetsAt: null } } });

export type ReaderSetup = {
  readonly store: Store;
  readonly reader: ReaderService;
  readonly inputs: StartInput[];
  readonly ids: SessionId[];
  readonly stopped: SessionId[];
  readonly prepared: { id: string; services: readonly string[]; briefing: string }[];
  readonly released: { id: string; session: SessionId | null }[];
  readonly files: Record<string, string>;
  // What each service's base is at when the next folder is exported, and
  // the files each commit holds (`service@commit:path`).
  readonly commits: Record<string, string>;
  readonly landed: Record<string, string>;
  readonly lineReads: string[];
  // When set, a citation's read waits for it.
  holdLines(until: Promise<void> | undefined): void;
  advance(ms: number): void;
  failStart(error: Error | undefined): void;
};

export function readerSetup(options: { readonly script?: readonly FakeStep[]; readonly store?: Store; readonly maxLive?: number } = {}): ReaderSetup {
  const store = options.store ?? openStore(':memory:');
  for (const statement of ASK_TABLES) store.db.exec(statement);
  let clock = Date.parse('2026-10-22T10:00:00.000Z');
  let count = 0;
  const fake = createFakeAdapter({ log: store.events, script: options.script ?? turn('t1', 'Line 12 renders the entries.', 0.05), now: () => new Date(clock), newId: () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}` });
  const inputs: StartInput[] = [];
  const ids: SessionId[] = [];
  const stopped: SessionId[] = [];
  let failure: Error | undefined;
  const adapter: SessionAdapter = {
    harness: 'claude-code',
    resume: (id) => fake.resume(id),
    async start(input) {
      inputs.push(input);
      if (failure) throw failure;
      const handle = await fake.start(input);
      ids.push(handle.id);
      return { ...handle, stop: async () => { stopped.push(handle.id); await handle.stop(); } };
    },
  };
  const prepared: ReaderSetup['prepared'] = [];
  const released: ReaderSetup['released'] = [];
  const files: Record<string, string> = { 'guestbook:src/page.ts': PAGE };
  const commits: Record<string, string> = { guestbook: COMMIT_1, 'filter-api': COMMIT_1 };
  const landed: Record<string, string> = { [`guestbook@${COMMIT_1}:src/page.ts`]: PAGE, [`guestbook@${COMMIT_2}:src/page.ts`]: PAGE };
  const lineReads: string[] = [];
  let hold: Promise<void> | undefined;
  const effects: ReaderEffects = {
    async fileAt(service, path) {
      const text = files[`${service}:${path}`];
      if (text === undefined) throw new ReaderError('invalid', `${path} is not a file of ${service} at its base branch`);
      return text;
    },
    async prepare(input) {
      prepared.push(input);
      return { dir: `/state/work/asks/${input.id}`, commits: Object.fromEntries(input.services.map((name) => [name, commits[name] as string])) };
    },
    async linesAt(service, commit, path) {
      lineReads.push(`${service}@${commit}:${path}`);
      if (hold) await hold;
      const text = landed[`${service}@${commit}:${path}`];
      if (text === undefined) throw new ReaderError('invalid', `${path} is not a file of ${service} at ${commit}`);
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    },
    async release(input) {
      released.push(input);
    },
  };
  const reader = new ReaderService({
    store, adapter, effects, model: 'claude-haiku-5-5', idleMs: 15 * 60_000, now: () => new Date(clock),
    workspace: { id: 'guestbook', services: [{ name: 'guestbook', base: 'main', repo: 'acme/guestbook', path: null }, { name: 'filter-api', base: 'main', repo: 'acme/platform', path: 'filter-api' }] },
    ...(options.maxLive === undefined ? {} : { maxLive: options.maxLive }),
  });
  return {
    store, reader, inputs, ids, stopped, prepared, released, files, commits, landed, lineReads,
    holdLines: (until) => { hold = until; },
    advance: (ms) => { clock += ms; },
    failStart: (error) => { failure = error; },
  };
}

// Waits for what the reader does in the background: its starts and the
// events it reads, each a few turns of the event loop.
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}
