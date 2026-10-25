// The mirror's GitHub Issues tracker (P230): the issues of one repository,
// through GitHub's REST API. A state is one `status:<state>` label on an
// open issue, as v1's GitHub adapter wrote it (lib/tracker/adapters/
// github.ts); an open issue with none is in Todo, one with two reads as no
// state; Done is the issue closed as completed. Who made each change is
// read from the issue's events: the token's own account is the mirror's, a
// bot or an app is an agent, anyone else a person.
import { DEFAULT_STATES, type TicketStates } from './contract.ts';
import { TrackerError, trackerFetch, type Tracker, type TrackerChange, type TrackerIssue } from './mirror-tracker.ts';

const PER_PAGE = 100;
const STATUS = 'status:';

type Account = { readonly login?: string; readonly type?: string } | null;
type Issue = {
  readonly number: number; readonly title: string; readonly body: string | null; readonly state: string; readonly state_reason?: string | null;
  readonly labels: readonly (string | { readonly name?: string })[]; readonly created_at: string; readonly updated_at: string;
  readonly html_url: string; readonly pull_request?: unknown;
};
type Event = {
  readonly event: string; readonly actor: Account; readonly created_at: string; readonly label?: { readonly name?: string };
  readonly state_reason?: string | null; readonly performed_via_github_app?: unknown;
};

const labelName = (label: string | { readonly name?: string }) => (typeof label === 'string' ? label : label.name ?? '');

export class GitHubTracker implements Tracker {
  readonly name: string;
  readonly title = 'GitHub';
  readonly service?: string;
  readonly #api: string;
  readonly #token: string;
  readonly #repo: string;
  readonly #states: TicketStates;
  readonly #fetch: typeof fetch;
  #login: Promise<string> | undefined;

  constructor(options: { readonly api: string; readonly token: string; readonly repo: string; readonly service?: string; readonly states?: TicketStates; readonly fetch?: typeof fetch }) {
    this.#api = options.api.replace(/\/+$/, '');
    this.#token = options.token;
    this.#repo = options.repo;
    this.#states = options.states ?? DEFAULT_STATES;
    this.#fetch = options.fetch ?? fetch;
    this.name = `github:${options.repo}`;
    if (options.service !== undefined) this.service = options.service;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await trackerFetch(this.#fetch, 'GitHub', `${this.#api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'cleared-v2',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TrackerError(`GitHub answered ${response.status} to ${method} ${path.split('?')[0]}`);
    }
    return (await response.json()) as T;
  }

  async #pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.#request<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`);
      all.push(...items);
      if (items.length < PER_PAGE) return all;
    }
  }

  // The token's own account, read once.
  #me(): Promise<string> {
    this.#login ??= this.#request<{ login: string }>('GET', '/user').then((user) => user.login, (error: unknown) => {
      this.#login = undefined;
      throw error;
    });
    return this.#login;
  }

  #known(state: string): boolean {
    return Object.values(this.#states).includes(state);
  }

  #statusOf(state: string, reason: string | null | undefined, labels: Iterable<string>): string | null {
    if (state === 'closed') return reason === 'not_planned' ? null : this.#states.done;
    const named = [...labels].filter((l) => l.startsWith(STATUS) && this.#known(l.slice(STATUS.length)));
    if (named.length === 0) return this.#states.todo;
    return named.length === 1 ? (named[0] as string).slice(STATUS.length) : null;
  }

  #actorOf(event: Event, me: string): Pick<TrackerChange, 'actor' | 'who'> {
    const login = event.actor?.login;
    if (!login) return { actor: 'agent', who: 'unknown' };
    if (login === me) return { actor: 'mirror', who: login };
    if (event.actor?.type === 'Bot' || event.performed_via_github_app) return { actor: 'agent', who: login };
    return { actor: 'person', who: login };
  }

  // The state after each of the issue's events, from the state before the
  // first one (the events undone from the issue as it is now). Events made
  // at once by one account (a label swapped on GitHub's page) are one change.
  #changes(issue: Issue, events: readonly Event[], me: string): TrackerChange[] {
    const relevant = events.filter((e) => ['labeled', 'unlabeled', 'closed', 'reopened'].includes(e.event));
    const labels = new Set(issue.labels.map(labelName));
    let state = issue.state;
    let reason = issue.state_reason ?? null;
    for (const event of [...relevant].reverse()) {
      const name = event.label?.name ?? '';
      if (event.event === 'labeled') labels.delete(name);
      else if (event.event === 'unlabeled') labels.add(name);
      else if (event.event === 'closed') state = 'open';
      else state = 'closed';
    }
    const changes: TrackerChange[] = [];
    let before = this.#statusOf(state, reason, labels);
    for (let i = 0; i < relevant.length; i++) {
      const event = relevant[i] as Event;
      const name = event.label?.name ?? '';
      if (event.event === 'labeled') labels.add(name);
      else if (event.event === 'unlabeled') labels.delete(name);
      else if (event.event === 'closed') { state = 'closed'; reason = event.state_reason ?? 'completed'; }
      else { state = 'open'; reason = null; }
      const next = relevant[i + 1];
      if (next && next.created_at === event.created_at && next.actor?.login === event.actor?.login) continue;
      const status = this.#statusOf(state, reason, labels);
      if (status !== null && status !== before) changes.push({ status, ...this.#actorOf(event, me), at: event.created_at });
      before = status;
    }
    return changes;
  }

  #issueOf(issue: Issue, changes: readonly TrackerChange[]): TrackerIssue {
    const labels = issue.labels.map(labelName);
    return {
      id: String(issue.number), key: `${this.#repo}#${issue.number}`, url: issue.html_url, title: issue.title, body: issue.body ?? '',
      labels: labels.filter((l) => !l.startsWith(STATUS)), status: this.#statusOf(issue.state, issue.state_reason, labels),
      createdAt: issue.created_at, updatedAt: issue.updated_at, changes,
    };
  }

  async changed(since: string): Promise<TrackerIssue[]> {
    const me = await this.#me();
    const issues = await this.#pages<Issue>(`/repos/${this.#repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}`);
    const out: TrackerIssue[] = [];
    for (const issue of issues) {
      if (issue.pull_request !== undefined) continue;
      const events = await this.#pages<Event>(`/repos/${this.#repo}/issues/${issue.number}/events`);
      out.push(this.#issueOf(issue, this.#changes(issue, events, me)));
    }
    return out;
  }

  async create(input: { readonly title: string; readonly body: string; readonly labels: readonly string[]; readonly status: string }): Promise<TrackerIssue> {
    const made = await this.#request<Issue>('POST', `/repos/${this.#repo}/issues`, { title: input.title, body: input.body, labels: [...input.labels, `${STATUS}${input.status}`] });
    if (input.status !== this.#states.done) return this.#issueOf(made, []);
    return this.#issueOf(await this.#request<Issue>('PATCH', `/repos/${this.#repo}/issues/${made.number}`, { state: 'closed', state_reason: 'completed' }), []);
  }

  // The new label on first, then the old ones off, so that the issue never
  // reads as having no state; then closed or reopened for Done.
  async move(id: string, status: string): Promise<void> {
    const path = `/repos/${this.#repo}/issues/${encodeURIComponent(id)}`;
    const issue = await this.#request<Issue>('GET', path);
    const labels = issue.labels.map(labelName);
    const next = `${STATUS}${status}`;
    if (!labels.includes(next)) await this.#request('POST', `${path}/labels`, { labels: [next] });
    for (const old of labels.filter((l) => l.startsWith(STATUS) && l !== next)) await this.#request('DELETE', `${path}/labels/${encodeURIComponent(old)}`);
    const done = status === this.#states.done;
    if (done && issue.state === 'open') await this.#request('PATCH', path, { state: 'closed', state_reason: 'completed' });
    if (!done && issue.state === 'closed') await this.#request('PATCH', path, { state: 'open' });
  }

  async comment(id: string, body: string): Promise<void> {
    await this.#request('POST', `/repos/${this.#repo}/issues/${encodeURIComponent(id)}/comments`, { body });
  }
}
