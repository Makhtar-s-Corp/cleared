// cleared run "<task>" [--service <name>] [--template <id>] [--wait]
// (docs/v2/milestone-5-plan.md, section 8, C18): a ticket made and started
// from a terminal or a script, without the app. The task's first line is
// the title (cut at a word past 200 characters), the whole task the
// description when it says more. It calls the service on this machine
// (CLEARED_V2_HOST and CLEARED_V2_PORT, as the service reads them) with the
// person's API token, made in the app (the person's menu, API access):
// the file CLEARED_V2_API_TOKEN_FILE names, of mode 600, else the variable
// CLEARED_V2_API_TOKEN. The token is never printed.
//
// It prints the ticket and its address. With --wait it reads the ticket's
// state every few seconds and prints each step once: what holds it in line,
// its session, its pull request, then the time taken; it stops at the
// approval, which stays a person's, in the app. CLEARED_V2_RUN_POLL_MS sets
// the pace, for the tests.
//
// Exit 0 when the ticket is made (with --wait, once it waits for its
// approval or is past it), 1 when the service refused it or it could not
// go on, 64 for a usage or a credential that cannot be read, 69 when the
// service does not answer, 77 when it refuses the token. Words:
// messages/run.<language>.json, in CLEARED_V2_APP_LANGUAGE (French by default).
import { lstatSync, readFileSync } from 'node:fs';
import { lasted } from '../../app/web/lib/time.ts';
import type { BatchHold } from '../api/types.ts';
import { ConfigError, readConfig } from '../config.ts';
import { BATCH_TITLE_MAX } from '../flow/batch.ts';
import { formatAddress } from '../server.ts';
import { TICKET_TEMPLATES, type TicketTemplate } from '../tickets/templates.ts';
import { RUN_PATH, type Run, type RunBody } from '../run/types.ts';
import { cliTranslator, languageOf } from './cleared.ts';

const t = cliTranslator('run', languageOf(process.env));

class Stop extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Options = { readonly task: string; readonly service?: string; readonly template?: TicketTemplate; readonly wait: boolean };

function options(args: readonly string[]): Options | 'help' {
  let task: string | undefined;
  let service: string | undefined;
  let template: string | undefined;
  let wait = false;
  const usage = (why: string): never => { throw new Stop(64, `${why}\n${t('usage')}`); };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--wait') wait = true;
    else if (arg === '--service' || arg === '--template') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) usage(t('missing_value', { option: arg }));
      if (arg === '--service') service = value;
      else template = value;
    } else if (arg.startsWith('-')) usage(t('unknown_option', { option: arg }));
    else if (task !== undefined) usage(t('one_task'));
    else task = arg;
  }
  if (task === undefined || !task.trim()) return usage(t('missing_task'));
  if (template !== undefined && !(TICKET_TEMPLATES as readonly string[]).includes(template)) usage(t('unknown_template', { template, list: TICKET_TEMPLATES.join(', ') }));
  return { task: task.trim(), wait, ...(service === undefined ? {} : { service }), ...(template === undefined ? {} : { template: template as TicketTemplate }) };
}

// The token: a file of this account's alone, else the variable. Its value is in no message.
function credential(env: NodeJS.ProcessEnv): string {
  const file = env.CLEARED_V2_API_TOKEN_FILE?.trim();
  if (file) {
    let mode: number;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new Stop(64, t('credential_not_file', { path: file }));
      mode = stat.mode;
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Stop(64, t('credential_unreadable', { path: file }));
    }
    if ((mode & 0o077) !== 0) throw new Stop(64, t('credential_open', { path: file }));
    let value: string;
    try { value = readFileSync(file, 'utf8').trim(); } catch { throw new Stop(64, t('credential_unreadable', { path: file })); }
    if (!value) throw new Stop(64, t('credential_empty', { path: file }));
    return value;
  }
  const value = env.CLEARED_V2_API_TOKEN?.trim();
  if (!value) throw new Stop(64, t('no_credential'));
  return value;
}

// The first line, cut at a word; the whole task is the description when it says more.
function bodyOf(options: Options): RunBody {
  const line = (options.task.split('\n')[0] ?? '').trim();
  let title = line;
  if (line.length > BATCH_TITLE_MAX) {
    const cut = line.slice(0, BATCH_TITLE_MAX - 1);
    const space = cut.lastIndexOf(' ');
    title = `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return {
    title, ...(title === options.task ? {} : { description: options.task }),
    ...(options.service ? { service: options.service } : {}), ...(options.template ? { template: options.template } : {}),
  };
}

async function call(base: string, value: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Run> {
  let response: Response;
  try {
    response = await fetch(`http://${base}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${value}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Stop(69, t('unreachable', { address: base }));
  }
  let answer: unknown;
  try { answer = await response.json(); } catch { answer = null; }
  const reason = typeof (answer as { error?: unknown } | null)?.error === 'string' ? (answer as { error: string }).error : String(response.status);
  if (response.status === 401) throw new Stop(77, t('refused_credential'));
  if (response.status === 403) throw new Stop(77, t('refused_person'));
  if (response.status === 503) throw new Stop(69, t('unavailable', { reason }));
  if (!response.ok) throw new Stop(1, t('refused', { reason }));
  return answer as Run;
}

function holdLine(run: Run, hold: BatchHold): string {
  if (hold.reason === 'lanes') return t('queued_lanes', { ticket: run.ticket, running: hold.running, lanes: hold.lanes });
  const values = { ticket: run.ticket, percent: hold.percent, stop: hold.stop };
  return hold.window === 'seven_day' ? t('queued_week', values) : t('queued_five_hours', values);
}

// Each step of the run, once: what holds it, its session, its pull request, its end.
async function follow(base: string, value: string, first: Run, every: number): Promise<number> {
  const said = new Set<string>();
  const say = (key: string, line: string) => {
    if (said.has(key)) return;
    said.add(key);
    process.stdout.write(`${line}\n`);
  };
  let run = first;
  for (;;) {
    const taken = (until: string | null) => lasted(Date.parse(until ?? new Date().toISOString()) - Date.parse(run.createdAt), t);
    if (run.state === 'queued' && run.hold) say(`hold:${JSON.stringify(run.hold)}`, holdLine(run, run.hold));
    if (run.session) say(`session:${run.session}`, run.address ? t('working_link', { ticket: run.ticket, address: run.address }) : t('working', { ticket: run.ticket }));
    if (run.pullRequest) say(`pr:${run.pullRequest.number}`, t('pull_request', { ticket: run.ticket, number: run.pullRequest.number, url: run.pullRequest.url }));
    switch (run.state) {
      case 'approval': say('end', t('approval', { ticket: run.ticket, time: taken(run.approvalAt) })); return 0;
      case 'approved': say('end', t('approved', { ticket: run.ticket, time: taken(run.approvalAt) })); return 0;
      case 'live': say('end', t('live', { ticket: run.ticket, time: taken(run.liveAt) })); return 0;
      case 'put_back': say('end', t('put_back', { ticket: run.ticket, note: run.note ?? '' })); return 1;
      case 'failed': say('end', t('failed', { ticket: run.ticket, note: run.note ?? '' })); return 1;
      default: break;
    }
    await new Promise((resolve) => setTimeout(resolve, every));
    run = await call(base, value, 'GET', `${RUN_PATH}/${encodeURIComponent(run.ticket)}`);
  }
}

async function main(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = options(args);
  if (parsed === 'help') {
    process.stdout.write(`${t('usage')}\n`);
    return 0;
  }
  const value = credential(env);
  let base: string;
  try {
    const { host, port } = readConfig(env);
    base = formatAddress(host, port);
  } catch (error) {
    if (error instanceof ConfigError) throw new Stop(64, error.message);
    throw error;
  }
  const run = await call(base, value, 'POST', RUN_PATH, bodyOf(parsed));
  process.stdout.write(`${t('made', { ticket: run.ticket, title: run.title })}\n${run.address ? `${run.address}\n` : ''}`);
  if (!parsed.wait) return 0;
  const every = Number(env.CLEARED_V2_RUN_POLL_MS) > 0 ? Number(env.CLEARED_V2_RUN_POLL_MS) : 5000;
  return follow(base, value, run, every);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error: unknown) => {
    if (!(error instanceof Stop)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
  });
}
