// The mirror's Linear tracker (P229): the issues of one team, through
// Linear's GraphQL API. A state is the team's workflow state of the same
// name as the app's; any other (Backlog, Triage, Canceled) reads as no
// state. Who made each change is read from the issue's history: the key's
// own user is the mirror's, a bot or an integration is an agent, any other
// user a person. Proven against a fake of the API only; a real trial is
// the owner's (docs/v2/mirrors.md).
import { DEFAULT_STATES, type TicketStates } from './contract.ts';
import { TrackerError, trackerFetch, type Tracker, type TrackerChange, type TrackerIssue } from './mirror-tracker.ts';

const PAGE = 50;
const HISTORY = 50;

type Named = { readonly id: string; readonly name: string } | null;
type Issue = {
  readonly id: string; readonly identifier: string; readonly url: string; readonly title: string; readonly description: string | null;
  readonly createdAt: string; readonly updatedAt: string; readonly state: { readonly name: string } | null;
  readonly history: { readonly nodes: readonly { readonly createdAt: string; readonly actor: Named; readonly botActor: Named; readonly toState: { readonly name: string } | null }[] };
};
type Setup = { readonly viewer: string; readonly team: string; readonly states: ReadonlyMap<string, string> };

const ISSUE_FIELDS = `id identifier url title description createdAt updatedAt state { name }
  history(first: ${HISTORY}) { nodes { createdAt actor { id name } botActor { id name } toState { name } } }`;

const SETUP = `query MirrorSetup($key: String!) {
  viewer { id }
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name } } } }
}`;
const ISSUES = `query MirrorIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
}`;
const CREATE = `mutation MirrorCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;
const MOVE = `mutation MirrorMove($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;
const COMMENT = `mutation MirrorComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

export class LinearTracker implements Tracker {
  readonly name: string;
  readonly title = 'Linear';
  readonly service?: string;                      // none: the team holds every service's tickets
  readonly #api: string;
  readonly #token: string;
  readonly #team: string;
  readonly #states: TicketStates;
  readonly #fetch: typeof fetch;
  #setup: Promise<Setup> | undefined;

  constructor(options: { readonly api: string; readonly token: string; readonly team: string; readonly states?: TicketStates; readonly fetch?: typeof fetch }) {
    this.#api = options.api;
    this.#token = options.token;
    this.#team = options.team;
    this.#states = options.states ?? DEFAULT_STATES;
    this.#fetch = options.fetch ?? fetch;
    this.name = `linear:${options.team}`;
  }

  // A personal key goes in the header as it is; an OAuth token is written
  // in its file as "Bearer <token>" (docs/v2/mirrors.md).
  async #request<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await trackerFetch(this.#fetch, 'Linear', this.#api, {
      method: 'POST',
      headers: { authorization: this.#token, 'content-type': 'application/json', 'user-agent': 'cleared-v2' },
      body: JSON.stringify({ query, variables, operationName: operation }),
    });
    const text = await response.text();
    let body: { data?: T; errors?: { message?: string }[] } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* said below by the status */ }
    const refusal = body.errors?.[0]?.message?.slice(0, 200);
    if (!response.ok) throw new TrackerError(`Linear answered ${response.status} to ${operation}${refusal ? `: ${refusal}` : ''}`);
    if (refusal || body.data === undefined) throw new TrackerError(`Linear refused ${operation}: ${refusal ?? 'no data'}`);
    return body.data;
  }

  // The key's own user and the team's states, read once.
  #ready(): Promise<Setup> {
    this.#setup ??= this.#request<{ viewer: { id: string }; teams: { nodes: { id: string; states: { nodes: { id: string; name: string }[] } }[] } }>('MirrorSetup', SETUP, { key: this.#team })
      .then((data) => {
        const team = data.teams.nodes[0];
        if (!team) throw new TrackerError(`Linear has no team ${this.#team} for this key`);
        const states = new Map<string, string>();
        for (const state of team.states.nodes) if (!states.has(state.name)) states.set(state.name, state.id);
        return { viewer: data.viewer.id, team: team.id, states };
      })
      .catch((error: unknown) => {
        this.#setup = undefined;
        throw error;
      });
    return this.#setup;
  }

  #known(name: string | undefined): name is string {
    return name !== undefined && Object.values(this.#states).includes(name);
  }

  #issueOf(issue: Issue, viewer: string): TrackerIssue {
    const changes: TrackerChange[] = [...issue.history.nodes]
      .filter((entry) => this.#known(entry.toState?.name))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((entry) => {
        const status = entry.toState?.name as string;
        if (entry.actor?.id === viewer) return { status, actor: 'mirror', who: entry.actor.name, at: entry.createdAt };
        if (entry.botActor) return { status, actor: 'agent', who: entry.botActor.name, at: entry.createdAt };
        if (entry.actor) return { status, actor: 'person', who: entry.actor.name, at: entry.createdAt };
        return { status, actor: 'agent', who: 'unknown', at: entry.createdAt };
      });
    const state = issue.state?.name;
    return {
      id: issue.id, key: issue.identifier, url: issue.url, title: issue.title, body: issue.description ?? '', labels: [],
      status: this.#known(state) ? state : null, createdAt: issue.createdAt, updatedAt: issue.updatedAt, changes,
    };
  }

  #stateId(setup: Setup, status: string): string {
    const id = setup.states.get(status);
    if (!id) throw new TrackerError(`the Linear team ${this.#team} has no state named ${status}`);
    return id;
  }

  async changed(since: string): Promise<TrackerIssue[]> {
    const setup = await this.#ready();
    const out: TrackerIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.#request('MirrorIssues', ISSUES, {
        filter: { team: { id: { eq: setup.team } }, updatedAt: { gte: since } }, first: PAGE, after,
      });
      out.push(...page.issues.nodes.map((issue) => this.#issueOf(issue, setup.viewer)));
      if (!page.issues.pageInfo.hasNextPage || !page.issues.pageInfo.endCursor) return out;
      after = page.issues.pageInfo.endCursor;
    }
  }

  async create(input: { readonly title: string; readonly body: string; readonly labels: readonly string[]; readonly status: string }): Promise<TrackerIssue> {
    const setup = await this.#ready();
    const data = await this.#request<{ issueCreate: { success: boolean; issue: Issue | null } }>('MirrorCreate', CREATE, {
      input: { teamId: setup.team, title: input.title, description: input.body, stateId: this.#stateId(setup, input.status) },
    });
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new TrackerError('Linear did not create the issue');
    return this.#issueOf(data.issueCreate.issue, setup.viewer);
  }

  async move(id: string, status: string): Promise<void> {
    const setup = await this.#ready();
    const data = await this.#request<{ issueUpdate: { success: boolean } }>('MirrorMove', MOVE, { id, input: { stateId: this.#stateId(setup, status) } });
    if (!data.issueUpdate.success) throw new TrackerError('Linear did not move the issue');
  }

  async comment(id: string, body: string): Promise<void> {
    const data = await this.#request<{ commentCreate: { success: boolean } }>('MirrorComment', COMMENT, { input: { issueId: id, body } });
    if (!data.commentCreate.success) throw new TrackerError('Linear did not write the comment');
  }
}
