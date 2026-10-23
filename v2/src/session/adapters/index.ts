// The harness adapters the service can start sessions with: 'claude-code'
// (claude-code.ts, with the default runtime of the service's state folder),
// and 'cursor' (cursor.ts, milestone 3).
// The fake adapter (fake.ts) is registered only for the rehearsal of the
// milestone 2 proof (scripts/proof-j2.ts, docs/v2/milestone-2-plan.md,
// lane 11): CLEARED_V2_ADAPTER=fake plays the scripts of the JSON file
// CLEARED_V2_FAKE_SCRIPT under the claude-code name, and is refused unless
// every state folder of the service is temporary, so a rehearsal never
// writes its sessions into a real ledger. The multi-service proof's
// rehearsal (lane 29) adds a workspace file: it, and every checkout,
// broker and clone address it names, must be temporary too. Tests and
// fixtures create the fake adapter themselves.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Harness, HostTool, SessionAdapter, SessionHandle, SessionId, StartInput } from '../contract.ts';
import type { Cleaner } from '../clean.ts';
import type { AgUiEvent, CustomValue, EventLog, Question } from '../events.ts';
import type { Policy } from '../policy.ts';
import { ledgerPath, LedgerPathError } from '../../store/db.ts';
import { parseConf } from '../../workspace/config.ts';
import { createClaudeCodeAdapter } from './claude-code.ts';
import { createCursorAdapter } from './cursor.ts';
import { createFakeAdapter, type FakeStep } from './fake.ts';

// What an adapter needs from the service.
export type AdapterDeps = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;                // one per session, with the service's secrets and paths
  // The policy for each evaluation (milestone 2, decision 11): the learned
  // rules and the ticket's files as they are now. The policy the session
  // started with when absent.
  readonly policy?: (input: StartInput) => Policy;
};

export type AdapterFactory = (deps: AdapterDeps) => SessionAdapter;

export class AdapterSettingError extends Error {
  override name = 'AdapterSettingError';
}

// ------------------------------------------------------------ the setting

export type AdapterSetting = { readonly kind: 'claude-code' } | { readonly kind: 'fake'; readonly script: string };

// The path as the file system resolves it: the longest part that exists
// with its links followed, then the rest.
function real(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(real(parent), relative(parent, absolute));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function adapterSetting(env: NodeJS.ProcessEnv): AdapterSetting {
  const name = env.CLEARED_V2_ADAPTER || 'claude-code';
  if (name === 'claude-code') return { kind: 'claude-code' };
  if (name !== 'fake') throw new AdapterSettingError(`CLEARED_V2_ADAPTER must be claude-code or fake, not "${name}"`);
  const script = env.CLEARED_V2_FAKE_SCRIPT;
  if (!script) throw new AdapterSettingError('CLEARED_V2_ADAPTER=fake needs CLEARED_V2_FAKE_SCRIPT, the rehearsal script file');
  if (!isAbsolute(script)) throw new AdapterSettingError('CLEARED_V2_FAKE_SCRIPT must be an absolute path');
  let ledger: string;
  try {
    ledger = ledgerPath(env);
  } catch (error) {
    if (error instanceof LedgerPathError) throw new AdapterSettingError(`CLEARED_V2_ADAPTER=fake needs a temporary ledger folder: ${error.message}`);
    throw error;
  }
  const folders: [string, string][] = [['the ledger folder', dirname(ledger)]];
  for (const key of ['CLEARED_V2_STATE_DIR', 'CLEARED_V2_WORKDIRS', 'CLEARED_V2_PROJECT_DIR'] as const) {
    const value = env[key];
    if (value) folders.push([key, value]);
  }
  // A clone address is a folder of the temporary one: a rehearsal pushes
  // to its remote, and must never reach a real one.
  if (env.CLEARED_V2_REPO_URL) folders.push(['CLEARED_V2_REPO_URL', env.CLEARED_V2_REPO_URL]);
  const temporary = real(tmpdir());
  const check = (what: string, folder: string) => {
    if (!isAbsolute(folder) || !inside(temporary, real(folder)))
      throw new AdapterSettingError(`CLEARED_V2_ADAPTER=fake is refused: ${what} (${folder}) is not inside the temporary folder ${temporary}; a rehearsal never writes into a real state folder, nor reaches a real remote`);
  };
  const workspace = env.CLEARED_V2_WORKSPACE;
  if (workspace) {
    check('CLEARED_V2_WORKSPACE', workspace);
    let text: string;
    try { text = readFileSync(workspace, 'utf8'); } catch (error) {
      throw new AdapterSettingError(`CLEARED_V2_ADAPTER=fake cannot read the workspace file (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    for (const [section, keys] of Object.entries(parseConf(text))) {
      if (!section.startsWith('service ')) continue;
      for (const key of ['dir', 'url', 'broker_socket', 'broker_state'] as const) if (keys[key]) folders.push([`${section} ${key}`, keys[key] as string]);
    }
  }
  for (const [what, folder] of folders) check(what, folder);
  return { kind: 'fake', script };
}

// ------------------------------------------------------ the script file

// What the lead does in a turn: says a text, asks the owner through
// AskUserQuestion, calls a host tool, or plays an event as the real adapter
// would map it (the status of a login cut). `as` names the id the tool
// answers with (commit's), for a later act to give as `${name}`.
export type LeadAct =
  | { readonly say: string }
  | { readonly emit: AgUiEvent }
  | { readonly ask: readonly Question[] }
  | { readonly call: string; readonly input: unknown; readonly as?: string };

// `when` is a regular expression on the turn's text; its groups are given
// to the acts as $1 to $9. A rule marked once applies to one turn only.
export type LeadRule = { readonly when: string; readonly acts: readonly LeadAct[]; readonly once?: boolean };

// The author of one start, chosen by the first rule whose `when` (a
// regular expression on the start's prompt, which names the ticket and the
// step) matches, and whose `service`, when given, is the start's (lane 29).
// Its files are committed at the Go: each one written whole (`text`) or one
// line changed (`replace`: [what is there, what it becomes]), {ticket} and
// {title} filled in ({ticket} in its steps too). Its handover, when given, is left in the checkout as
// HANDOVER.md, uncommitted, for the flow to capture.
export type AuthorFile = { readonly path: string; readonly text?: string; readonly replace?: readonly [string, string] };
export type AuthorRule = {
  readonly when: string;
  readonly service?: string;
  readonly files: readonly AuthorFile[];
  readonly steps: readonly FakeStep[];
  readonly handover?: string;
};

export type RehearsalScript = {
  readonly lead: {
    readonly rules: readonly LeadRule[];
    readonly otherwise: readonly LeadAct[];                // a turn no rule matches
    // The context share each generation reports: `start` when it is ready,
    // then `perTurn` more at the end of each turn.
    readonly context: { readonly start: number; readonly perTurn: number; readonly maxTokens?: number };
    readonly turnCostUsd: number;
  };
  // An author commits `file` ({ticket} and {title} filled in) in its
  // checkout when it starts, then plays `steps`: the branch has a commit to
  // publish. `authors` are played first, one per author start. An author
  // whose steps propose a session plan (propose_session_plan) commits at
  // its Go, the first message that starts with "Go:", not when it starts.
  readonly author: { readonly steps: readonly FakeStep[]; readonly file: { readonly path: string; readonly text: string }; readonly handover?: string };
  readonly authors?: readonly (readonly FakeStep[])[];
  readonly authorRules?: readonly AuthorRule[];             // before `authors` and `author`
  readonly reviewer: readonly FakeStep[];
  readonly reopen?: readonly FakeStep[];                   // an author the flow resumes (a review asked for changes, a Give back)
  // A reopened author commits what its checkout holds at its first message
  // (a human's change, told by the Give back's notice).
  readonly reopenCommits?: boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Checks the shape the adapter relies on; the steps themselves are the fake
// adapter's and are played as they are.
export function parseRehearsalScript(text: string): RehearsalScript {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdapterSettingError('the rehearsal script file is not JSON');
  }
  const fail = (what: string): never => { throw new AdapterSettingError(`the rehearsal script file: ${what}`); };
  if (!isObject(value)) return fail('not an object');
  const { lead, author, reviewer } = value;
  if (!isObject(lead) || !Array.isArray(lead.rules) || !Array.isArray(lead.otherwise) || !isObject(lead.context) || typeof lead.turnCostUsd !== 'number')
    return fail('lead needs rules, otherwise, context and turnCostUsd');
  if (typeof lead.context.start !== 'number' || typeof lead.context.perTurn !== 'number') return fail('lead.context needs start and perTurn');
  for (const rule of lead.rules as unknown[]) {
    if (!isObject(rule) || typeof rule.when !== 'string' || !Array.isArray(rule.acts)) return fail('each lead rule needs when and acts');
    try { new RegExp(rule.when); } catch { return fail(`the rule's when is not a regular expression: ${rule.when}`); }
  }
  if (!isObject(author) || !Array.isArray(author.steps) || !isObject(author.file) || typeof author.file.path !== 'string' || typeof author.file.text !== 'string')
    return fail('author needs steps and file { path, text }');
  const outside = (path: string) => isAbsolute(path) || path.split('/').includes('..');
  if (outside(author.file.path)) return fail('author.file.path stays inside the checkout');
  if (value.authorRules !== undefined) {
    if (!Array.isArray(value.authorRules)) return fail('authorRules is a list');
    for (const rule of value.authorRules as unknown[]) {
      if (!isObject(rule) || typeof rule.when !== 'string' || !Array.isArray(rule.files) || !Array.isArray(rule.steps)) return fail('each author rule needs when, files and steps');
      try { new RegExp(rule.when); } catch { return fail(`the author rule's when is not a regular expression: ${rule.when}`); }
      for (const file of rule.files as unknown[]) {
        if (!isObject(file) || typeof file.path !== 'string' || (typeof file.text !== 'string' && !(Array.isArray(file.replace) && file.replace.length === 2 && file.replace.every((x) => typeof x === 'string'))))
          return fail('each file of an author rule needs a path, and a text or a replace of two texts');
        if (outside(file.path)) return fail(`an author rule's file ${file.path} stays inside the checkout`);
      }
    }
  }
  if (!Array.isArray(reviewer)) return fail('reviewer needs its steps');
  return value as RehearsalScript;
}

// ------------------------------------------------------- the adapter

export type RehearsalOptions = {
  readonly log: EventLog;
  readonly script: RehearsalScript;
  readonly cleaner?: () => Cleaner;
};

const run = promisify(execFile);
// The identity of the runner's own commits (images/session/runner/main.ts).
const IDENTITY = { GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: '' };

// The text with $1..$9 from the rule's match and ${name} from the ids
// recorded so far; an unknown name is left as written.
function fill(value: unknown, match: RegExpExecArray, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{([A-Za-z0-9_-]+)\}|\$([1-9])/g, (whole, name: string | undefined, group: string | undefined) =>
      (name !== undefined ? ids.get(name) ?? whole : match[Number(group)] ?? ''));
  if (Array.isArray(value)) return value.map((item) => fill(item, match, ids));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, match, ids)]));
  return value;
}

export function createRehearsalAdapter(options: RehearsalOptions): SessionAdapter {
  const { log, script } = options;
  const used = new Set<number>();                          // the rules marked once that applied
  const ids = new Map<string, string>();                   // `as` names to the ids the tools answered
  const named = new WeakMap<object, string>();             // a call's input object to its `as` name
  const inputs = new Map<SessionId, StartInput>();
  const authors = [...(script.authors ?? [])];
  let generations = 0;

  const fake = (steps: readonly FakeStep[], newId?: () => SessionId) =>
    createFakeAdapter({ log, script: steps, ...(options.cleaner ? { cleaner: options.cleaner } : {}), ...(newId ? { newId } : {}) });

  // The acts of the first rule the text matches, filled in.
  function choose(text: string): LeadAct[] {
    for (const [index, rule] of script.lead.rules.entries()) {
      if (rule.once && used.has(index)) continue;
      const match = new RegExp(rule.when, 's').exec(text);
      if (!match) continue;
      if (rule.once) used.add(index);
      return rule.acts.map((act) => fill(act, match, ids) as LeadAct);
    }
    const none = Object.assign([''], { index: 0, input: text }) as unknown as RegExpExecArray;
    return script.lead.otherwise.map((act) => fill(act, none, ids) as LeadAct);
  }

  async function startLead(input: StartInput): Promise<SessionHandle> {
    const generation = ++generations;
    const { start, perTurn, maxTokens = 200_000 } = script.lead.context;
    const measure = (percent: number): CustomValue['cleared.context_usage'] =>
      ({ totalTokens: Math.round((percent / 100) * maxTokens), maxTokens, rawMaxTokens: maxTokens, percent, isAutoCompactEnabled: true });
    // The tools as the host gives them, recording the id `commit` answers.
    const tools: HostTool[] = (input.tools ?? []).map((tool) => ({
      ...tool,
      async handle(value, context) {
        const out = await tool.handle(value, context);
        const name = isObject(value) ? named.get(value) : undefined;
        if (name && isObject(out) && typeof out.id === 'string') ids.set(name, out.id);
        return out;
      },
    }));
    // The fake adapter reads its steps as it plays them: each turn's steps
    // are added when its message comes, before the message is given to it.
    const steps: FakeStep[] = [{ context: measure(start) }, { awaitMessage: true }];
    const handle = await fake(steps).start({ ...input, tools });
    let turns = 0;
    let share = start;
    return {
      ...handle,
      async send(message) {
        const turn = `${handle.id}-turn-${++turns}`;
        let n = 0;
        const acts: FakeStep[] = choose(message.text).flatMap((act): FakeStep[] => {
          const id = `${turn}-${++n}`;
          if ('say' in act) return [
            { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
            { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: act.say } },
            { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
          ];
          if ('ask' in act) return [{ question: { requestId: id, questions: act.ask } }];
          if ('emit' in act) return [{ emit: act.emit }];
          if (act.as && isObject(act.input)) named.set(act.input, act.as);
          return [{ hostCall: { toolCallId: id, name: act.call, input: act.input } }];
        });
        share += perTurn;
        steps.push(
          { emit: { type: 'RUN_STARTED', threadId: handle.id, runId: turn } },
          ...acts,
          { context: measure(Math.round(share * 100) / 100) },
          {
            emit: {
              type: 'RUN_FINISHED', threadId: handle.id, runId: turn, outcome: { type: 'success' },
              usage: [{ model: input.model, inputTokens: 1000 * generation, outputTokens: 100 }], result: { stopReason: 'end_turn', total_cost_usd: script.lead.turnCostUsd },
            },
          },
          { awaitMessage: true },
        );
        await handle.send(message);
      },
    };
  }

  const titleOf = (input: StartInput) => /^Ticket (\S+): (.*)$/m.exec(input.prompt)?.[2]?.trim() || input.ticket;
  const git = (input: StartInput, ...args: string[]) => run('git', args, { cwd: input.workdir, env: { ...process.env, ...IDENTITY } });

  // Commits what is staged, unless nothing is (an author started again).
  async function commitStaged(input: StartInput, message: string): Promise<void> {
    try {
      await git(input, 'diff', '--cached', '--quiet');
      return;                                              // nothing new to commit
    } catch { /* staged changes: commit them */ }
    await git(input, 'commit', '--quiet', '-m', message);
  }

  // The ticket's files, committed on the ticket branch, unless the branch
  // already holds them as written; the handover left beside them.
  async function commit(input: StartInput, files: readonly AuthorFile[], handover: string | undefined): Promise<void> {
    const title = titleOf(input);
    const put = (text: string) => text.replaceAll('{ticket}', input.ticket).replaceAll('{title}', title);
    const paths: string[] = [];
    for (const entry of files) {
      const path = put(entry.path);
      const file = join(input.workdir, path);
      if (!inside(input.workdir, resolve(file))) throw new Error(`the rehearsal file ${path} is outside the checkout`);
      mkdirSync(dirname(file), { recursive: true });
      if (entry.replace) {
        const [from, to] = entry.replace;
        const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
        // Already changed (an author started again): left as it is.
        if (!before.includes(from) && !before.includes(to)) throw new Error(`the rehearsal file ${path} does not hold "${from}"`);
        writeFileSync(file, before.replace(from, to));
      } else writeFileSync(file, put(entry.text ?? ''));
      paths.push(path);
    }
    if (handover !== undefined) writeFileSync(join(input.workdir, 'HANDOVER.md'), put(handover));
    if (paths.length === 0) return;
    await git(input, 'add', '--', ...paths);
    await commitStaged(input, `${input.ticket}: ${title}`);
  }

  // The author of a start: the first rule that matches, else the next of
  // `authors`, else `author`; its files and its handover.
  function authorOf(input: StartInput): { steps: readonly FakeStep[]; files: readonly AuthorFile[]; handover: string | undefined } {
    const rule = (script.authorRules ?? []).find((r) => new RegExp(r.when, 's').test(input.prompt) && (r.service === undefined || r.service === input.service));
    if (rule) return { steps: rule.steps, files: rule.files, handover: rule.handover };
    return { steps: authors.shift() ?? script.author.steps, files: [script.author.file], handover: script.author.handover };
  }

  const proposes = (steps: readonly FakeStep[]) => steps.some((step) => 'hostCall' in step && step.hostCall.name === 'propose_session_plan');

  async function startAuthor(input: StartInput): Promise<SessionHandle> {
    const chosen = authorOf(input);
    // The steps name the ticket's files as the rules do: {ticket} filled in (an id, safe in JSON).
    const steps = JSON.parse(JSON.stringify(chosen.steps).replaceAll('{ticket}', input.ticket)) as FakeStep[];
    // Without a session plan, the change is there when the session starts.
    if (!proposes(steps)) {
      await commit(input, chosen.files, chosen.handover);
      return fake(steps).start(input);
    }
    const handle = await fake(steps).start(input);
    let done = false;
    return {
      ...handle,
      async send(message) {
        if (!done && message.text.startsWith('Go:')) {
          done = true;
          await commit(input, chosen.files, chosen.handover);
        }
        await handle.send(message);
      },
    };
  }

  // A reopened author: its steps, and, when the script says so, a commit of
  // what its checkout holds at its first message (the human's change).
  async function reopen(id: SessionId, input: StartInput): Promise<SessionHandle> {
    const handle = await fake(script.reopen ?? [{ awaitMessage: true }], () => id).start(input);
    if (!script.reopenCommits) return handle;
    let done = false;
    return {
      ...handle,
      async send(message) {
        if (!done) {
          done = true;
          // The tracked files the human changed: the briefing and a handover stay out.
          await git(input, 'add', '--update');
          await commitStaged(input, `${input.ticket}: the changes the owner made`);
        }
        await handle.send(message);
      },
    };
  }

  return {
    harness: 'claude-code',
    async start(input) {
      let handle: SessionHandle;
      if (input.role === 'lead') handle = await startLead(input);
      else if (input.role === 'reviewer') handle = await fake(script.reviewer).start(input);
      else handle = await startAuthor(input);
      inputs.set(handle.id, input);
      return handle;
    },
    // The flow resumes an author after a review that asked for changes, or
    // at a Give back: the reopen steps, under the same id.
    async resume(id) {
      const input = inputs.get(id);
      if (!input) throw new Error(`unknown session ${id}`);
      return reopen(id, input);
    },
  };
}

// ---------------------------------------------------------- factories

export function factoriesFor(env: NodeJS.ProcessEnv): Readonly<Partial<Record<Harness, AdapterFactory>>> {
  const setting = adapterSetting(env);
  if (setting.kind === 'fake') {
    let script: RehearsalScript;
    try {
      script = parseRehearsalScript(readFileSync(setting.script, 'utf8'));
    } catch (error) {
      if (error instanceof AdapterSettingError) throw error;
      throw new AdapterSettingError(`the rehearsal script file cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
    return { 'claude-code': (deps) => createRehearsalAdapter({ log: deps.log, script, cleaner: deps.cleaner }) };
  }
  // 'cursor' (milestone 3) is built only for a session that names it; claude-code stays the default.
  return {
    'claude-code': (deps) => createClaudeCodeAdapter({ log: deps.log, cleaner: deps.cleaner, ...(deps.policy ? { policy: deps.policy } : {}) }),
    cursor: (deps) => createCursorAdapter({ log: deps.log, cleaner: deps.cleaner, ...(deps.policy ? { policy: deps.policy } : {}) }),
  };
}

// A setting that is set but wrong stops the service with exit code 64, as
// the flow's and the lead's do.
function orExit<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (!(error instanceof AdapterSettingError)) throw error;
    console.error(`cleared-v2: ${error.message}`);
    process.exit(64);
  }
}

export const adapterFactories: Readonly<Partial<Record<Harness, AdapterFactory>>> = orExit(() => factoriesFor(process.env));
