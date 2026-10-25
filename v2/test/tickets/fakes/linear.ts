// A fake of the part of Linear's GraphQL API the Linear mirror uses, on
// loopback, port 0. It answers the mirror's named operations only, checks
// that each query asks for the fields it answers with, and never needs a
// real key: each token is an account of the fake.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type State = { id: string; name: string };
type HistoryEntry = { createdAt: string; actor: { id: string; name: string } | null; botActor: { id: string; name: string } | null; toState: State | null };
type Issue = {
  id: string; identifier: string; url: string; title: string; description: string | null;
  createdAt: string; updatedAt: string; stateId: string; teamId: string; history: HistoryEntry[]; comments: { body: string; by: string }[];
};
export type FakeLinearActor = { readonly user: { id: string; name: string } } | { readonly bot: { id: string; name: string } };

// The fields each operation must ask for, so that a query that drops one fails here.
const ASKS: Record<string, readonly string[]> = {
  MirrorSetup: ['viewer', 'teams', 'states', 'name'],
  MirrorIssues: ['issues', 'identifier', 'url', 'description', 'createdAt', 'updatedAt', 'state', 'history', 'actor', 'botActor', 'toState', 'pageInfo', 'hasNextPage', 'endCursor'],
  MirrorCreate: ['issueCreate', 'success', 'identifier', 'url', 'state', 'history'],
  MirrorMove: ['issueUpdate', 'success'],
  MirrorComment: ['commentCreate', 'success'],
};

export class FakeLinear {
  readonly operations: { name: string; auth: string | undefined }[] = [];
  readonly team = { id: 'team-1', key: 'ENG' };
  readonly states: State[] = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Needs Approval', 'Ready to Ship', 'Done', 'Canceled']
    .map((name, i) => ({ id: `state-${i}`, name }));
  readonly issues = new Map<string, Issue>();
  #server: Server | undefined;
  #accounts = new Map<string, { id: string; name: string }>();
  #clock: () => string;
  #next = 1;

  constructor(options: { readonly clock: () => string; readonly accounts: Record<string, { id: string; name: string }> }) {
    this.#clock = options.clock;
    for (const [token, user] of Object.entries(options.accounts)) this.#accounts.set(token, user);
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => void this.#serve(request, response));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/graphql`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #state(name: string): State {
    const state = this.states.find((s) => s.name === name);
    if (!state) throw new Error(`no state ${name}`);
    return state;
  }

  #entry(by: FakeLinearActor, toState: State | null): HistoryEntry {
    return { createdAt: this.#clock(), actor: 'user' in by ? by.user : null, botActor: 'bot' in by ? by.bot : null, toState };
  }

  // An issue created on Linear by a person or an integration.
  create(by: FakeLinearActor, input: { title: string; description?: string; state: string }): Issue {
    const at = this.#clock();
    const number = this.#next++;
    const issue: Issue = {
      id: `issue-${number}`, identifier: `${this.team.key}-${number}`, url: `https://linear.app/example/issue/${this.team.key}-${number}`,
      title: input.title, description: input.description ?? null, createdAt: at, updatedAt: at, stateId: this.#state(input.state).id, teamId: this.team.id,
      history: [], comments: [],
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  move(id: string, by: FakeLinearActor, state: string): void {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    issue.stateId = this.#state(state).id;
    issue.updatedAt = this.#clock();
    issue.history.push(this.#entry(by, this.#state(state)));
  }

  stateOf(id: string): string | undefined {
    const issue = this.issues.get(id);
    return this.states.find((s) => s.id === issue?.stateId)?.name;
  }

  #view(issue: Issue) {
    return {
      id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title, description: issue.description,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt, state: this.states.find((s) => s.id === issue.stateId),
      // Linear lists an issue's history newest first.
      history: { nodes: [...issue.history].reverse() },
    };
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const auth = request.headers.authorization;
    if (request.method !== 'POST' || request.url !== '/graphql') return send(404, {});
    const { query, variables, operationName } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables: Record<string, unknown>; operationName: string };
    this.operations.push({ name: operationName, auth });
    const viewer = auth ? this.#accounts.get(auth) : undefined;
    if (!viewer) return send(401, { errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
    const asks = ASKS[operationName];
    if (!asks || !query.includes(operationName)) return send(400, { errors: [{ message: `Unknown operation ${operationName}` }] });
    for (const field of asks) if (!new RegExp(`\\b${field}\\b`).test(query)) return send(400, { errors: [{ message: `${operationName} does not ask for ${field}` }] });
    const by: FakeLinearActor = { user: viewer };
    if (operationName === 'MirrorSetup') {
      const teams = variables.key === this.team.key ? [{ ...this.team, states: { nodes: this.states } }] : [];
      return send(200, { data: { viewer: { id: viewer.id }, teams: { nodes: teams } } });
    }
    if (operationName === 'MirrorIssues') {
      const filter = variables.filter as { team: { id: { eq: string } }; updatedAt: { gte: string } };
      const all = [...this.issues.values()]
        .filter((i) => i.teamId === filter.team.id.eq && i.updatedAt >= filter.updatedAt.gte)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      const start = variables.after ? Number(variables.after) : 0;
      const first = Number(variables.first);
      const page = all.slice(start, start + first);
      const end = start + page.length;
      return send(200, { data: { issues: { nodes: page.map((i) => this.#view(i)), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } });
    }
    if (operationName === 'MirrorCreate') {
      const input = variables.input as { teamId: string; title: string; description: string; stateId: string };
      const state = this.states.find((s) => s.id === input.stateId);
      if (input.teamId !== this.team.id || !state) return send(200, { errors: [{ message: 'Entity not found' }] });
      const issue = this.create(by, { title: input.title, description: input.description, state: state.name });
      issue.history.push(this.#entry(by, state));
      return send(200, { data: { issueCreate: { success: true, issue: this.#view(issue) } } });
    }
    if (operationName === 'MirrorMove') {
      const issue = this.issues.get(String(variables.id));
      const state = this.states.find((s) => s.id === (variables.input as { stateId: string }).stateId);
      if (!issue || !state) return send(200, { errors: [{ message: 'Entity not found' }] });
      this.move(issue.id, by, state.name);
      return send(200, { data: { issueUpdate: { success: true } } });
    }
    const input = variables.input as { issueId: string; body: string };
    const issue = this.issues.get(input.issueId);
    if (!issue) return send(200, { errors: [{ message: 'Entity not found' }] });
    issue.comments.push({ body: input.body, by: viewer.id });
    return send(200, { data: { commentCreate: { success: true } } });
  }
}
