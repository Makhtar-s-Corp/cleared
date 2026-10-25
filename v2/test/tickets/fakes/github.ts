// A fake of the part of GitHub's REST API the GitHub mirror reads and
// writes, on loopback, port 0. Each token is an account; a test acts on an
// issue as a person or a bot through the methods, the mirror through HTTP.
// As GitHub's, its issue events say a change of the title (`renamed`) and
// nothing of a change of the body. An assignment is an `assigned` event
// naming its assignee (a delegation, C3, P244).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeAccount = { readonly login: string; readonly type: 'User' | 'Bot' };
type Label = { name: string };
type Issue = {
  number: number; title: string; body: string | null; state: 'open' | 'closed'; state_reason: string | null;
  labels: Label[]; assignees: FakeAccount[]; created_at: string; updated_at: string; html_url: string; user: FakeAccount; pull_request?: { url: string };
};
type Event = {
  id: number; event: string; actor: FakeAccount | null; created_at: string; label?: Label; state_reason?: string | null;
  rename?: { from: string; to: string }; assignee?: FakeAccount; performed_via_github_app: unknown;
};
export type FakeComment = { id: number; body: string; user: FakeAccount; created_at: string; updated_at: string; issue_url: string; performed_via_github_app: unknown };

export class FakeGitHub {
  readonly requests: { method: string; path: string; auth: string | undefined }[] = [];
  readonly comments = new Map<number, FakeComment[]>();
  #server: Server | undefined;
  #accounts = new Map<string, FakeAccount>();
  #repos = new Map<string, { issues: Map<number, Issue>; events: Map<number, Event[]> }>();
  #next = 1;
  #event = 1;
  #comment = 1;
  #clock: () => string;

  constructor(options: { readonly clock: () => string; readonly accounts: Record<string, FakeAccount>; readonly repos: readonly string[] }) {
    this.#clock = options.clock;
    for (const [token, account] of Object.entries(options.accounts)) this.#accounts.set(token, account);
    for (const repo of options.repos) this.#repos.set(repo, { issues: new Map(), events: new Map() });
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => void this.#serve(request, response));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #repo(repo: string) {
    const held = this.#repos.get(repo);
    if (!held) throw new Error(`no repository ${repo}`);
    return held;
  }

  issue(repo: string, number: number): Issue {
    const issue = this.#repo(repo).issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  }

  events(repo: string, number: number): Event[] {
    return this.#repo(repo).events.get(number) ?? [];
  }

  // A person's issue or pull request, opened on GitHub.
  open(repo: string, by: FakeAccount, input: { title: string; body?: string; labels?: string[]; pullRequest?: boolean }): Issue {
    const at = this.#clock();
    const number = this.#next++;
    const issue: Issue = {
      number, title: input.title, body: input.body ?? null, state: 'open', state_reason: null,
      labels: (input.labels ?? []).map((name) => ({ name })), assignees: [], created_at: at, updated_at: at,
      html_url: `https://github.com/${repo}/issues/${number}`, user: by,
      ...(input.pullRequest ? { pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` } } : {}),
    };
    this.#repo(repo).issues.set(number, issue);
    this.#repo(repo).events.set(number, []);
    return issue;
  }

  #record(repo: string, number: number, by: FakeAccount, event: string, extra: Partial<Event> = {}): void {
    const at = this.#clock();
    this.#repo(repo).events.get(number)?.push({ id: this.#event++, event, actor: by, created_at: at, performed_via_github_app: null, ...extra });
    this.issue(repo, number).updated_at = at;
  }

  label(repo: string, number: number, by: FakeAccount, name: string): void {
    const issue = this.issue(repo, number);
    if (issue.labels.some((l) => l.name === name)) return;
    issue.labels.push({ name });
    this.#record(repo, number, by, 'labeled', { label: { name } });
  }

  unlabel(repo: string, number: number, by: FakeAccount, name: string): boolean {
    const issue = this.issue(repo, number);
    if (!issue.labels.some((l) => l.name === name)) return false;
    issue.labels = issue.labels.filter((l) => l.name !== name);
    this.#record(repo, number, by, 'unlabeled', { label: { name } });
    return true;
  }

  assign(repo: string, number: number, by: FakeAccount, assignee: FakeAccount): void {
    const issue = this.issue(repo, number);
    if (issue.assignees.some((a) => a.login === assignee.login)) return;
    issue.assignees.push(assignee);
    this.#record(repo, number, by, 'assigned', { assignee });
  }

  unassign(repo: string, number: number, by: FakeAccount, assignee: FakeAccount): void {
    const issue = this.issue(repo, number);
    if (!issue.assignees.some((a) => a.login === assignee.login)) return;
    issue.assignees = issue.assignees.filter((a) => a.login !== assignee.login);
    this.#record(repo, number, by, 'unassigned', { assignee });
  }

  // A person moves the issue as GitHub's screen does: the old status label off, the new one on.
  status(repo: string, number: number, by: FakeAccount, state: string): void {
    for (const label of this.issue(repo, number).labels.filter((l) => l.name.startsWith('status:') && l.name !== `status:${state}`)) this.unlabel(repo, number, by, label.name);
    this.label(repo, number, by, `status:${state}`);
  }

  close_(repo: string, number: number, by: FakeAccount, reason: 'completed' | 'not_planned' = 'completed'): void {
    const issue = this.issue(repo, number);
    issue.state = 'closed';
    issue.state_reason = reason;
    this.#record(repo, number, by, 'closed', { state_reason: reason });
  }

  reopen(repo: string, number: number, by: FakeAccount): void {
    const issue = this.issue(repo, number);
    issue.state = 'open';
    issue.state_reason = 'reopened';
    this.#record(repo, number, by, 'reopened');
  }

  // A change of the title or the body, as GitHub's page makes it.
  edit(repo: string, number: number, by: FakeAccount, fields: { title?: string; body?: string }): void {
    const issue = this.issue(repo, number);
    if (fields.title !== undefined && fields.title !== issue.title) {
      const from = issue.title;
      issue.title = fields.title;
      this.#record(repo, number, by, 'renamed', { rename: { from, to: fields.title } });
    }
    if (fields.body !== undefined && fields.body !== issue.body) {
      issue.body = fields.body;
      issue.updated_at = this.#clock();
    }
  }

  comment(repo: string, number: number, by: FakeAccount, body: string): FakeComment {
    const at = this.#clock();
    const comment: FakeComment = {
      id: 9000 + this.#comment++, body, user: by, created_at: at, updated_at: at,
      issue_url: `https://api.github.com/repos/${repo}/issues/${number}`, performed_via_github_app: null,
    };
    const list = this.comments.get(number) ?? [];
    list.push(comment);
    this.comments.set(number, list);
    this.issue(repo, number).updated_at = at;
    return comment;
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const auth = request.headers.authorization;
    this.requests.push({ method: request.method ?? '', path: url.pathname + url.search, auth });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const account = auth?.startsWith('Bearer ') ? this.#accounts.get(auth.slice('Bearer '.length)) : undefined;
    if (!account) return send(401, { message: 'Bad credentials' });
    if (request.headers.accept !== 'application/vnd.github+json') return send(415, { message: 'the media type is GitHub\'s' });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    const method = request.method;
    if (method === 'GET' && url.pathname === '/user') return send(200, { login: account.login, type: account.type });
    const listed = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(url.pathname);
    if (listed && method === 'GET') {
      const held = this.#repos.get(listed[1] as string);
      if (!held) return send(404, { message: 'Not Found' });
      const since = url.searchParams.get('since');
      const all = [...held.issues.keys()].flatMap((n) => this.comments.get(n) ?? [])
        .filter((c) => !since || c.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id);
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      return send(200, all.slice((page - 1) * perPage, page * perPage));
    }
    const match = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(?:\/(labels|events|comments)(?:\/([^/]+))?)?)?$/.exec(url.pathname);
    if (!match || !this.#repos.has(match[1] as string)) return send(404, { message: 'Not Found' });
    const repo = match[1] as string;
    const number = match[2] ? Number(match[2]) : undefined;
    const part = match[3];
    const held = this.#repo(repo);
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const paged = <T>(all: T[]) => all.slice((page - 1) * perPage, page * perPage);
    if (number === undefined) {
      if (method === 'GET') {
        const since = url.searchParams.get('since');
        if (url.searchParams.get('state') !== 'all') return send(422, { message: 'the mirror reads every state' });
        const all = [...held.issues.values()].filter((i) => !since || i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
        return send(200, paged(all));
      }
      if (method === 'POST') {
        const issue = this.open(repo, account, { title: String(body.title), body: String(body.body ?? '') });
        for (const name of (body.labels as string[] | undefined) ?? []) issue.labels.push({ name });
        return send(201, issue);
      }
      return send(405, {});
    }
    const issue = held.issues.get(number);
    if (!issue) return send(404, { message: 'Not Found' });
    if (part === undefined) {
      if (method === 'GET') return send(200, issue);
      if (method === 'PATCH') {
        this.edit(repo, number, account, { ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.body === 'string' ? { body: body.body } : {}) });
        if (body.state === 'closed' && issue.state === 'open') this.close_(repo, number, account, (body.state_reason as 'completed' | undefined) ?? 'completed');
        if (body.state === 'open' && issue.state === 'closed') this.reopen(repo, number, account);
        return send(200, issue);
      }
      return send(405, {});
    }
    if (part === 'labels') {
      if (method === 'POST') {
        for (const name of (body.labels as string[] | undefined) ?? []) this.label(repo, number, account, name);
        return send(200, issue.labels);
      }
      if (method === 'DELETE' && match[4]) {
        return this.unlabel(repo, number, account, decodeURIComponent(match[4])) ? send(200, issue.labels) : send(404, { message: 'Label does not exist' });
      }
      return send(405, {});
    }
    if (part === 'events' && method === 'GET') return send(200, paged(this.events(repo, number)));
    if (part === 'comments' && method === 'POST') return send(201, this.comment(repo, number, account, String(body.body)));
    return send(405, {});
  }
}
