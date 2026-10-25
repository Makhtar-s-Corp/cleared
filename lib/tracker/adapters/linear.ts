#!/usr/bin/env node
// The one command through which agents and scripts talk to Linear.
//
//   linear.ts issue <ticket>                    ticket as JSON (project, labels, state…)
//   linear.ts comment <ticket> <file|-> [<from>]  posts the file (or stdin) as a comment, prints its URL
//   linear.ts waiting                           tickets in the status that asks the user, as JSON
//   linear.ts changes <ISO time>                tickets touched since then, with their recent comments, as JSON
//   linear.ts list <state>                      the tickets in that state ("In Progress"…), as JSON
//
// Linear serves the comments of a ticket newest first: `first: n` is the n
// most recent ones, `last: n` the n oldest (checked on a long ticket).
//   linear.ts comments <ticket>                 its comments as JSON (id, createdAt, editedAt, body, byOwner)
//   linear.ts create <project> <label> <title> <file>   opens a ticket, prints its identifier and URL
//   linear.ts label-actors <ticket>             who set each label and the project, as JSON ({labels: {name: {kind, id}}, project})
//
// Nothing real goes to Linear, an outside service (decision of 2026-10-06):
// a comment is checked by the guard of the repository first (private terms,
// secrets, IBANs, addresses, phone numbers), taken from the trusted ref. A
// refused text is not sent and stays on disk.
//
// Every comment starts with a line saying an agent wrote it: the key belongs
// to the user, so Linear shows his name, and a watcher must be able to tell
// these comments from his. Their ids are also kept in state/tracker-comments.jsonl.
//
// The port of linear.sh (docs/v2/milestone-4-plan.md, step b): the same
// commands, answers, files and exit codes. curl still carries every request,
// with the token in a header file only this account reads, never on a
// command line.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { agoUtc, confGet, confSoft, die, guardText, hasText, lockFile, main, nowUtc, ownerName, projectEnv, say, scratchDir, scriptName, ScriptExit, userMessage, writeWhole } from '../../script.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: any };

const GRAPHQL = 'https://api.linear.app/graphql';

// jq's @uri: every byte but A-Z a-z 0-9 - _ . ~ written %XX.
const uri = (text: string): string => [...Buffer.from(text, 'utf8')]
  .map((byte) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)).join('');

// What `$(cat file)` gave a script: the text, its last line breaks cut.
const contents = (file: string): string => readFileSync(file, 'utf8').replace(/\n+$/, '');

// A curl call. The header that holds a credential reaches curl as
// /dev/fd/3, a file of a private folder removed before curl starts, as the
// bash adapter's process substitution gave it: never on a command line.
function curl(args: readonly string[], options: { readonly input?: string | Buffer; readonly secretHeader?: string } = {}): { status: number; stdout: Buffer } {
  let fd: number | null = null;
  if (options.secretHeader !== undefined) {
    const dir = scratchDir('cleared-linear-');
    try {
      const file = join(dir.path, 'header');
      writeFileSync(file, options.secretHeader, { mode: 0o600 });
      fd = openSync(file, 'r');
    } finally {
      dir.remove();
    }
  }
  try {
    const head = fd === null ? [] : ['-H', '@/dev/fd/3'];
    const run = spawnSync('curl', [...args.slice(0, -1), ...head, ...args.slice(-1)], { input: options.input ?? '', stdio: fd === null ? ['pipe', 'pipe', 'inherit'] : ['pipe', 'pipe', 'inherit', fd], maxBuffer: 64 * 1024 * 1024 });
    return { status: run.status ?? 1, stdout: run.stdout ?? Buffer.alloc(0) };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const parse = (text: string): Json | undefined => { try { return JSON.parse(text) as Json; } catch { return undefined; } };

function identityOf(): { identity: 'app' | 'shared'; appId: string; appSecret: string; key: string; secrets: string } {
  const { repo } = projectEnv();
  const secrets = process.env.CLEARED_SECRETS_FILE || process.env.ORCH_SECRETS_FILE || join(repo, '.env.local');
  // Of the file of secrets only these names are read, and it is never run:
  // it also holds an API key that would move the model billing off the
  // subscription.
  const secretOf = (name: string): string => {
    if (!existsSync(secrets) || !statSync(secrets).isFile()) return '';
    const line = readFileSync(secrets, 'utf8').split('\n').find((one) => one.startsWith(`${name}=`));
    return line === undefined ? '' : line.slice(name.length + 1).replace(/["']/g, '');
  };
  let appId = process.env.LINEAR_APP_CLIENT_ID || '';
  let appSecret = process.env.LINEAR_APP_CLIENT_SECRET || '';
  let key = process.env.LINEAR_API_KEY || '';
  if (!appId && !appSecret && !key) {
    appId = secretOf('LINEAR_APP_CLIENT_ID');
    appSecret = secretOf('LINEAR_APP_CLIENT_SECRET');
    key = secretOf('LINEAR_API_KEY');
  }
  if (appId || appSecret) {
    if (!appId) die(`LINEAR_APP_CLIENT_SECRET without LINEAR_APP_CLIENT_ID (environment, or ${secrets})`);
    if (!appSecret) die(`LINEAR_APP_CLIENT_ID without LINEAR_APP_CLIENT_SECRET (environment, or ${secrets})`);
    return { identity: 'app', appId, appSecret, key, secrets };
  }
  if (!key) die(`no application of the agents (LINEAR_APP_CLIENT_ID, LINEAR_APP_CLIENT_SECRET) and no LINEAR_API_KEY (environment, or ${secrets})`);
  return { identity: 'shared', appId, appSecret, key, secrets };
}

// Under whose name the scripts act. The application of the agents when the
// project has one (its identifier and its secret): everything an agent does
// then shows under the name of the agents, never under the one of a person,
// and a move of the user can be told from theirs. Otherwise the key of a
// person: the tracker then cannot tell him from an agent (« shared »), and
// merge-pr.ts can be told to read no agreement from it ([merge]
// separate_identity). What the environment gives comes before the file of
// secrets. Half of an application is an error, not a reason to fall back in
// silence on the key of a person.
let who: ReturnType<typeof identityOf>;

// The token of the application: asked for with its secret, which never is on
// a command line, kept with the state for half a day, readable by its owner
// alone, and asked for again when it is older, or once when the tracker
// refuses it. Null when it cannot be had.
function appToken(fresh = false): string | null {
  const { state } = projectEnv();
  const kept = join(state, 'tracker-token.json');
  // The token kept is the one of this application: another identifier, another token.
  const app = createHash('sha256').update(who.appId).digest('hex').slice(0, 16);
  if (!fresh && existsSync(kept) && statSync(kept).size > 0) {
    const record = parse(readFileSync(kept, 'utf8')) as Node | undefined;
    if (record && (record.app ?? '') === app && String(record.at ?? '') > agoUtc(12 * 3600_000)) return String(record.token);
  }
  const asked = curl(['-sS', '--max-time', '30', '-X', 'POST', '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', '@-', 'https://api.linear.app/oauth/token'],
    { input: `grant_type=client_credentials&scope=read,write&client_id=${uri(who.appId)}&client_secret=${uri(who.appSecret)}` });
  if (asked.status !== 0) return null;
  const answer = parse(asked.stdout.toString('utf8')) as Node | undefined;
  const token = typeof answer?.access_token === 'string' ? answer.access_token : '';
  if (!token) {
    say(`linear: no token for the application of the agents (${answer?.error_description ?? answer?.error ?? 'unreadable answer'})`);
    return null;
  }
  mkdirSync(state, { recursive: true });
  writeWhole(kept, `${JSON.stringify({ token, at: nowUtc(), app }, null, 2)}\n`, 0o600);
  return token;
}

function authorization(fresh = false): string {
  if (who.identity !== 'app') return who.key;
  const token = appToken(fresh);
  if (token === null) throw new ScriptExit(1);
  return `Bearer ${token}`;
}

const ask = (query: string, variables: Json, auth: string): string => curl(['-sS', '--max-time', '30', '-H', 'Content-Type: application/json', '--data', '@-', GRAPHQL],
  { input: `${JSON.stringify({ query, variables }, null, 2)}\n`, secretHeader: `Authorization: ${auth}` }).stdout.toString('utf8');

// One GraphQL request. A token the tracker refuses (the secret changed, the
// application was installed again) is thrown away and asked for again, once.
// Linear answers a refused token with this code in a JSON body, under HTTP
// 401 (tried with a made-up token on 2026-10-08). An answer with errors, or
// one that cannot be read, stops the command.
function gql(query: string, variables: Json = {}): Node {
  let response = ask(query, variables, authorization());
  if (who.identity === 'app') {
    const errors = (parse(response) as Node | undefined)?.errors;
    if (Array.isArray(errors) && errors.some((error: Node) => error?.extensions?.code === 'AUTHENTICATION_ERROR')) response = ask(query, variables, authorization(true));
  }
  const answer = parse(response);
  if (answer === undefined || answer === null || typeof answer !== 'object' || Array.isArray(answer) || 'errors' in answer) {
    const said = typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? (answer.errors as Node[] | undefined)?.[0]?.message : undefined;
    say(`linear: ${said ?? (response.trim() === '' ? '' : 'unreadable answer')}`);
    throw new ScriptExit(1);
  }
  return answer as Node;
}

// Who the user is, for the tracker: the settings of the project say it. With
// the application of the agents it must be said: the one that asks no longer
// is him. Null, said, when it is not.
function ownerId(): string | null {
  const owner = confSoft('tracker', 'owner_id');
  if (!owner && who.identity === 'app') {
    say(`${scriptName()}: [tracker] owner_id is not set: with the application of the agents, who the user is must be written in the settings`);
    return null;
  }
  return owner;
}

function ticketOk(ticket: string | undefined): string {
  if (!/^[A-Z]+-[0-9]+$/.test(ticket ?? '')) die(`"${ticket ?? ''}" is not a ticket identifier`);
  return ticket!;
}

const or = (...values: unknown[]): any => values.find((value) => value !== null && value !== undefined && value !== false) ?? values.at(-1);
const print = (value: unknown): void => { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`); };
const byKey = (key: string) => (a: Node, b: Node): number => {
  const x = String(a[key] ?? '');
  const y = String(b[key] ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
};

// A time of Linear or of a request in nanoseconds, as `date -d … +%s%N`
// read it: the fraction is kept to the nanosecond, never rounded to the
// millisecond. Null when it is not such a time.
function nanoseconds(time: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(time);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').slice(0, 9).padEnd(9, '0'));
}

// `realpath -m`: the path made absolute, its existing part with its links
// followed, the rest as it is written.
function realpathMissing(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head); }
  try { head = realpathSync(head); } catch { /* kept as written */ }
  return resolve(head, ...rest);
}

const expandHome = (path: string): string => (path.startsWith('~/') ? join(process.env.HOME || homedir(), path.slice(2)) : path);

const USAGE = 'usage: linear.ts issue <ticket> | comment <ticket> <file> [<from>] | comments <ticket> | create <project> <label> <title> <file> | changes <ISO time> | list <state> | waiting | state <ticket> | moved-by-owner <ticket> <status> | move <ticket> <status> | upload <image>';

function agentKind(node: Node | null | undefined, owner: string): { kind: string; id: string } {
  const agent = node?.user?.app === true || (node?.botActor ?? null) !== null;
  return { kind: agent ? 'agents' : owner !== '' && node?.user?.id === owner ? 'human' : 'other', id: or(node?.user?.id, node?.botActor?.id, 'unknown') };
}

await main(() => {
  const args = process.argv.slice(2);
  const command = args[0] ?? '';
  const { state } = projectEnv();
  if (!confSoft('tracker', 'team')) die('Missing required [tracker] team for Linear');
  who = identityOf();

  switch (command) {
    case 'download-capture': {
      // The asset remains private on Linear. Read it with the same identity as
      // GraphQL; the token is supplied through a header file.
      const url = args[1] ?? '';
      if (!url.startsWith('https://uploads.linear.app/') || url.includes('@') || url.includes('#')) die('capture URL is outside uploads.linear.app');
      const got = curl(['-sS', '--fail', '--max-time', '15', '--max-filesize', '5000000', url], { secretHeader: `Authorization: ${authorization()}` });
      process.stdout.write(got.stdout);
      return got.status;
    }
    case 'identity':
      // app: the scripts act under the name of the agents. shared: under the
      // one of a person, whom the tracker cannot tell from an agent.
      print(who.identity);
      return 0;
    case 'issue': {
      const ticket = ticketOk(args[1]);
      const issue = gql('query($id: String!) { issue(id: $id) { id identifier title url description createdAt updatedAt state { name } project { name } labels { nodes { name } } } }', { id: ticket }).data?.issue;
      if (!issue) { say('jq: error (at <stdin>:0): Cannot iterate over null (null)'); return 5; }
      print({ id: issue.id ?? null, identifier: issue.identifier ?? null, title: issue.title ?? null, url: issue.url ?? null, state: issue.state?.name ?? null, project: issue.project?.name ?? null,
        labels: (issue.labels.nodes as Node[]).map((label) => label.name ?? null), createdAt: issue.createdAt ?? null, updatedAt: issue.updatedAt ?? null, description: or(issue.description, '') });
      return 0;
    }
    case 'comment': {
      const ticket = ticketOk(args[1]);
      // "-": the text is read on stdin (an agent that may run this command, and
      // write no file).
      let file = args[2] ?? '';
      const taken = file === '-' ? scratchDir('cleared-comment-') : null;
      try {
        if (taken) { file = join(taken.path, 'text'); writeFileSync(file, readFileSync(0)); }
        if (!existsSync(file) || !statSync(file).isFile()) die(`no such file: ${file}`);
        if (!hasText(readFileSync(file, 'utf8'))) die('nothing to post');
        const from = args[3] || process.env.ORCH_SIGNED || 'script';
        // The user reads every comment: all the agents together write him no
        // more than a few an hour. Beyond, nothing is posted; what there is to
        // say is grouped in one comment, later. Counted and posted under one
        // lock: two agents at once do not both take the last place. The limit
        // holds without its setting (6). Exit 4 tells the caller apart from a
        // failure: it keeps its text for a grouped comment.
        const setting = confSoft('tracker', 'comments_per_hour');
        mkdirSync(state, { recursive: true });
        const lock = lockFile(join(state, 'tracker-comments.lock'), 60);
        if (!lock) die('another comment is being posted for too long');
        try {
          const limit = /^[0-9]+$/.test(setting) ? Number(setting) : 6;
          const since = agoUtc(3600_000);
          let recent = 0;
          try {
            for (const line of readFileSync(join(state, 'tracker-comments.jsonl'), 'utf8').split('\n')) {
              const entry = parse(line) as Node | undefined;
              if (entry && typeof entry === 'object' && typeof entry.at === 'string' && entry.at > since) recent += 1;
            }
          } catch { /* none kept yet */ }
          if (recent >= limit) {
            say(`${scriptName()}: the user was already written ${recent} times in the last hour (limit: ${limit}): nothing posted. Group what there is to say in one comment, later`);
            return 4;
          }
          if (!guardText(file)) return 1;
          const id = gql('query($id: String!) { issue(id: $id) { id } }', { id: ticket }).data?.issue?.id;
          if (!id) die(`no such ticket: ${ticket}`);
          const body = userMessage('agent_comment', { from, owner: ownerName(), body: contents(file) }).replace(/\n+$/, '');
          const created = gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', { input: { issueId: id, body } });
          const comment = created.data?.commentCreate?.comment;
          if (created.data?.commentCreate?.success !== true || typeof comment?.id !== 'string') die('Linear did not record the comment');
          appendFileSync(join(state, 'tracker-comments.jsonl'), `${JSON.stringify({ ...comment, ticket, from, at: nowUtc() })}\n`);
          print(comment.url ?? 'null');
          return 0;
        } finally {
          lock.release();
        }
      } finally {
        taken?.remove();
      }
    }
    case 'create': {
      if (args.length !== 5 || !existsSync(args[4]!) || !statSync(args[4]!).isFile()) die('usage: linear.ts create <project> <label> <title> <description file>');
      const [, project, label, title, description] = args as [string, string, string, string, string];
      const titles = scratchDir('cleared-title-');
      try {
        writeFileSync(join(titles.path, 'title'), `${project}\n${label}\n${title}\n`);
        if (!guardText(join(titles.path, 'title')) || !guardText(description)) return 1;
      } finally {
        titles.remove();
      }
      const found = gql('query($team: String!, $project: String!, $label: String!) { teams(filter: {key: {eq: $team}}) { nodes { id } } projects(filter: {name: {eq: $project}}) { nodes { id } } issueLabels(filter: {name: {eq: $label}}) { nodes { id } } }',
        { team: confGet('tracker', 'team'), project, label }).data;
      const teamId = found?.teams?.nodes?.[0]?.id;
      const projectId = found?.projects?.nodes?.[0]?.id;
      const labelId = found?.issueLabels?.nodes?.[0]?.id;
      if (!teamId || !projectId || !labelId) die(`team, project "${project}" or label "${label}" not found in Linear`);
      const text = userMessage('agent_ticket', { from: process.env.ORCH_FROM || 'script', owner: ownerName(), body: contents(description) }).replace(/\n+$/, '');
      const created = gql('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
        { input: { teamId, projectId, labelIds: [labelId], title, description: text } });
      const issue = created.data?.issueCreate?.issue;
      if (created.data?.issueCreate?.success !== true || typeof issue?.identifier !== 'string') die('Linear did not open the ticket');
      mkdirSync(state, { recursive: true });
      appendFileSync(join(state, 'tracker-issues.jsonl'), `${JSON.stringify({ ...issue, at: nowUtc() })}\n`);
      print(`${issue.identifier} ${issue.url ?? 'null'}`);
      return 0;
    }
    case 'comments': {
      const ticket = ticketOk(args[1]);
      // byOwner: written by the user himself ([tracker] owner_id; without it,
      // and with the key of a person, the owner of that key), by no
      // application and no integration.
      const said = ownerId();
      if (said === null) return 1;
      const data = gql('query($id: String!) { viewer { id } issue(id: $id) { comments(first: 100) { nodes { id createdAt editedAt body url user { id app } botActor { id } externalUser { id } } } } }', { id: ticket }).data;
      const owner = said !== '' ? said : (data?.viewer?.id ?? null);
      print((data.issue.comments.nodes as Node[]).map((c) => {
        const external = (c.externalUser ?? null) !== null;
        const agent = c.user?.app === true || (c.botActor ?? null) !== null;
        const mine = owner !== null && (c.user?.id ?? null) === owner;
        return { id: c.id ?? null, createdAt: c.createdAt ?? null, editedAt: c.editedAt ?? null, body: c.body ?? null, url: c.url ?? null,
          byOwner: mine && c.user?.app !== true && (c.botActor ?? null) === null && !external,
          by: { kind: agent ? 'agents' : mine && !external ? 'human' : 'other', id: or(c.user?.id, c.botActor?.id, c.externalUser?.id, 'unknown') } };
      }));
      return 0;
    }
    case 'changes': {
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(args[1] ?? '')) die('usage: linear.ts changes <ISO time>');
      const data = gql('query($team: String!, $since: DateTimeOrDuration!) { issues(first: 50, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, updatedAt: {gt: $since}}) { nodes { id identifier title url createdAt updatedAt description state { name } project { name } creator { id app } botActor { id } comments(first: 20) { nodes { id createdAt body url user { id app } botActor { id } } } } } }',
        { team: confGet('tracker', 'team'), since: args[1]! }).data;
      const owner = ownerId() ?? '';
      print((data.issues.nodes as Node[]).map((i) => {
        const agent = i.creator?.app === true || (i.botActor ?? null) !== null;
        return { id: i.id ?? null, identifier: i.identifier ?? null, title: i.title ?? null, url: i.url ?? null, createdAt: i.createdAt ?? null, updatedAt: i.updatedAt ?? null,
          description: Array.from(String(or(i.description, ''))).slice(0, 1200).join(''), state: i.state?.name ?? null, project: i.project?.name ?? null, agent,
          by: { kind: agent ? 'agents' : owner !== '' && i.creator?.id === owner ? 'human' : 'other', id: or(i.creator?.id, i.botActor?.id, 'unknown') },
          comments: (i.comments.nodes as Node[]).map((c) => ({ id: c.id ?? null, createdAt: c.createdAt ?? null, url: c.url ?? null, body: c.body ?? null,
            agent: c.user?.app === true || (c.botActor ?? null) !== null, by: agentKind(c, owner) })) };
      }));
      return 0;
    }
    case 'list': {
      const wanted = args[1] ?? '';
      if (!wanted) die('usage: linear.ts list <state>');
      const data = gql('query($team: String!, $state: String!) { issues(first: 100, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, state: {name: {eq: $state}}}) { nodes { id identifier title url description createdAt updatedAt state { name } project { name } labels { nodes { name } } assignee { name } } } }',
        { team: confGet('tracker', 'team'), state: wanted }).data;
      const listed = (data.issues.nodes as Node[]).map((i) => ({ id: i.id ?? null, identifier: i.identifier ?? null, title: i.title ?? null, url: i.url ?? null,
        description: or(i.description, ''), body: or(i.description, ''), createdAt: i.createdAt ?? null, updatedAt: i.updatedAt ?? null, state: i.state?.name ?? null, status: i.state?.name ?? null,
        project: i.project?.name ?? null, labels: ((i.labels?.nodes ?? []) as Node[]).map((label) => label?.name ?? null), assignee: i.assignee?.name ?? null }));
      // One page only: a full page may not be everything.
      if (listed.length >= 100) say(`${scriptName()}: 100 tickets in the state "${wanted}": the list may be cut short`);
      print(listed);
      return 0;
    }
    case 'upload': {
      // Sends one screenshot to Linear and prints the address to put in a
      // comment. Only an image (its first bytes say so, not its name), and
      // only from the folder a lane sets apart for what may leave ([tracker]
      // capture_roots, where * is one folder name): nothing else on this
      // machine leaves by here. The guard reads the text of a comment, not an
      // image: what is put in that folder was taken on the demonstration data.
      let file: string;
      try { file = realpathSync(args[1] ?? ''); if (!args[1]) throw new Error('no file'); } catch { die('usage: linear.ts upload <image>: no such file'); }
      const roots = confSoft('tracker', 'capture_roots').split(',').map((root) => root.trim()).filter(Boolean);
      const allowed = roots.some((root) => {
        const pattern = realpathMissing(expandHome(root)).replace(/[\][.^$()+?{}|\\]/g, '\\$&').replace(/\*/g, '[^/]+');
        return new RegExp(`^${pattern}/[^/]+$`).test(file);
      });
      if (!allowed) die(`${file} is not under a folder of captures ([tracker] capture_roots): nothing sent`);
      const head = readFileSync(file).subarray(0, 8).toString('hex');
      const type = head === '89504e470d0a1a0a' ? 'image/png' : head.startsWith('ffd8ff') ? 'image/jpeg' : '';
      if (!type) die(`${file} is not a PNG or JPEG image: nothing sent`);
      const size = statSync(file).size;
      if (size > 5_000_000) die(`${file} is larger than 5 MB: nothing sent`);
      const asked = gql('mutation($type: String!, $name: String!, $size: Int!) { fileUpload(contentType: $type, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }',
        { type, name: basename(file), size });
      if (asked.data?.fileUpload?.success !== true) die('Linear did not take the upload');
      const upload = asked.data.fileUpload.uploadFile;
      const headers = ((upload.headers ?? []) as Node[]).flatMap((header) => ['-H', `${header.key}: ${header.value}`]);
      const sent = curl(['-sS', '--fail', '--max-time', '60', '-X', 'PUT', '-H', `Content-Type: ${type}`, '-H', 'Cache-Control: public, max-age=31536000', ...headers, '--data-binary', `@${file}`, String(upload.uploadUrl)]);
      if (sent.status !== 0) die('the image could not be sent');
      print(upload.assetUrl ?? 'null');
      return 0;
    }
    case 'state': {
      const ticket = ticketOk(args[1]);
      const name = gql('query($id: String!) { issue(id: $id) { state { name } } }', { id: ticket }).data?.issue?.state?.name;
      process.stdout.write(name === undefined || name === null || name === false ? '' : `${name}\n`);
      return 0;
    }
    case 'history': {
      const ticket = ticketOk(args[1]);
      const said = ownerId();
      if (said === null) return 1;
      const data = gql('query($id: String!) { viewer { id } issue(id: $id) { state { name } createdAt creator { id app } history(first: 100) { nodes { createdAt actorId actor { id app } botActor { id } toState { name } } } } }', { id: ticket }).data;
      const owner = said !== '' ? said : (data?.viewer?.id ?? null);
      const issue = data.issue;
      let history: Node[] = (issue.history.nodes as Node[]).filter((n) => (n.toState?.name ?? null) !== null).map((n) => ({ status: n.toState.name,
        by: { kind: (n.botActor ?? null) !== null || n.actor?.app === true ? 'agents' : (n.actorId ?? null) === owner && (n.actorId ?? null) !== null ? 'human' : 'other', id: or(n.actorId, n.botActor?.id, 'unknown') },
        at: n.createdAt ?? null }));
      if (history.length === 0 && (issue.creator ?? null) !== null) {
        history = [{ status: issue.state?.name ?? null, by: { kind: issue.creator.app === true ? 'agents' : (issue.creator.id ?? null) === owner ? 'human' : 'other', id: issue.creator.id ?? null }, at: issue.createdAt ?? null }];
      }
      print([...history].sort(byKey('at')));
      return 0;
    }
    case 'label-actors': {
      // Who set each label of the ticket and its project: the author of the
      // last change of the history that added it, else (set when it was
      // created) its creator. An application or a bot is the agents; the user
      // is [tracker] owner_id. A history longer than one page is not read in
      // part: the command fails, and nothing is taken as the user's.
      const ticket = ticketOk(args[1]);
      const said = ownerId();
      if (said === null) return 1;
      const data = gql('query($id: String!) { viewer { id } issue(id: $id) { createdAt creator { id app } botActor { id } labels { nodes { id name } } project { id name } history(first: 100) { pageInfo { hasNextPage } nodes { createdAt actorId actor { id app } botActor { id } addedLabelIds toProjectId } } } }', { id: ticket }).data;
      const owner = said !== '' ? said : (data?.viewer?.id ?? null);
      const issue = data?.issue ?? null;
      const whoOf = (n: Node) => ({ kind: (n.botActor ?? null) !== null || n.actor?.app === true ? 'agents' : (n.actorId ?? null) !== null && n.actorId === owner ? 'human' : 'other', id: or(n.actorId, n.botActor?.id, 'unknown') });
      const creator = (i: Node) => ({ kind: (i.botActor ?? null) !== null || i.creator?.app === true ? 'agents' : (i.creator?.id ?? null) !== null && i.creator.id === owner ? 'human' : 'other', id: or(i.creator?.id, i.botActor?.id, 'unknown') });
      if (issue === null || issue.history?.pageInfo?.hasNextPage !== false || owner === null) {
        print('null');
        die(`who set the labels of ${ticket} cannot be read`);
      }
      const history = [...(issue.history.nodes as Node[])].sort(byKey('createdAt'));
      const labels: Record<string, unknown> = {};
      for (const label of issue.labels.nodes as Node[]) {
        const last = history.filter((n) => ((n.addedLabelIds ?? []) as unknown[]).some((id) => id === label.id)).at(-1);
        labels[String(label.name)] = last ? whoOf(last) : creator(issue);
      }
      let projectOf: unknown = null;
      if ((issue.project ?? null) !== null) {
        const last = history.filter((n) => n.toProjectId === issue.project.id).at(-1);
        projectOf = last ? whoOf(last) : creator(issue);
      }
      print({ labels, project: projectOf });
      return 0;
    }
    case 'edit-comment': {
      const ticket = ticketOk(args[1]);
      void ticket;
      const file = args[3] ?? '';
      if (!file || !existsSync(file) || !statSync(file).isFile()) die('usage: tracker.ts edit-comment <ticket> <comment id> <body file>');
      if (!guardText(file)) return 1;
      const existing = gql('query($id: String!) { comment(id: $id) { id user { id app } botActor { id } } viewer { id } }', { id: args[2] ?? '' }).data;
      const theirs = existing?.comment ?? null;
      if (!(theirs !== null && who.identity === 'app' && theirs.user?.app === true && (theirs.user?.id ?? null) !== null && theirs.user.id === existing?.viewer?.id)) die('the comment was not written by the agent application');
      const updated = gql('mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: {body: $body}) { success comment { id url } } }', { id: args[2] ?? '', body: contents(file) });
      if (updated.data?.commentUpdate?.success !== true) die('the comment could not be edited');
      print(updated.data.commentUpdate.comment?.url ?? 'null');
      return 0;
    }
    case 'moved-by-owner': {
      // Is the ticket in that status, and was it put there by the user
      // himself, after the time given when one is? 0: yes. 5: it is not in
      // that status. 6: it was put there by an application (the one of the
      // agents among them), an integration or another account. 7: the tracker
      // has not written the move to its history yet. 8: by him, but before
      // the time given: an agreement to something else. The user is the one
      // the settings of the project name ([tracker] owner_id); with the key of
      // a person and no such setting, the owner of that key, whom the tracker
      // cannot tell from a program acting under his account. The tracker
      // merges the successive changes of one author in one line of history,
      // and a card taken out and put back by an agent leaves no trace: hence
      // the time, which is the one his line of history began (tried on
      // 2026-10-08: a later gesture of his joins that line only when nobody
      // acted in between).
      const ticket = ticketOk(args[1]);
      const status = args[2] ?? '';
      if (!status) die('usage: linear.ts moved-by-owner <ticket> <status> [<not before, ISO time>]');
      const notBefore = args[3] ?? '';
      if (notBefore && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/.test(notBefore)) die(`"${notBefore}" is not a time`);
      let owner = ownerId();
      if (owner === null) return 1;
      const data = gql('query($id: String!) { viewer { id } issue(id: $id) { state { name } createdAt creator { id app } history(first: 40) { nodes { createdAt actorId actor { id app } botActor { name } fromState { name } toState { name } } } } }', { id: ticket }).data;
      const issue = data?.issue;
      if ((issue?.state?.name ?? '') !== status) return 5;
      const nodes = (issue.history?.nodes ?? []) as Node[];
      let last: Node | undefined = nodes.filter((n) => n.toState?.name === status).map((n) => ({ ...n, at: n.createdAt })).sort(byKey('at')).at(-1);
      // A ticket created in that status never moved to it: the tracker keeps no
      // line for it. Whoever created it put it there, when it was created.
      if (!last && nodes.filter((n) => (n.toState ?? null) !== null || (n.fromState ?? null) !== null).length === 0 && (issue.creator ?? null) !== null) {
        last = { at: issue.createdAt, actorId: issue.creator.id, actor: issue.creator, botActor: null };
      }
      if (!last) return 7;
      if (!owner) owner = data?.viewer?.id ?? 'null';
      if (!((last.botActor ?? null) === null && last.actor?.app !== true && (last.actorId ?? null) !== null && last.actorId === owner)) return 6;
      // The request and the move carry subsecond times. A move earlier in the
      // same second must not authorize the later request.
      if (notBefore) {
        const moved = nanoseconds(String(last.at ?? ''));
        const asked = nanoseconds(notBefore);
        if (moved === null || asked === null || moved <= asked) return 8;
      }
      return 0;
    }
    case 'move': {
      // A script only ever puts a ticket in the statuses that say where the
      // work stands (at work, being checked), in the one that asks the user
      // for his agreement, or in the one that says it is done. Never in the
      // one that is his agreement, nor in the one by which he says « go ».
      const ticket = ticketOk(args[1]);
      const target = args[2] ?? '';
      const allowed = ['progress_state', 'review_state', 'validate_state', 'done_state'].some((name) => { const value = confSoft('tracker', name); return value !== '' && target === value; });
      if (!target || !allowed || target === confSoft('tracker', 'go_state')) {
        die(`a script may only move a ticket to a status of the work, to "${confSoft('tracker', 'validate_state')}" or to "${confSoft('tracker', 'done_state')}", never to "${target || 'nothing'}"`);
      }
      const found = gql('query($id: String!, $team: String!) { issue(id: $id) { id } teams(filter: {key: {eq: $team}}) { nodes { states { nodes { id name } } } } }', { id: ticket, team: confGet('tracker', 'team') }).data;
      const issueId = found?.issue?.id;
      const stateId = ((found?.teams?.nodes?.[0]?.states?.nodes ?? []) as Node[]).filter((one) => one.name === target).map((one) => one.id).join('\n');
      if (!issueId || !stateId) die(`ticket "${ticket}" or status "${target}" not found in Linear`);
      const moved = gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issueId, input: { stateId } });
      if (moved.data?.issueUpdate?.success !== true) die(`Linear did not move ${ticket}`);
      print(`${ticket} -> ${target}`);
      return 0;
    }
    case 'waiting': {
      // What waits for the user: the tickets in the status that asks him. Not
      // « the tickets assigned to the one who asks »: the scripts act as the
      // application of the agents, to which nothing is assigned.
      const data = gql('query($team: String!, $state: String!) { issues(first: 50, filter: {team: {key: {eq: $team}}, state: {name: {eq: $state}}}) { nodes { identifier title url updatedAt comments(first: 1) { nodes { url createdAt } } } } }',
        { team: confGet('tracker', 'team'), state: confGet('tracker', 'validate_state') }).data;
      print((data.issues.nodes as Node[]).map((i) => ({ identifier: i.identifier ?? null, title: i.title ?? null, url: or(i.comments?.nodes?.[0]?.url, i.url),
        since: or(i.comments?.nodes?.[0]?.createdAt, i.updatedAt) })).sort(byKey('since')));
      return 0;
    }
    default:
      die(USAGE);
  }
});
