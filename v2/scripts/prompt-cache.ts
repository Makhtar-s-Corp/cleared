// The prompt cache on a reference fake run (issue #335, P219): what the
// sessions of one fake run send first, and how much of it a prompt cache
// could serve from an earlier session of the run. Nothing calls a model:
// the fake adapter's usage is scripted, so the cache is modelled here.
//
// The model, kept to what the documentation says:
//   - A request is read in the order tools, system, messages, and the cache
//     serves a prefix only up to its first changed byte (the Messages API's
//     prompt caching).
//   - A prefix is served only where an earlier request wrote an entry: here
//     the end of the preset's static part (sdk.d.ts of SDK 0.3.306: blocks
//     before that boundary are eligible for cross-session caching, blocks
//     after it are not), the end of the system prompt and the end of the
//     first message. The last two are this model's assumption: that the
//     ordinary prefix cache still reads where Claude Code ends the system
//     prompt and the conversation. `--no-system-entry` measures without the
//     entry at the end of the system prompt, the run's lower bound. An entry
//     lives 5 minutes from the start of the last request that wrote or read it.
//   - The SDK's own texts are not Cleared's to count: the built-in tools, the
//     preset and its per-session sections (the working directory, git status,
//     the date) are blocks of no tokens, known by what makes them differ (the
//     ticket's branch, its commit, the day). Where they go is read from the
//     runner's own options: in the system prompt before the briefing, or, with
//     `excludeDynamicSections`, at the head of the first message.
//   - Cleared's texts (the host tools as the start line carries them, the
//     briefing, the first turn) are counted at one token per 4 bytes of UTF-8:
//     an estimate, not the tokenizer's count.
// Only each session's first request is measured: the turns after it reuse
// their own session's prefix whatever Cleared writes.
//
// Run: node scripts/prompt-cache.ts (a table), with --json, with --no-system-entry.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUTHOR_TOOLS } from '../src/flow/author-tools.ts';
import { pickPrompt } from '../src/flow/harness-pick.ts';
import { authorPrompt, reviewPrompt } from '../src/flow/prompts.ts';
import { variantPrompt } from '../src/flow/variants.ts';
import { renderLeadBriefing } from '../src/lead/briefing.ts';
import { LEAD_TICKET, LEAD_TOOLS } from '../src/lead/contract.ts';
import { openingPrompt } from '../src/lead/prompts.ts';
import { readerBriefing, readerPrompt } from '../src/reader/briefing.ts';
import type { Briefing } from '../src/session/contract.ts';
import { renderBriefing } from '../src/workspace/briefing.ts';
import { LOGIN_FILE, run, type QueryFn } from '../images/session/runner/main.ts';

export const TTL_MS = 5 * 60_000;
const MINUTE = 60_000;

export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 4);

// One block of a request: `key` is what it is (two blocks with the same key
// are the same bytes), `tokens` Cleared's estimated tokens in it, `entry` an
// end where the cache writes and reads.
export type Block = { readonly key: string; readonly tokens: number; readonly entry?: boolean };
export type CacheRequest = { readonly label: string; readonly at: number; readonly blocks: readonly Block[] };
export type Measured = { readonly label: string; readonly input: number; readonly cached: number };
export type Measure = { readonly requests: readonly Measured[]; readonly input: number; readonly cached: number; readonly share: number };

// The requests in order of their start: each is served the longest prefix,
// ending at an entry, that an earlier request wrote or read less than the
// TTL before; then it writes an entry at each of its own ends.
export function measure(requests: readonly CacheRequest[], ttlMs = TTL_MS): Measure {
  const entries = new Map<string, number>();
  const out: Measured[] = [];
  for (const request of [...requests].sort((a, b) => a.at - b.at)) {
    const ends: { key: string; tokens: number }[] = [];
    const hash = createHash('sha256');
    let tokens = 0;
    for (const block of request.blocks) {
      hash.update(`${block.key.length}:${block.key}`);
      tokens += block.tokens;
      if (block.entry) ends.push({ key: hash.copy().digest('hex'), tokens });
    }
    const hit = [...ends].reverse().find((end) => {
      const last = entries.get(end.key);
      return last !== undefined && request.at - last <= ttlMs;
    });
    for (const end of ends) entries.set(end.key, request.at);
    out.push({ label: request.label, input: tokens, cached: hit?.tokens ?? 0 });
  }
  const input = out.reduce((n, r) => n + r.input, 0);
  const cached = out.reduce((n, r) => n + r.cached, 0);
  return { requests: out, input, cached, share: input === 0 ? 0 : cached / input };
}

// ---- the runner's system prompt ------------------------------------------------

// The `systemPrompt` option the runner gives query() for a briefing, read
// from the runner itself on a stand-in query that ends at once.
export async function runnerSystemPrompt(briefing: string | undefined): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> | undefined;
  const query: QueryFn = ({ options }) => {
    seen = options as Record<string, unknown>;
    async function* none() {}
    return Object.assign(none(), {
      async interrupt() { return undefined; },
      close() {},
      async getContextUsage() { return {}; },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
    });
  };
  async function* lines() {
    yield JSON.stringify({ type: 'start', sessionId: '00000000-0000-4000-8000-000000000001', model: 'claude-opus-5-5', resume: false });
  }
  await run({
    query, lines: lines(), write: () => {}, env: {},
    readFile: (path) => (path === LOGIN_FILE ? 'stand-in-login' : path === '/workspace/CLAUDE.md' ? briefing : undefined),
  } as Parameters<typeof run>[0]);
  const prompt = seen?.systemPrompt;
  if (typeof prompt !== 'object' || prompt === null) throw new Error('the runner gave no system prompt');
  return prompt as Record<string, unknown>;
}

// ---- a session's first request ------------------------------------------------

export type SessionStart = {
  readonly label: string;
  readonly at: number;                                   // milliseconds from the run's start
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[];
  readonly briefing: string;                             // CLAUDE.md, which the runner appends to the system prompt
  readonly context: string;                              // what makes the preset's per-session sections differ
  readonly prompt: string;                               // the first turn
};

export type ModelOptions = { readonly systemEntry?: boolean };   // an entry at the end of the system prompt, true by default

export async function firstRequest(session: SessionStart, options: ModelOptions = {}): Promise<CacheRequest> {
  const system = await runnerSystemPrompt(session.briefing);
  if (system.append !== session.briefing) throw new Error('the runner did not append the briefing');
  const moved = system.excludeDynamicSections === true;
  const tools = JSON.stringify(session.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
  const context: Block = { key: `context ${session.context}`, tokens: 0 };
  return {
    label: session.label, at: session.at,
    blocks: [
      { key: 'the built-in tools', tokens: 0 },
      { key: `host tools ${tools}`, tokens: session.tools.length ? estimateTokens(tools) : 0 },
      { key: 'the preset, static part', tokens: 0, entry: true },
      ...(moved ? [] : [context]),
      { key: `briefing ${session.briefing}`, tokens: estimateTokens(session.briefing), entry: options.systemEntry !== false },
      ...(moved ? [context] : []),
      { key: `turn ${session.prompt}`, tokens: estimateTokens(session.prompt), entry: true },
    ],
  };
}

// ---- the reference run --------------------------------------------------------

// A project's memory: the guestbook example's page, as committed in this
// repository, and a few entries of the run's own.
const PAGE = readFileSync(new URL('../../examples/guestbook/README.md', import.meta.url), 'utf8');
const GLOSSARY = ['Entry: one message of the guestbook, a name and a text.', 'Filter: the service that checks the words of an entry before it is stored.'];
const LESSONS = {
  author: ['Run npm test before you commit: the route tests start their own server on port 0.', 'Keep the page server-rendered: no script on the page.'],
  reviewer: ['A route change needs a test that calls the route, not only the function behind it.'],
  lead: ['Keep a plan to tickets one session can finish and another can review.'],
};
const DECISION_14 = 'An empty name is refused with the form kept, as an empty message already is.';

const TICKETS = {
  'LOCAL-12': { id: 'LOCAL-12', title: 'Newest entries first', body: 'The page lists the entries newest first.\n\nAcceptance criteria\n- [ ] The newest entry is at the top of the page.\n- [ ] A test covers the order.' },
  'LOCAL-13': { id: 'LOCAL-13', title: 'Show the number of entries', body: 'The page says how many entries it holds, above the list.\n\nAcceptance criteria\n- [ ] "3 entries" above a list of three.\n- [ ] "No entry yet" on an empty page.' },
  'LOCAL-14': { id: 'LOCAL-14', title: 'Refuse an empty name with a clear message', body: 'An entry without a name is refused, and the page says why.\n\nAcceptance criteria\n- [ ] A 400 that names the empty field.\n- [ ] The form keeps what was typed.' },
} as const;

const briefingFor = (role: 'author' | 'reviewer', decisions: readonly string[]): Briefing =>
  ({ projectPage: PAGE, decisions, glossary: GLOSSARY, lessons: LESSONS[role], lastHandover: null });

const BASE = 'b3f1c0de';
const DAY = '2026-10-25';
const branch = (ticket: string) => `cleared/${ticket}`;
const hostTools = (tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]) =>
  tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// One night of a plan and a pick, as the flow starts them: the lead's first
// generation; the plan's two first tickets at once (at most two at a time);
// a pick of three Claude Code variants; two questions to the code; the two
// reviews; the lead's next generation, hours later. A ticket of the plan
// that carries an approved decision of its own (LOCAL-14) has a briefing of
// its own.
export function referenceRun(): SessionStart[] {
  const at = (minutes: number) => minutes * MINUTE;
  const lead = (generation: number, minutes: number, commitments: number): SessionStart => ({
    label: `lead, generation ${generation}`, at: at(minutes), tools: hostTools(LEAD_TOOLS),
    briefing: renderLeadBriefing({
      generation, at: `${DAY}T${String(8 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00.000Z`,
      commitments: Array.from({ length: commitments }, (_v, i) => ({ id: `c${i + 1}`, text: 'Tell the owner in the morning what went live.', ticket: null, due: null, state: 'open' as const, createdAt: `${DAY}T08:00:00.000Z`, fulfilledAt: null, note: null })),
      handover: generation === 1 ? null : { id: 'h1', generation: generation - 1, at: `${DAY}T10:00:00.000Z`, machine: false, summary: 'The owner approved the plan of three tickets; the pick of LOCAL-14 ran.', parts: '## Live sessions\n- none', messages: [] },
      memory: [{ type: 'project', content: PAGE }, ...GLOSSARY.map((content) => ({ type: 'glossary', content })), ...LESSONS.lead.map((content) => ({ type: 'lesson', content }))],
    }),
    context: `/workspace ${branch(LEAD_TICKET)} ${BASE} ${DAY}`, prompt: openingPrompt(generation, generation > 1),
  });
  const author = (ticket: keyof typeof TICKETS, minutes: number, extra: readonly string[] = [], label = `author ${ticket}`): SessionStart => ({
    label, at: at(minutes), tools: hostTools(AUTHOR_TOOLS),
    briefing: renderBriefing(briefingFor('author', ticket === 'LOCAL-14' ? [DECISION_14] : [])),
    context: `/workspace ${branch(ticket)} ${BASE} ${DAY}`,
    prompt: [authorPrompt(TICKETS[ticket], { plan: true, report: true }), ...extra].join('\n\n'),
  });
  const reviewer = (ticket: keyof typeof TICKETS, minutes: number, commit: string): SessionStart => ({
    label: `reviewer ${ticket}`, at: at(minutes), tools: [],
    briefing: renderBriefing(briefingFor('reviewer', ticket === 'LOCAL-14' ? [DECISION_14] : [])),
    context: `/workspace ${branch(ticket)} ${commit} ${DAY}`,
    prompt: reviewPrompt({ ticket: TICKETS[ticket], base: 'main', verdict: 'ok to merge', testCommand: ['npm', 'test'] }),
  });
  const reader = (minutes: number, question: string): SessionStart => ({
    label: `reader: ${question}`, at: at(minutes), tools: [],
    briefing: readerBriefing({ workspace: 'guestbook', services: [{ name: 'guestbook', base: 'main' }] }),
    context: `/workspace no-git ${DAY}`,
    prompt: readerPrompt({ question, services: ['guestbook'] }),
  });
  const variant = (position: number) => author('LOCAL-14', 3, [variantPrompt(position, 3), pickPrompt(['npm', 'test'])], `author LOCAL-14, variant ${position} of 3`);
  return [
    lead(1, 0, 0),
    author('LOCAL-12', 1),
    author('LOCAL-13', 1),
    variant(1), variant(2), variant(3),
    reader(6, 'Where is an entry checked before it is stored?'),
    reader(8, 'What does /health answer when the database is slow?'),
    reviewer('LOCAL-12', 25, 'a1e2c3f4'),
    reviewer('LOCAL-13', 26, 'd5b6a7c8'),
    lead(2, 180, 2),
  ];
}

export async function measureReferenceRun(options: ModelOptions = {}): Promise<Measure> {
  return measure(await Promise.all(referenceRun().map((session) => firstRequest(session, options))));
}

// ---- the table ----------------------------------------------------------------

const percent = (share: number) => `${Math.round(share * 1000) / 10} %`;

export function table(result: Measure): string {
  const rows = result.requests.map((r) => `| ${r.label} | ${r.input} | ${r.cached} | ${percent(r.input === 0 ? 0 : r.cached / r.input)} |`);
  return [
    '| Session | Input tokens (estimated) | Served by the cache | Share |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    `| **The run** | **${result.input}** | **${result.cached}** | **${percent(result.share)}** |`,
  ].join('\n');
}

if (import.meta.main) {
  const result = await measureReferenceRun({ systemEntry: !process.argv.includes('--no-system-entry') });
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${table(result)}\n`);
}
