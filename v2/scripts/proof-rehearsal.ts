// The rehearsal of the milestone 2 proof (docs/v2/milestone-2-plan.md,
// lane 11): the real service and the real app, started on the fake adapter
// (CLEARED_V2_ADAPTER=fake, session/adapters/index.ts) in a temporary
// folder, with stand-ins at the edges of the machine for what a rehearsal
// must not reach:
//   - the forge: a bare copy of the example guestbook is the remote, and
//     `gh` is a stand-in (this file, run as `gh-stub`) that opens, lists
//     and checks pull requests in a file, and refuses anything else;
//   - the lock: a stand-in broker on a Unix socket of the temporary state
//     folder answers the release requests, merges an approved branch into
//     the bare copy, and writes the rows the release watch would write
//     (merged_by_script, a complete release, release_watch_complete);
//   - the mail: the e-mail notifier's sendmail is a script that appends to
//     a file, and the notification directory is the temporary one;
//   - the models: the lead, the authors and the reviewers play
//     rehearsalScript(); an author leaves a real commit of one file.
// No TCP port is opened but the service's and the app's, on 127.0.0.1, on
// ports checked free with `ss -ltn` and never a reserved one. Nothing of
// the owner's own folders is used: HOME is the temporary folder too.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FakeStep } from '../src/session/adapters/fake.ts';
import { toolArgs, toolResult } from '../src/session/events.ts';
import type { RehearsalScript } from '../src/session/adapters/index.ts';
import { LOGIN_WAIT, PLANTED } from './proof-report.ts';

const run = promisify(execFile);
const V2 = fileURLToPath(new URL('../', import.meta.url));
const GUESTBOOK = fileURLToPath(new URL('../../examples/guestbook/', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// The ports the service and the app never take (README, the v2 plan), and
// the preview listener's and the filter API's on this server (lane 29).
export const RESERVED_PORTS: ReadonlySet<number> = new Set([80, 443, 8787, 8788, 8790, 8791, 8792, 8793, 8794, 8795]);

// ---- the scripted sessions --------------------------------------------------

// The goal of question 5 (a) of the plan, and the plan the scripted lead
// proposes for it: the shape of lane 7's night (1, 2 and 4 independent, 3
// after 2, 5 after 3), so "3 after 2" is planted by the plan itself.
export const REHEARSAL_GOAL = 'Make the guestbook ready for a small team: a GET /entries.json route that lists the entries; names and messages trimmed of surrounding spaces before they are stored; the time each entry was written shown on the page; a Troubleshooting section in the README for a database that does not answer; and the port and the database host written to the log when the app starts.';

const criteria = (...lines: string[]) => `\n\nAcceptance criteria\n${lines.map((line) => `- [ ] ${line}`).join('\n')}`;
export const REHEARSAL_PLAN = {
  title: 'Ready for a small team',
  summary: 'Five small changes; the page work waits for the trimmed names, so it starts once they are live.',
  items: [
    { title: 'A GET /entries.json route that lists the entries', lane: 'full', size: 's', after: [], body: `src/server.ts answers GET /entries.json with the entries, newest first.${criteria('the route answers JSON', 'a test of the route')}` },
    { title: 'Names and messages trimmed before they are stored', lane: 'full', size: 's', after: [], body: `src/store.ts trims the name and the message of an entry before it stores them.${criteria('surrounding spaces are gone', 'a test with spaces')}` },
    { title: 'The time each entry was written, on the page', lane: 'full', size: 'm', after: [2], body: `src/page.ts shows when each entry was written, beside its trimmed name.${criteria('the time beside each entry', 'a test of the page')}` },
    { title: 'A Troubleshooting section in the README', lane: 'fast', size: 'xs', after: [], body: `README.md says what to do when the database does not answer.${criteria('the section is in the README')}` },
    { title: 'The port and the database host in the start log', lane: 'full', size: 'xs', after: [3], body: `src/main.ts writes the port and the database host to the log when the app starts.${criteria('both in the first log line', 'a test of the line')}` },
  ],
} as const;

const text = (id: string, delta: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
const started = (run: string): FakeStep => ({ emit: { type: 'RUN_STARTED', threadId: 'rehearsal', runId: run } });
const finished = (run: string, cost: number, model: string): FakeStep => ({
  emit: { type: 'RUN_FINISHED', threadId: 'rehearsal', runId: run, outcome: { type: 'success' }, usage: [{ model, inputTokens: 20_000, outputTokens: 1_500 }], result: { stopReason: 'end_turn', total_cost_usd: cost } },
});
// A login cut as the Claude Code adapter maps it (claude-code/map.ts): the
// session's status says it waits for a new login; its next turn is the relaunch.
const LOGIN_CUT = { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: LOGIN_WAIT }] } as const;
// The changes of an author, as the Claude Code adapter maps an Edit
// (claude-code/map.ts): what the files route and the Editor tab list.
const edits = (run: string, files: readonly string[]): FakeStep[] => files.flatMap((path, i) => {
  const id = `${run}-edit-${i + 1}`;
  return [
    { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Edit' } },
    { emit: toolArgs(id, { kind: 'edit', path: `/workspace/${path}`, added: 3, removed: 1 }) },
    { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
    { emit: toolResult(`${id}-result`, id, { kind: 'edit', ok: true }) },
  ] satisfies FakeStep[];
});

// An author of the replanned milestone 2 (decision 22, lane 29): its first
// turn proposes its session plan and ends; the Go is its next message (the
// fake adapter commits its files then, session/adapters/index.ts); its
// second turn shows its edits, plays `work`, reports the change by intent
// and ends. `hold` keeps that turn open until a message comes (a session
// that works when the owner takes it over). `{ticket}` is filled in by the
// adapter.
export function plannedAuthor(run: string, options: {
  readonly confidence: 'low' | 'medium' | 'high'; readonly files: readonly string[]; readonly intent: string;
  readonly planning?: readonly FakeStep[]; readonly work?: readonly FakeStep[]; readonly hold?: boolean; readonly cost?: number;
}): FakeStep[] {
  const model = 'claude-opus-5-5';
  return [
    started(run), ...(options.planning ?? []), ...text(`${run}-p`, 'I read what the ticket needs. Here is my plan.'),
    { hostCall: { toolCallId: `${run}-plan`, name: 'propose_session_plan', input: { steps: [`${options.intent}`, 'Write or update its test, run the tests, commit'], files: [...options.files], confidence: options.confidence, reason: options.confidence === 'high' ? 'The change is small and clear.' : 'One point is uncertain: the owner may want to look first.' } } },
    finished(`${run}-plan`, 0.05, model),
    { awaitMessage: true },
    started(`${run}-work`), ...edits(run, options.files), ...(options.work ?? []),
    ...(options.hold ? [{ awaitMessage: true } as const] : []),
    ...text(`${run}-a`, 'I made the change and its test, and committed it.'),
    { hostCall: { toolCallId: `${run}-report`, name: 'report_changes', input: { groups: options.files.length > 0 ? [{ intent: options.intent, files: [...options.files] }] : [] } } },
    finished(`${run}-work`, options.cost ?? 0.3, model),
  ];
}

const NOTE = ['notes/{ticket}.md'];
const author = (run: string, confidence: 'low' | 'medium' | 'high' = 'high', more: Partial<Parameters<typeof plannedAuthor>[1]> = {}): FakeStep[] =>
  plannedAuthor(run, { confidence, files: NOTE, intent: 'The change the ticket asks for', ...more });

// The handover an author leaves: the five headings, and a lesson the
// knowledge module proposes in the inbox (decision 27), which the morning
// leaves to the owner and counts.
const HANDOVER = [
  '## Done', 'The change of {ticket}, with its note.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'Nothing.',
  '## Where the artifacts are (screenshots, logs, branches)', 'The ticket branch.', '## Open questions', 'None.',
  '## Lessons for the workspace', 'The guestbook\'s notes go under notes/, one file per ticket.', '',
].join('\n');
// The guestbook's verdict phrase, in the shape the flow reads (flow/prompts.ts).
const REVIEW = 'I read the change and ran the tests.\n\nVerdict: “no blocking issues”\nDefects: none\nTo verify: nothing\nQuestions for the user: None.';

// The scripts the fake adapter plays. `due` is the reminder's time, the
// rehearsal's "08:00".
export function rehearsalScript(options: { readonly due: string }): RehearsalScript {
  const [landing, reminder] = PLANTED;
  return {
    lead: {
      // The first rule that matches a turn's text answers it (lead/prompts.ts holds the engine's texts).
      rules: [
        { when: '^Cleared: your context is near its limit', acts: [{ call: 'handover', input: { summary: 'The owner approved the plan for the guestbook and asked for two things: how long the first ticket takes from start to live, and a reminder at 08:00. The tone is short and factual. I was waiting for the night\'s events.' } }] },
        { when: 'Your commitment (c\\d+) is due', acts: [{ call: 'tell_owner', input: { text: 'Good morning. As you asked, check the texts of the page today.' } }, { call: 'fulfil', input: { id: '$1', note: 'Reminded the owner at the time asked.' } }] },
        { when: '^Cleared: what happened since the last update\\..*pull request #\\d+ is live', once: true, acts: [{ call: 'tell_owner', input: { text: 'The first ticket of the plan is live; the thread\'s times give how long it took from its start.' } }, { call: 'fulfil', input: { id: '${first_landing}', note: 'Told the owner when the first ticket landed.' } }] },
        {
          when: '^The owner gives a goal \\(goal id: (goal-\\d+)\\)',
          acts: [
            { ask: [{ question: 'Before I plan: should GET /entries.json list every entry, or only the latest 50?', header: 'JSON route', options: [{ label: 'Every entry (Recommended)' }, { label: 'The latest 50' }] }] },
            { call: 'propose_plan', input: { goal: '$1', ...REHEARSAL_PLAN } },
            { say: 'Here is a plan in five tickets. The page work starts once the trimmed names are live; the README section goes through the fast lane. I need your go on the plan; you will still approve each release.' },
          ],
        },
        // The turn that takes the plan's approval, in generation 1: a login cut,
        // relaunched by the next turn, so the report's count is read from a real ledger.
        { when: '^Cleared, for the owner: The owner approved plan', once: true, acts: [{ emit: LOGIN_CUT }, { say: 'Understood: the first tickets start now.' }] },
        { when: `(?:^|\\n)${landing.text.split(',')[0]}`, acts: [{ call: 'commit', input: { text: 'When the first ticket of the plan lands, tell the owner how long it took from start to live.' }, as: 'first_landing' }, { say: 'I will tell you as soon as the first ticket is live.' }] },
        { when: `(?:^|\\n)${reminder.text.split(',')[0]}`, acts: [{ call: 'commit', input: { text: 'At 08:00, remind the owner to check the texts of the page.', due: options.due }, as: 'reminder' }, { say: 'I will remind you at 08:00.' }] },
      ],
      otherwise: [{ say: 'Understood.' }],
      // With CLEARED_V2_LEAD_CONTEXT_PERCENT=5 (handover point 4): a refresh
      // every seven turns, the handover turn itself ending at 4.5 %, below the
      // threshold, as one turn's growth stays under the gap (plan, section 4.1).
      context: { start: 1, perTurn: 0.5 },
      turnCostUsd: 0.04,
    },
    author: { steps: author('author'), file: { path: 'notes/{ticket}.md', text: '# {ticket}\n\n{title}: written by the rehearsal of the milestone 2 proof.\n' }, handover: HANDOVER },
    // Every author proposes its session plan first (decision 22); a high
    // confidence of a ticket the lead started has its Go at once, by the plan.
    // The second author's login is cut, then its session is relaunched.
    // The third author's plan is of medium confidence: it waits through the
    // night for the owner's Go, which the morning gives (proof-inbox.ts);
    // then it asks to run a command outside the checkout, denied.
    authors: [author('author-1'), author('author-2', 'high', { planning: [{ emit: LOGIN_CUT }, started('author-2-relaunched')] }), author('author-3', 'medium', { work: [
      { permission: { requestId: 'rehearsal-permission-1', toolCallId: 'rehearsal-run-1', tool: 'Bash', input: { kind: 'execute', command: 'npm view embedded-postgres version' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } } },
      ...text('author-3-b', 'Without it, then: the change does not need that package.'),
    ] })],
    reviewer: [started('review'), ...text('review-a', REVIEW), finished('review', 0.1, 'claude-sonnet-5-5')],
    reopen: [{ awaitMessage: true }, started('reopen'), ...text('reopen-a', 'Fixed as the review asked.'), finished('reopen', 0.2, 'claude-opus-5-5')],
  };
}

// ---- the forge's gh -----------------------------------------------------------

export type Forge = { readonly next: number; readonly prs: readonly { readonly number: number; readonly repo: string; readonly branch: string; readonly title: string; readonly merged: boolean }[] };

const flag = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = (repo: string, number: number) => `https://forge.invalid/${repo}/pull/${number}`;

// What publish.ts (pr list, pr create), the flow (pr checks) and the review
// recorder (pr view) ask of gh. Anything else is refused. Each pull request
// keeps its repository: the services of a ticket share its branch name
// (lane 29), and the numbers run across the forge, so `pr view`, which
// names no repository, finds the right one.
export function ghStub(args: readonly string[], forge: Forge, head: (branch: string, repo: string) => string | undefined): { code: number; stdout: string; forge: Forge } {
  // `why` is for the reader of this file: the stand-in says only that it refused.
  const refuse = (_why: string) => ({ code: 1, stdout: '', forge });
  const [group, verb, target] = args;
  const repo = flag(args, '--repo') ?? 'rehearsal/guestbook';
  if (group !== 'pr') return refuse('only pull requests');
  if (verb === 'list') {
    const branch = flag(args, '--head');
    const open = forge.prs.filter((pr) => pr.repo === repo && pr.branch === branch && !pr.merged).map((pr) => ({ number: pr.number, url: url(repo, pr.number) }));
    return { code: 0, stdout: `${JSON.stringify(open)}\n`, forge };
  }
  if (verb === 'create') {
    const branch = flag(args, '--head');
    if (!branch) return refuse('no --head');
    const number = forge.next;
    return { code: 0, stdout: `${url(repo, number)}\n`, forge: { next: number + 1, prs: [...forge.prs, { number, repo, branch, title: flag(args, '--title') ?? branch, merged: false }] } };
  }
  const pr = forge.prs.find((p) => String(p.number) === target);
  if (!pr) return refuse('no such pull request');
  if (verb === 'checks') return { code: 0, stdout: `${JSON.stringify([{ bucket: 'pass' }])}\n`, forge };
  if (verb === 'view') return { code: 0, stdout: `${JSON.stringify({ headRefOid: head(pr.branch, pr.repo) ?? '' })}\n`, forge };
  return refuse(`gh pr ${verb} is not part of the rehearsal`);
}

// The forge file, read and written under a lock folder: two publishes may run at once.
function withForge<T>(file: string, change: (forge: Forge) => { forge: Forge; out: T }): T {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || i > 200) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const forge = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Forge : { next: 101, prs: [] };
    const { forge: next, out } = change(forge);
    writeFileSync(`${file}.part`, JSON.stringify(next, null, 2));
    renameSync(`${file}.part`, file);
    return out;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---- the lock -----------------------------------------------------------------

export type BrokerRequest = { readonly op: 'ask' | 'merge' | 'rollback' | 'status' | 'invalid'; readonly ticket: string; readonly pr: number | null; readonly prs?: readonly number[] };

// What release-request.mjs and approval/broker.ts send on the socket.
export function brokerRequest(raw: string): BrokerRequest {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return { op: 'invalid', ticket: '', pr: null }; }
  const ticket = typeof value.ticket === 'string' ? value.ticket : '';
  const pr = typeof value.pr === 'number' && Number.isSafeInteger(value.pr) ? value.pr : null;
  if (value.operation === 'status') return { op: 'status', ticket, pr: null };
  // The train's reverse rollback of a service that landed before the failing one (release/train.ts).
  if (value.operation === 'request_rollback') return ticket ? { op: 'rollback', ticket, pr: null } : { op: 'invalid', ticket, pr: null };
  if (value.operation !== 'request_release' || !ticket || pr === null) return { op: 'invalid', ticket, pr: null };
  if (typeof value.approval_request !== 'string') return { op: 'merge', ticket, pr };
  const prs = Array.isArray(value.approval_prs) ? value.approval_prs.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)) : [];
  return { op: 'ask', ticket, pr, prs: prs.length > 0 ? prs : [pr] };
}

// What ask-validation.sh keeps of a request for agreement
// (<state>/validations/<ticket>.json, approval/record.ts): the time and the
// head of each pull request shown. The approval is checked against it. A
// pull request whose head is unknown keeps nothing, and the approval is refused.
export function writeValidation(state: string, request: { readonly ticket: string; readonly prs: readonly number[] }, head: (pr: number) => string | undefined, at = new Date().toISOString()): void {
  const pulls = request.prs.map((pr) => ({ pr, head: head(pr) }));
  if (pulls.some((p) => !p.head)) return;
  const dir = join(state, 'validations');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${request.ticket}.json`);
  writeFileSync(`${file}.part`, JSON.stringify({ ticket: request.ticket, at, pulls }), { mode: 0o600 });
  renameSync(`${file}.part`, file);
}

// v1's releases table (lib/release.mjs), which the flow's ledger reader reads.
const RELEASES = `CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, pr INTEGER NOT NULL,
  merge_sha TEXT NOT NULL UNIQUE, title TEXT NOT NULL, merged_at TEXT NOT NULL,
  status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_health TEXT,
  rollback_sha TEXT, planned_rollback_sha TEXT, rollback_pushed_at TEXT, ended_at TEXT, notified_at TEXT,
  watch_pid INTEGER
)`;

// What the stand-in's watch decides of a merge, from the merged tree (in
// its clone): healthy, or failing, which the service's own auto_rollback
// reverts, as the multi-service proof's provoked failure (lane 29).
export type Watch = (merged: { readonly ticket: string; readonly pr: number; readonly clone: string }) => 'healthy' | 'failing';

type BrokerOptions = {
  readonly socket: string; readonly state: string; readonly ledger: string; readonly forge: string; readonly origin: string; readonly clone: string;
  readonly watchMs: number; readonly log: (line: string) => void;
  readonly repo?: string;                                   // its service's repository on the forge stand-in; any when absent
  readonly name?: string;                                   // how its log lines name it
  readonly watch?: Watch;
};

// Answers on the socket as serve/release-broker.mjs does ({ ok, code,
// output }). A merge is done once per pull request; asked again, it says
// merged. A failing watch probes twice, then rolls the merge back, as
// lib/release.mjs's watch does with auto_rollback; a request_rollback
// reverts the ticket's newest merge of this repository.
export function startBroker(options: BrokerOptions): Promise<net.Server> {
  const merged = new Map<number, { ticket: string; sha: string }>();
  const timers = new Set<NodeJS.Timeout>();
  const who = options.name ? `lock ${options.name}` : 'lock';
  const later = (ms: number, act: () => Promise<void> | void) => {
    const timer = setTimeout(() => { timers.delete(timer); void Promise.resolve(act()).catch((error: unknown) => options.log(`${who}: ${(error as Error).message}`)); }, ms);
    timers.add(timer);
  };
  const git = (...args: string[]) => run('git', args, { cwd: options.clone, env: { ...process.env, GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: '' } });
  const ledger = (write: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(options.ledger);
    try { db.exec('PRAGMA busy_timeout = 5000'); write(db); } finally { db.close(); }
  };
  const event = (db: DatabaseSync, kind: string, ticket: string, pr: number, detail: string) =>
    db.prepare("INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, ?, ?, ?, ?, 'rehearsal-lock')").run(new Date().toISOString(), kind, ticket, detail, pr);
  const own = (forge: Forge, pr: number) => forge.prs.find((p) => p.number === pr && (options.repo === undefined || p.repo === options.repo));

  // Reverts a merge in the bare copy, as a rollback pushes its revert.
  async function revert(sha: string, pr: number, ticket: string): Promise<string> {
    await git('fetch', '--quiet', 'origin');
    await git('checkout', '--quiet', '-B', 'main', 'origin/main');
    await git('revert', '--no-edit', '-m', '1', sha);
    await git('push', '--quiet', 'origin', 'main');
    const at = (await git('rev-parse', 'HEAD')).stdout.trim();
    options.log(`${who}: reverted #${pr} (${ticket}) as ${at.slice(0, 12)}`);
    return at;
  }

  async function merge(ticket: string, pr: number): Promise<{ ok: boolean; code: number; output: string }> {
    if (merged.has(pr)) return { ok: true, code: 0, output: `#${pr} is merged` };
    const forge = JSON.parse(readFileSync(options.forge, 'utf8')) as Forge;
    const request = own(forge, pr);
    if (!request) return { ok: false, code: 1, output: `no pull request #${pr}` };
    try {
      await git('fetch', '--quiet', 'origin');
      await git('checkout', '--quiet', '-B', 'main', 'origin/main');
      await git('merge', '--quiet', '--no-ff', '-m', `Merge pull request #${pr} (${ticket})`, `origin/${request.branch}`);
      await git('push', '--quiet', 'origin', 'main');
    } catch (error) {
      await git('merge', '--abort').catch(() => undefined);
      return { ok: false, code: 1, output: `the merge of #${pr} failed: ${(error as Error).message.split('\n')[0]}` };
    }
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
    merged.set(pr, { ticket, sha });
    withForge(options.forge, (f) => ({ forge: { ...f, prs: f.prs.map((p) => (p.number === pr ? { ...p, merged: true } : p)) }, out: undefined }));
    const mergedAt = new Date().toISOString();
    ledger((db) => {
      db.exec(RELEASES);
      event(db, 'merged_by_script', ticket, pr, `rehearsal lock merged ${sha.slice(0, 12)}`);
    });
    const verdict = options.watch?.({ ticket, pr, clone: options.clone }) ?? 'healthy';
    if (verdict === 'healthy') {
      // The release watch, compressed: healthy after `watchMs`.
      later(options.watchMs, () => {
        ledger((db) => {
          const at = new Date().toISOString();
          db.prepare("INSERT INTO releases (ticket, pr, merge_sha, title, merged_at, status, last_health, ended_at) VALUES (?, ?, ?, ?, ?, 'complete', 'healthy (rehearsal)', ?)").run(ticket, pr, sha, request.title, mergedAt, at);
          event(db, 'release_watch_complete', ticket, pr, 'the rehearsal watch saw it healthy');
        });
        options.log(`${who}: #${pr} (${ticket}) healthy`);
      });
    } else {
      // Two failing probes, a third of the window apart, then the service's own rollback.
      const probe = (n: number) => () => {
        ledger((db) => event(db, 'release_health_failing', ticket, pr, `probe ${n} of the rehearsal watch: /health answered 503 (PROOF_BREAK_HEALTH)`));
        options.log(`${who}: #${pr} (${ticket}) failing probe ${n}`);
      };
      later(Math.round(options.watchMs / 3), probe(1));
      later(Math.round((2 * options.watchMs) / 3), probe(2));
      later(options.watchMs, async () => {
        const reverted = await revert(sha, pr, ticket);
        merged.delete(pr);
        ledger((db) => {
          const at = new Date().toISOString();
          db.prepare("INSERT INTO releases (ticket, pr, merge_sha, title, merged_at, status, last_health, rollback_sha, rollback_pushed_at, ended_at) VALUES (?, ?, ?, ?, ?, 'rolled_back', 'failing twice (rehearsal)', ?, ?, ?)").run(ticket, pr, sha, request.title, mergedAt, reverted, at, at);
          event(db, 'rollback_pushed', ticket, pr, `the health check failed twice: reverted ${sha.slice(0, 12)} as ${reverted.slice(0, 12)}`);
        });
      });
    }
    options.log(`${who}: merged #${pr} (${ticket})`);
    return { ok: true, code: 0, output: `#${pr} merged` };
  }

  // request_rollback: the ticket's newest merge here, reverted.
  async function rollback(ticket: string): Promise<{ ok: boolean; code: number; output: string }> {
    const newest = [...merged.entries()].filter(([, m]) => m.ticket === ticket).at(-1);
    if (!newest) return { ok: false, code: 1, output: `No Cleared release recorded for ${ticket}` };
    const [pr, { sha }] = newest;
    const reverted = await revert(sha, pr, ticket);
    merged.delete(pr);
    ledger((db) => event(db, 'rollback_pushed', ticket, pr, `rolled back on request: reverted ${sha.slice(0, 12)} as ${reverted.slice(0, 12)}`));
    return { ok: true, code: 0, output: `#${pr} rolled back` };
  }

  const server = net.createServer((socket) => {
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { raw += chunk; });
    socket.on('end', async () => {
      const request = brokerRequest(raw);
      let answer: { ok: boolean; code: number; output: string };
      try {
        if (request.op === 'ask') {
          const forge = JSON.parse(readFileSync(options.forge, 'utf8')) as Forge;
          const head = (pr: number) => {
            const branch = own(forge, pr)?.branch;
            try { return branch ? execFileSync('git', ['--git-dir', options.origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() : undefined; } catch { return undefined; }
          };
          writeValidation(options.state, { ticket: request.ticket, prs: request.prs ?? [request.pr as number] }, head);
          answer = { ok: true, code: 0, output: `approval of #${request.pr} requested` };
        }
        else if (request.op === 'merge') answer = await merge(request.ticket, request.pr as number);
        else if (request.op === 'rollback') answer = await rollback(request.ticket);
        else if (request.op === 'status') answer = { ok: true, code: 0, output: 'rehearsal lock' };
        else answer = { ok: false, code: 64, output: 'the rehearsal lock does not do this' };
      } catch (error) {
        answer = { ok: false, code: 1, output: (error as Error).message.split('\n')[0] ?? 'failed' };
      }
      options.log(`${who}: ${request.op} ${request.ticket} ${request.pr ?? ''} -> ${answer.code}`);
      socket.end(JSON.stringify({ ...answer, reason: answer.ok ? '' : answer.output, definitive: !answer.ok }));
    });
  });
  server.on('close', () => { for (const timer of timers) clearTimeout(timer); });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => { chmodSync(options.socket, 0o600); resolveServer(server); });
  });
}

// ---- ports --------------------------------------------------------------------

// The ports listening now, as `ss -ltn` lists them.
export function listening(): Set<number> {
  const out = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' });
  return new Set(out.split('\n').flatMap((line) => {
    const local = line.trim().split(/\s+/)[3];
    const port = local ? Number(local.slice(local.lastIndexOf(':') + 1)) : NaN;
    return Number.isInteger(port) ? [port] : [];
  }));
}

// A port of 9700 to 9799 that nothing listens on and that is not reserved.
export function freePort(inUse: ReadonlySet<number>, random: () => number = Math.random): number {
  const offset = Math.floor(random() * 100);
  for (let i = 0; i < 100; i++) {
    const port = 9700 + ((offset + i) % 100);
    if (!inUse.has(port) && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('no free port from 9700 to 9799');
}

// ---- the world ----------------------------------------------------------------

export type World = {
  readonly root: string;
  readonly appUrl: string;
  readonly serviceUrl: string;
  readonly owner: string;
  readonly passwordFile: string;
  readonly ledger: string;
  readonly mail: string;
  readonly standIns: readonly string[];
  stop(): Promise<void>;
};

async function waitFor(what: string, check: () => Promise<boolean>, ms: number, child: ChildProcess): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited with ${child.exitCode}`);
    if (await check().catch(() => false)) return;
    if (Date.now() > until) throw new Error(`${what} did not start within ${Math.round(ms / 1000)} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const OWNER = 'owner';

// The app's pages are served from the build's manifest (decision 16): a
// rehearsal builds the app first, so it runs on the code it rehearses.
export function buildApp(log: (line: string) => void): void {
  log('rehearsal: npm run build');
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: V2, stdio: ['ignore', 'ignore', 'pipe'] });
}

// Builds the temporary folder, starts the lock stand-in, the service and the
// app, and answers where they are. `reminder` is the rehearsal's "08:00".
export async function startRehearsal(options: { readonly reminder: string; readonly log: (line: string) => void; readonly watchMs?: number }): Promise<World> {
  buildApp(options.log);
  const root = mkdtempSync(join(tmpdir(), 'cleared-j2-rehearsal-'));
  const dir = (...parts: string[]) => { const path = join(root, ...parts); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const state = dir('state');
  const home = dir('home');
  const bin = dir('bin');
  const notify = dir('notify');
  const work = join(root, 'work');
  const project = join(root, 'project');
  const origin = join(root, 'origin.git');
  const forge = join(root, 'forge.json');
  const mail = join(root, 'mail.log');
  const identity = { GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: '' };
  const base = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC' };

  // The approval key, made by the service's own setup.
  const setup = execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/setup.ts'), '--owner', OWNER, '--key', join(state, 'approval.key')], { env: { ...base, CLEARED_STATE_DIR: state }, encoding: 'utf8' });
  const publicKey = /human_public_key = (\S+)/.exec(setup)?.[1];
  if (!publicKey) throw new Error('setup gave no public key');

  // The project: the example guestbook, committed once with the key, copied bare as the remote.
  const seed = join(root, 'seed');
  cpSync(GUESTBOOK, seed, { recursive: true, filter: (source) => !source.includes('node_modules') });
  const conf = readFileSync(join(seed, '.cleared', 'agents.conf'), 'utf8').replace(/^\[tracker\]$/m, `[tracker]\nhuman_public_key = ${publicKey}`);
  writeFileSync(join(seed, '.cleared', 'agents.conf'), conf);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...base, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(seed, 'init', '--quiet', '--initial-branch=main');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'The example guestbook, for the rehearsal');
  git(root, 'clone', '--quiet', '--bare', seed, origin);
  git(root, 'clone', '--quiet', origin, join(root, 'lock-clone'));

  // The machine settings the service, the lock client and the notifier read.
  const machine = join(root, 'agents.conf');
  writeFileSync(machine, `${conf}
# The rehearsal's machine settings (scripts/proof-rehearsal.ts).
[tracker]
owner_id = ${OWNER}
human_private_key = ${join(state, 'approval.key')}
[notify]
adapters = email
secrets_dir = ${notify}
coalesce_minutes = 1
`);
  writeFileSync(join(notify, 'credentials.json'), JSON.stringify({ email: { to: 'owner@guestbook.invalid', from: 'cleared@guestbook.invalid' } }), { mode: 0o600 });

  // The stand-ins on PATH.
  writeGhStub(bin, forge, { 'rehearsal/guestbook': origin });
  writeFileSync(join(bin, 'sendmail'), `#!/bin/sh\n{ printf '%s\\n' "---- $(date -u +%FT%TZ)"; cat; } >> "${mail}"\n`, { mode: 0o755 });

  // The scripts and the owner.
  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(rehearsalScript({ due: options.reminder }), null, 2));
  const passwordFile = join(root, 'password');
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/user.ts'), 'add', OWNER], { env: { ...base, CLEARED_STATE_DIR: state }, input: `${password}\n${password}\n`, stdio: ['pipe', 'ignore', 'pipe'] });

  const inUse = listening();
  const servicePort = freePort(inUse);
  const appPort = freePort(new Set([...inUse, servicePort]));
  const previewPort = freePort(new Set([...inUse, servicePort, appPort]));
  const socket = join(state, 'release.sock');
  const broker = await startBroker({ socket, state, ledger: join(state, 'ledger.db'), forge, origin, clone: join(root, 'lock-clone'), watchMs: options.watchMs ?? 15_000, log: options.log });
  writeFileSync(forge, JSON.stringify({ next: 101, prs: [] }));

  const env = {
    ...base,
    CLEARED_STATE_DIR: state, CLEARED_CONF: machine, CLEARED_REPO: project,
    CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(servicePort),
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: project, CLEARED_V2_REPO: 'rehearsal/guestbook', CLEARED_V2_REPO_URL: origin,
    CLEARED_V2_STATE_DIR: state, CLEARED_V2_WORKDIRS: work, CLEARED_V2_BASE: 'main',
    CLEARED_V2_ADAPTER: 'fake', CLEARED_V2_FAKE_SCRIPT: script,
    CLEARED_V2_AUTHOR_MODEL: 'claude-opus-5-5', CLEARED_V2_REVIEWER_MODEL: 'claude-sonnet-5-5', CLEARED_V2_LEAD_MODEL: 'claude-opus-5-5',
    CLEARED_V2_LEAD_CONTEXT_PERCENT: '5', CLEARED_V2_LEAD_BATCH_SECONDS: '5', CLEARED_V2_MERGE_RETRY_SECONDS: '10',
    CLEARED_RELEASE_SOCKET: socket, CLEARED_NOTIFY_SENDMAIL: join(bin, 'sendmail'), CLEARED_NOTIFY_LINK_BASE: `http://127.0.0.1:${appPort}`,
  };
  const children: ChildProcess[] = [];
  const start = (name: string, entry: string, extra: Record<string, string>) => {
    const out = openSync(join(root, `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, ['--no-warnings', join(V2, entry)], { cwd: V2, env: { ...env, ...extra }, stdio: ['ignore', out, out] });
    closeSync(out);
    children.push(child);
    return child;
  };
  const service = start('service', 'src/main.ts', {});
  await waitFor('the service', async () => (await fetch(`http://127.0.0.1:${servicePort}/health`)).ok, 30_000, service);
  const app = start('app', 'app/main.ts', { CLEARED_V2_APP_PORT: String(appPort), CLEARED_V2_APP_HOST: '127.0.0.1', CLEARED_V2_APP_PROJECT: 'guestbook', CLEARED_V2_PREVIEW_PORT: String(previewPort) });
  await waitFor('the app', async () => (await fetch(`http://127.0.0.1:${appPort}/`, { redirect: 'manual' })).status < 500, 30_000, app);
  options.log(`rehearsal: ${root}, service on ${servicePort}, app on ${appPort}`);

  return {
    root, appUrl: `http://127.0.0.1:${appPort}`, serviceUrl: `http://127.0.0.1:${servicePort}`, owner: OWNER, passwordFile, ledger: join(state, 'ledger.db'), mail,
    standIns: [
      'the forge: a bare copy of the example guestbook as the remote, and a gh stand-in that opens, lists and passes pull requests in a file',
      'the lock: a stand-in broker that merges an approved branch into the bare copy and writes the release watch\'s rows itself, healthy after a fixed delay',
      'the deployment: nothing is deployed, so no health check runs and no rollback can happen',
      'the models: the lead, the authors and the reviewers play a script (session/adapters/index.ts); the lead\'s answers, its plan and its context share are scripted, not judged',
      'the notifications: the e-mail notifier writes to a file through a sendmail stand-in; Web Push and the Mac are not reached',
      'the night: the context threshold is 5 % and the events are batched every 5 seconds, so refreshes come within minutes',
    ],
    async stop() {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.all(children.map((child) => (child.exitCode !== null ? undefined : new Promise((r) => child.once('exit', r)))));
      await new Promise((r) => broker.close(r));
    },
  };
}

// ---- run as gh ------------------------------------------------------------------

// The gh stand-in on PATH: this file run as gh-stub, with the forge file
// and the bare copy of each repository (lane 29: one per service).
export function writeGhStub(bin: string, forge: string, origins: Readonly<Record<string, string>>): void {
  const map = `${forge}.origins.json`;
  writeFileSync(map, JSON.stringify(origins), { mode: 0o600 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${SELF}" gh-stub "${forge}" "${map}" "$@"\n`, { mode: 0o755 });
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv[2] === 'gh-stub') {
  const [forgeFile, originsFile, ...args] = process.argv.slice(3) as [string, string, ...string[]];
  const origins = JSON.parse(readFileSync(originsFile, 'utf8')) as Record<string, string>;
  const head = (branch: string, repo: string): string | undefined => {
    const origin = origins[repo];
    if (!origin) return undefined;
    try { return execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
  };
  const out = withForge(forgeFile, (forge) => {
    const answer = ghStub(args, forge, head);
    return { forge: answer.forge, out: answer };
  });
  appendFileSync(`${forgeFile}.log`, `${new Date().toISOString()} gh ${args.filter((a) => !a.startsWith('/')).join(' ')} -> ${out.code}\n`);
  if (out.code !== 0) process.stderr.write(`gh (rehearsal): refused: gh ${args.slice(0, 2).join(' ')}\n`);
  process.stdout.write(out.stdout);
  process.exitCode = out.code;
}
