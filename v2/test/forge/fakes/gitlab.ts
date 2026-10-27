// A fake GitLab on loopback, port 0: the REST calls (/api/v4) the GitLab
// adapter of the forge contract, the lock's GitLab branch, the assistant's
// forge step and the doctor's gitlab section make. It answers over a world
// of projects, merge requests, commit statuses, pipelines and commits; one
// token is accepted, in the PRIVATE-TOKEN header, any other is answered 401
// as GitLab answers. Each request is recorded (method, path, query, whether
// the token came, its body); the token's value is never recorded. Only
// node:http, so the v1 lock's tests can use it too. No call reaches GitLab.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type GitLabStatus = { id: number; name: string; status: string; target_url: string | null; allow_failure: boolean; log?: string };
export type GitLabProject = { path_with_namespace: string; http_url_to_repo: string; default_branch: string | null; visibility: 'private' | 'internal' | 'public'; archived: boolean; access_level: number };
export type GitLabMr = {
  project: string;
  iid: number;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  draft: boolean;
  created_at: string;
  notes: string[];
  merge_commit_sha: string | null;
  merged_at: string | null;
};
export type GitLabWorld = {
  user: { username: string };
  scopes: string[] | null;                                  // null: the token's own page answers 404 (an older GitLab)
  projects: GitLabProject[];
  mrs: GitLabMr[];
  statuses: Record<string, GitLabStatus[]>;                 // by commit
  pipelines: { project: string; status: string }[];
  commits: Record<string, { id: string; committed_date: string }>;   // by project@ref
};
export type GitLabRequest = { method: string; path: string; query: Record<string, string>; token: boolean; body: Record<string, unknown> | null };

export const emptyGitLab = (): GitLabWorld => ({ user: { username: 'cleared-bot' }, scopes: ['api'], projects: [], mrs: [], statuses: {}, pipelines: [], commits: {} });

const json = async (request: IncomingMessage): Promise<Record<string, unknown> | null> => {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  if (!text) return null;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { unreadable: text }; }
};

export class FakeGitLab {
  world: GitLabWorld;
  readonly requests: GitLabRequest[] = [];
  status: number | undefined;                               // forces every answer's status (403, 500)
  redirect: string | undefined;                             // answers every request 302 to this address
  // The merge of a merge request, done by the test (a real merge of its
  // git remote): its merge commit, or undefined to answer 405.
  onMerge: ((mr: GitLabMr, sha: string) => string | undefined) | undefined;
  readonly #token: string;
  #server: Server | undefined;

  constructor(token: string, world: GitLabWorld = emptyGitLab()) {
    this.#token = token;
    this.world = world;
  }

  #mr(project: string, iid: number): GitLabMr | undefined {
    return this.world.mrs.find((mr) => mr.project === project && mr.iid === iid);
  }

  #mrView(mr: GitLabMr) {
    const { project: _project, notes: _notes, ...view } = mr;
    return { ...view, id: 1000 + mr.iid, work_in_progress: mr.draft };
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => void this.#answer(request, response));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async #answer(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const method = request.method ?? 'GET';
    const body = method === 'GET' ? null : await json(request);
    const token = request.headers['private-token'];
    this.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: token !== undefined, body });
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      if (typeof value === 'string') response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(value);
      else response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
    };
    if (this.redirect) return send(302, '', { location: this.redirect });
    if (this.status) return send(this.status, { message: `${this.status} forced` });
    if (token !== this.#token) return send(401, { message: '401 Unauthorized' });
    const parts = url.pathname.split('/').slice(1);
    if (parts[0] !== 'api' || parts[1] !== 'v4') return send(404, { message: '404 Not Found' });
    const [what, id, ...rest] = parts.slice(2);
    const project = id === undefined ? undefined : decodeURIComponent(id);
    const tail = rest.join('/');
    const notFound = () => send(404, { message: '404 Not found' });
    const page = <T>(all: T[]) => {
      const per = Number(url.searchParams.get('per_page') ?? 20);
      const at = Number(url.searchParams.get('page') ?? 1);
      send(200, all.slice((at - 1) * per, at * per), { 'x-next-page': at * per < all.length ? String(at + 1) : '' });
    };
    if (method === 'GET' && what === 'user' && id === undefined) return send(200, { id: 7, username: this.world.user.username });
    if (method === 'GET' && what === 'personal_access_tokens' && id === 'self') return this.world.scopes ? send(200, { id: 1, name: 'cleared', scopes: this.world.scopes, active: true }) : notFound();
    if (what !== 'projects') return notFound();
    if (method === 'GET' && project === undefined) {
      if (url.searchParams.get('membership') !== 'true') return send(200, [{ path_with_namespace: 'everyone/public', http_url_to_repo: 'https://gitlab.invalid/everyone/public.git', default_branch: 'main', visibility: 'public', archived: false }]);
      return page(this.world.projects.map(({ access_level: _a, ...p }) => p));
    }
    const known = this.world.projects.find((p) => p.path_with_namespace === project);
    if (!known || project === undefined) return notFound();
    if (method === 'GET' && tail === '') {
      const { access_level, ...p } = known;
      return send(200, { ...p, permissions: { project_access: access_level ? { access_level } : null, group_access: null } });
    }
    if (method === 'GET' && tail === 'merge_requests') {
      const state = url.searchParams.get('state');
      const branch = url.searchParams.get('source_branch');
      const open = this.world.mrs.filter((mr) => mr.project === project && (!state || mr.state === state) && (!branch || mr.source_branch === branch));
      return send(200, open.sort((a, b) => b.iid - a.iid).map((mr) => this.#mrView(mr)));
    }
    if (method === 'POST' && tail === 'merge_requests') {
      const iid = Math.max(0, ...this.world.mrs.filter((mr) => mr.project === project).map((mr) => mr.iid)) + 1;
      const made: GitLabMr = {
        project, iid, web_url: `https://forge.invalid/${project}/pull/${iid}`, source_branch: String(body?.source_branch), target_branch: String(body?.target_branch),
        sha: 'c'.repeat(40), title: String(body?.title), description: String(body?.description ?? ''), state: 'opened', draft: false,
        created_at: '2026-10-25T10:00:00.000Z', notes: [], merge_commit_sha: null, merged_at: null,
      };
      this.world.mrs.push(made);
      return send(201, this.#mrView(made));
    }
    const onMr = /^merge_requests\/(\d+)(?:\/(notes|merge))?$/.exec(tail);
    if (onMr) {
      const mr = this.#mr(project, Number(onMr[1]));
      if (!mr) return notFound();
      if (method === 'GET' && !onMr[2]) return send(200, this.#mrView(mr));
      if (method === 'PUT' && !onMr[2]) {
        if (typeof body?.description === 'string') mr.description = body.description;
        if (body?.state_event === 'close') mr.state = 'closed';
        return send(200, this.#mrView(mr));
      }
      if (method === 'POST' && onMr[2] === 'notes') {
        mr.notes.push(String(body?.body));
        return send(201, { id: mr.notes.length, body: body?.body });
      }
      if (method === 'PUT' && onMr[2] === 'merge') {
        if (mr.state !== 'opened' || mr.draft) return send(405, { message: '405 Method Not Allowed' });
        if (typeof body?.sha === 'string' && body.sha !== mr.sha) return send(409, { message: 'SHA does not match HEAD of source branch' });
        const merged = this.onMerge?.(mr, String(body?.sha));
        if (!merged) return send(405, { message: '405 Method Not Allowed' });
        Object.assign(mr, { state: 'merged', merge_commit_sha: merged, merged_at: new Date().toISOString() });
        return send(200, this.#mrView(mr));
      }
    }
    const statuses = /^repository\/commits\/([^/]+)\/statuses$/.exec(tail);
    if (method === 'GET' && statuses) return page(this.world.statuses[statuses[1] ?? ''] ?? []);
    const commit = /^repository\/commits\/([^/]+)$/.exec(tail);
    if (method === 'GET' && commit) {
      const found = this.world.commits[`${project}@${decodeURIComponent(commit[1] ?? '')}`];
      return found ? send(200, found) : notFound();
    }
    const trace = /^jobs\/(\d+)\/trace$/.exec(tail);
    if (method === 'GET' && trace) {
      const status = Object.values(this.world.statuses).flat().find((s) => s.id === Number(trace[1]));
      return status?.log === undefined ? notFound() : send(200, status.log);
    }
    if (method === 'GET' && tail === 'pipelines') {
      const wanted = url.searchParams.get('status');
      return page(this.world.pipelines.filter((p) => p.project === project && (!wanted || p.status === wanted)).map((p, i) => ({ id: i + 1, status: p.status })));
    }
    send(404, { message: `404 no route ${method} ${tail}` });
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
