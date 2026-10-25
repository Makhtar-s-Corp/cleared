// The three trackers as the human: what the app writes when the human clears a ticket to land,
// sends it back or answers. One client per adapter, all with the same five operations (who the
// token is, the ticket's status, move, comment, who moved it last). Provider names live here, with
// the other adapters, and nowhere else in the app.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTracker } from './local.ts';
import { GithubTracker } from './github.ts';
import type { ConfSections, Section } from '../../conf.ts';
import type { ActionAuthor, Identity } from '../contract.ts';

export type HumanCredentials = { token?: string; signingKey: string };
export type HumanOptions = { conf: ConfSections; creds: HumanCredentials; settings?: Section };
export type HumanClient = {
  whoAmI(): Promise<Identity>;
  state(ticket: string): Promise<string | null>;
  move(ticket: string, status: string): Promise<void>;
  comment(ticket: string, body: string): Promise<void>;
  lastMoveBy(ticket: string, status: string): Promise<ActionAuthor | null>;
  close(): void;
};
type LinearMove = { createdAt: string; actorId?: string | null; actor?: { id?: string; app?: boolean } | null; botActor?: { name?: string } | null; toState?: { name?: string } | null };

// An address the app may call: https, or http on this very machine (tests, a local proxy). A different
// address (GitHub Enterprise, a test double) is set in the service's environment, never in the project's
// settings: a settings change must not be able to send the human's token somewhere else.
const endpoint = (value: string | undefined, fallback: string): string => {
  const url = new URL(value || fallback);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error(`${url.origin} must be https`);
  return url.href.replace(/\/$/, '');
};

// ---- Local tracker: the signing key of the human, copied for the app account.
function local({ conf, creds }: HumanOptions): HumanClient {
  // perform() (app/lib/human-tracker.ts) refuses a [tracker] without owner_id first.
  const settings = conf.sections.tracker as Section & { owner_id: string };
  const owned = { ...conf, sections: { ...conf.sections, tracker: { ...settings, human_private_key: creds.signingKey } } };
  const tracker = new LocalTracker({ conf: owned, actor: { kind: 'human', id: settings.owner_id } });
  return {
    async whoAmI() { return tracker.whoAmI(); },
    async state(ticket) { return tracker.getTicket(ticket)?.status ?? null; },
    async move(ticket, status) { tracker.moveTicket(ticket, status); },
    async comment(ticket, body) { tracker.comment(ticket, body); },
    async lastMoveBy(ticket, status) { const last = tracker.history(ticket).at(-1); return last?.status === status ? last.by : null; },
    close() { tracker.close(); },
  };
}

// ---- GitHub: the human's token (a user token, never the agents' installation token).
function github({ conf, creds, settings }: HumanOptions): HumanClient {
  const base = endpoint(process.env.CLEARED_APP_GITHUB_API, 'https://api.github.com');
  if (!/^[A-Za-z0-9_.=-]{20,255}$/.test(creds.token as string)) throw new Error('credentials.json: the token has an unexpected form');
  // The token goes to curl on its standard input (as a config file), never in an argument or the environment.
  const curl = (target: string, method: string, input?: unknown): unknown => {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-human-'));
    try {
      const config = ['silent', 'show-error', 'fail', 'max-time = 30', `request = "${method}"`, `url = "${target}"`,
        `header = "Authorization: Bearer ${creds.token}"`, 'header = "Accept: application/vnd.github+json"',
        'header = "X-GitHub-Api-Version: 2022-11-28"', 'header = "Content-Type: application/json"'];
      if (input !== undefined) { const file = join(dir, 'body'); writeFileSync(file, JSON.stringify(input), { mode: 0o600 }); config.push(`data-binary = "@${file}"`); }
      const out = execFileSync('curl', ['--config', '-'], { input: config.join('\n'), encoding: 'utf8', timeout: 35000, maxBuffer: 20_000_000 });
      return out.trim() ? JSON.parse(out) : {};
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const call = (path: string, method = 'GET', input?: unknown): unknown => {
    const url = path === 'graphql' ? `${base}/graphql` : `${base}${path}`;
    if (method !== 'GET' || !path.includes('per_page=100')) return curl(url, method, input);
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const part = curl(`${url}&page=${page}`, 'GET');
      if (!Array.isArray(part)) return part;
      all.push(...part);
      if (part.length < 100) break;
    }
    return all;
  };
  const tracker = new GithubTracker({ conf, api: call });
  return {
    async whoAmI() { return tracker.whoAmI(); },
    async state(ticket) { return tracker.getTicket(ticket)?.status ?? null; },
    async move(ticket, status) { tracker.moveTicket(ticket, status); },
    // GithubTracker.comment is for the agents' installation only; a human comment is the plain REST call.
    async comment(ticket, body) { tracker.rest(`/issues/${Number(String(ticket).replace(/^GH-/, ''))}/comments`, 'POST', { body }); },
    async lastMoveBy(ticket, status) { const last = tracker.history(ticket).at(-1); return last?.status === status ? last.by : null; },
    close() {},
  };
}

// ---- Linear: the human's OAuth token (user mode), not the application of the agents.
function linear({ conf, creds, settings }: HumanOptions): HumanClient {
  const url = endpoint(process.env.CLEARED_APP_LINEAR_API, 'https://api.linear.app/graphql');
  const owner = conf.sections.tracker!.owner_id;
  const team = conf.sections.tracker!.team;
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` }, body: JSON.stringify({ query, variables }) });
    const body = await response.json().catch(() => ({})) as { data?: unknown; errors?: { message?: string }[] };
    if (!response.ok || body.errors?.length) throw new Error(`Linear: ${body.errors?.[0]?.message || response.status}`);
    return body.data as T;
  };
  return {
    async whoAmI() {
      const { viewer } = await gql<{ viewer?: { id?: string; app?: boolean } | null }>('query { viewer { id app } }');
      // owner_id is the Linear id of the human; a token of an application is never his.
      return { kind: viewer?.app !== true && viewer?.id && viewer.id === owner ? 'human' : 'shared', id: viewer?.id ?? '' };
    },
    async state(ticket) { return (await gql<{ issue?: { state?: { name?: string } | null } | null }>('query($id: String!) { issue(id: $id) { state { name } } }', { id: ticket })).issue?.state?.name ?? null; },
    async move(ticket, status) {
      const found = await gql<{ issue?: { id?: string } | null; teams?: { nodes?: { states?: { nodes?: { id: string; name: string }[] } }[] } }>('query($id: String!, $team: String!) { issue(id: $id) { id } teams(filter: {key: {eq: $team}}) { nodes { states { nodes { id name } } } } }', { id: ticket, team });
      const stateId = found.teams?.nodes?.[0]?.states?.nodes?.find((s) => s.name === status)?.id;
      if (!found.issue?.id || !stateId) throw new Error(`Linear: ticket or status not found (${status})`);
      const done = await gql<{ issueUpdate?: { success?: boolean } }>('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: found.issue.id, input: { stateId } });
      if (done.issueUpdate?.success !== true) throw new Error('Linear did not move the ticket');
    },
    async comment(ticket, body) {
      const found = await gql<{ issue?: { id?: string } | null }>('query($id: String!) { issue(id: $id) { id } }', { id: ticket });
      if (!found.issue?.id) throw new Error('Linear: ticket not found');
      const done = await gql<{ commentCreate?: { success?: boolean } }>('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: found.issue.id, body } });
      if (done.commentCreate?.success !== true) throw new Error('Linear did not take the comment');
    },
    async lastMoveBy(ticket, status) {
      const { viewer, issue } = await gql<{ viewer?: { id?: string } | null; issue?: { history?: { nodes?: LinearMove[] } } | null }>('query($id: String!) { viewer { id } issue(id: $id) { history(first: 40) { nodes { createdAt actorId actor { id app } botActor { name } toState { name } } } } }', { id: ticket });
      const moves = (issue?.history?.nodes ?? []).filter((node) => node.toState).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = moves.at(-1);
      if (last?.toState?.name !== status) return null;
      const human = !last.botActor && last.actor?.app !== true && last.actorId && last.actorId === viewer?.id && last.actorId === owner;
      return { kind: human ? 'human' : 'other', id: last.actorId ?? '' };
    },
    close() {},
  };
}

const CLIENTS = { local, github, linear };

export const humanAdapters = Object.keys(CLIENTS);
export const humanClient = (adapter: string | undefined, options: HumanOptions): HumanClient => CLIENTS[adapter as keyof typeof CLIENTS](options);

