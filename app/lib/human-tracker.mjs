// What the app writes to the ticket tracker, under the identity of the human.
// It runs in a short-lived child process (app/human-write.mjs), so the human's
// tokens exist in memory only for the length of one gesture, and the web server
// never holds them. Three operations, nothing else: approve (the user's own
// status of agreement, for the exact version he was shown), send back, answer.
//
// Each adapter must prove the writer IS the human before anything is written
// (the tracker's own answer to "who am I"), and after the write the tracker's
// history must show the human as the author. A token that is not his, or an
// author the tracker cannot tell from an agent, stops the gesture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTracker } from '../../lib/tracker/adapters/local.mjs';
import { GithubTracker } from '../../lib/tracker/adapters/github.mjs';
import { approvalOf, sameVersions } from '../../lib/validation-record.mjs';
import { validText } from './text.mjs';

const refused = (code, message) => Object.assign(new Error(message), { code });

// An address the app may call: https, or http on this very machine (tests, a local proxy).
const endpoint = (value, fallback) => {
  const url = new URL(value || fallback);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error(`${url.origin} must be https`);
  return url.href.replace(/\/$/, '');
};

// ---- Local tracker: the signing key of the human, copied for the app account.
function local({ conf, creds }) {
  const settings = conf.sections.tracker;
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
function github({ conf, creds, settings }) {
  const base = endpoint(settings.github_api_url, 'https://api.github.com');
  if (!/^[A-Za-z0-9_.=-]{20,255}$/.test(creds.github_token)) throw new Error('credentials.json: github_token has an unexpected form');
  // The token goes to curl on its standard input (as a config file), never in an argument or the environment.
  const curl = (target, method, input) => {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-human-'));
    try {
      const config = ['silent', 'show-error', 'fail', 'max-time = 30', `request = "${method}"`, `url = "${target}"`,
        `header = "Authorization: Bearer ${creds.github_token}"`, 'header = "Accept: application/vnd.github+json"',
        'header = "X-GitHub-Api-Version: 2022-11-28"', 'header = "Content-Type: application/json"'];
      if (input !== undefined) { const file = join(dir, 'body'); writeFileSync(file, JSON.stringify(input), { mode: 0o600 }); config.push(`data-binary = "@${file}"`); }
      const out = execFileSync('curl', ['--config', '-'], { input: config.join('\n'), encoding: 'utf8', timeout: 35000, maxBuffer: 20_000_000 });
      return out.trim() ? JSON.parse(out) : {};
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const call = (path, method = 'GET', input) => {
    const url = path === 'graphql' ? `${base}/graphql` : `${base}${path}`;
    if (method !== 'GET' || !path.includes('per_page=100')) return curl(url, method, input);
    const all = [];
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
function linear({ conf, creds, settings }) {
  const url = endpoint(settings.linear_api_url, 'https://api.linear.app/graphql');
  const owner = conf.sections.tracker.owner_id;
  const team = conf.sections.tracker.team;
  const gql = async (query, variables = {}) => {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.linear_token}` }, body: JSON.stringify({ query, variables }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors?.length) throw new Error(`Linear: ${body.errors?.[0]?.message || response.status}`);
    return body.data;
  };
  return {
    async whoAmI() {
      const { viewer } = await gql('query { viewer { id app } }');
      // owner_id is the Linear id of the human; a token of an application is never his.
      return { kind: viewer?.app !== true && viewer?.id && viewer.id === owner ? 'human' : 'shared', id: viewer?.id ?? '' };
    },
    async state(ticket) { return (await gql('query($id: String!) { issue(id: $id) { state { name } } }', { id: ticket })).issue?.state?.name ?? null; },
    async move(ticket, status) {
      const found = await gql('query($id: String!, $team: String!) { issue(id: $id) { id } teams(filter: {key: {eq: $team}}) { nodes { states { nodes { id name } } } } }', { id: ticket, team });
      const stateId = found.teams?.nodes?.[0]?.states?.nodes?.find((s) => s.name === status)?.id;
      if (!found.issue?.id || !stateId) throw new Error(`Linear: ticket or status not found (${status})`);
      const done = await gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: found.issue.id, input: { stateId } });
      if (done.issueUpdate?.success !== true) throw new Error('Linear did not move the ticket');
    },
    async comment(ticket, body) {
      const found = await gql('query($id: String!) { issue(id: $id) { id } }', { id: ticket });
      if (!found.issue?.id) throw new Error('Linear: ticket not found');
      const done = await gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: found.issue.id, body } });
      if (done.commentCreate?.success !== true) throw new Error('Linear did not take the comment');
    },
    async lastMoveBy(ticket, status) {
      const { viewer, issue } = await gql('query($id: String!) { viewer { id } issue(id: $id) { history(first: 40) { nodes { createdAt actorId actor { id app } botActor { name } toState { name } } } } }', { id: ticket });
      const moves = (issue?.history?.nodes ?? []).filter((node) => node.toState).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = moves.at(-1);
      if (last?.toState?.name !== status) return null;
      const human = !last.botActor && last.actor?.app !== true && last.actorId && last.actorId === viewer?.id && last.actorId === owner;
      return { kind: human ? 'human' : 'other', id: last.actorId ?? '' };
    },
    close() {},
  };
}

const ADAPTERS = { local, github, linear };

export function targetStates(conf, settings = {}) {
  const t = conf.sections.tracker;
  const back = settings.sent_back_state || t.progress_state;
  if (!back || [t.go_state, t.done_state, t.validate_state].includes(back)) throw refused('config', '[app] sent_back_state must be a working status, never the approval, the agreement or done');
  return { validate: t.validate_state, go: t.go_state, back };
}

// request: { op: 'approve' | 'sendback' | 'answer', ticket, versions?, text? }
export async function perform(request, { conf, creds, settings = {}, project }) {
  const adapter = conf.sections.tracker?.adapter;
  if (!ADAPTERS[adapter]) throw refused('config', 'Unknown tracker adapter');
  if (!conf.sections.tracker.owner_id) throw refused('config', '[tracker] owner_id (the human) is required for app gestures');
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(String(request.ticket))) throw refused('input', 'Invalid ticket');
  const states = targetStates(conf, settings);
  const client = ADAPTERS[adapter]({ conf, creds, settings });
  try {
    const who = await client.whoAmI();
    if (who.kind !== 'human') throw refused('identity', 'The tracker does not see this access as the human: nothing written');
    const state = await client.state(request.ticket);
    if (request.op === 'answer') {
      if (!validText(request.text)) throw refused('input', 'Invalid answer');
      if (!state) throw refused('state', 'No such ticket');
      await client.comment(request.ticket, request.text);
      return { ok: true, author: who.id };
    }
    if (state !== states.validate) throw refused('state', `The ticket is not waiting for the user (it is in “${state}”)`);
    if (request.op === 'sendback') {
      if (!validText(request.text)) throw refused('input', 'Invalid text');
      await client.comment(request.ticket, request.text);
      await client.move(request.ticket, states.back);
      const by = await client.lastMoveBy(request.ticket, states.back);
      return { ok: true, author: who.id, verified: by?.kind === 'human' };
    }
    if (request.op === 'approve') {
      const record = approvalOf(request.ticket, project.state);
      if (!record) throw refused('version', 'No request for agreement is kept for this ticket');
      if (!sameVersions(record.versions, request.versions)) throw refused('version', 'The version asked for is not the one that was shown: review again');
      await client.move(request.ticket, states.go);
      const by = await client.lastMoveBy(request.ticket, states.go);
      if (by?.kind !== 'human') throw refused('author', 'The tracker does not show the human as the author of the move');
      return { ok: true, author: who.id, verified: true };
    }
    throw refused('input', 'Unknown operation');
  } finally { client.close(); }
}
