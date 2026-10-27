import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCH_HOME } from '../../conf.ts';
import { createHash } from 'node:crypto';
import { checkedImage } from '../images.ts';
import { GithubAppTokens } from './github-auth.ts';
import { captureUrl } from './capture-hosts.ts';
import type { ConfSections, Section } from '../../conf.ts';
import type { ActionAuthor, Identity, LabelActors, NewTicket, StatusChange, Ticket, TicketChange, TicketComment } from '../contract.ts';

export type GithubApi = (path: string, method?: string, input?: unknown) => unknown;
export type TokenSource = { get(): string };
export type GithubTrackerOptions = { conf?: ConfSections; api?: GithubApi; tokens?: TokenSource | null };
type GithubSettings = Section & { repository: string; owner_id: string; app_login: string };
type GithubActor = { __typename?: string; type?: string; login?: string; id?: string } | null | undefined;
type GithubIssue = {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  labels: (string | { name: string })[];
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: GithubActor;
  pull_request?: unknown;
  performed_via_github_app?: unknown;
};
type GithubComment = { id: number; body: string; created_at: string; updated_at: string; html_url: string; user?: GithubActor };
type TimelineEvent = { event: string; label?: { name?: string }; created_at: string; actor?: GithubActor; performed_via_github_app?: unknown };
type Page<T> = { nodes: T[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
type ProjectItem = { status: string; updatedAt: string };
type ProjectStatus = { item: string; status: string | undefined };
type StatusField = { name?: string } | null | undefined;
type ProjectV2Item = { updatedAt: string; content?: { number: number; repository?: { nameWithOwner?: string } } | null; fieldValueByName?: StatusField };
type StatusChangedEvent = { status: string; createdAt: string; actor?: GithubActor; project?: { id: string } | null; wasAutomated: boolean };
type TrackedIssue = Ticket & { firstVisibleAt: string; agent: boolean };

const time = (): string => new Date().toISOString();
class UnclassifiedIssueError extends Error {}
const botLogin = (login: string | undefined, configured: string): boolean => login === configured || `${login}[bot]` === configured || login === `${configured}[bot]`;
const asNumber = (id: string | number): number => {
  const match = /^(?:GH-)?([1-9][0-9]*)$/.exec(String(id));
  if (!match) throw new Error(`Invalid issue identifier: ${id}`);
  return Number(match[1]);
};
const guard = (text: string): void => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-tracker-guard-'));
  try {
    const file = join(dir, 'outbound.txt');
    writeFileSync(file, text);
    execFileSync(join(ORCH_HOME, 'lib/tracker/guard.ts'), [file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

export class GithubTracker {
  declare conf: ConfSections | undefined;
  declare settings: GithubSettings;
  declare repo: string;
  declare tokens: TokenSource | null;
  declare api: GithubApi;
  constructor({ conf, api, tokens }: GithubTrackerOptions = {}) {
    this.conf = conf;
    // The checks below throw unless repository, owner_id and app_login are set.
    this.settings = (conf?.sections?.tracker || {}) as GithubSettings;
    this.repo = this.settings.repository;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo || '')) throw new Error('Missing or invalid [tracker] repository');
    if (!this.settings.owner_id || !this.settings.app_login || this.settings.owner_id === this.settings.app_login)
      throw new Error('GitHub tracking requires distinct [tracker] owner_id and app_login');
    this.tokens = tokens || (api ? null : new GithubAppTokens(this.settings));
    this.api = api || ((path: string, method = 'GET', input?: unknown): unknown => {
      const token = this.tokens!.get();
      const paged = method === 'GET' && path.includes('per_page=100');
      const args = ['api', '--method', method, path];
      if (paged) args.push('--paginate', '--slurp');
      if (input !== undefined) args.push('--input', '-');
      const answer = execFileSync('gh', args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } });
      if (!answer.trim()) return {};
      const result = JSON.parse(answer) as unknown;
      return paged ? (result as unknown[]).flat() : result;
    });
  }
  rest<T>(path: string, method = 'GET', body?: unknown): T { return this.api(`/repos/${this.repo}${path}`, method, body) as T; }
  downloadCapture(input: string): Buffer {
    const url = captureUrl('github', input);
    const match = /^\/([^/]+)\/([^/]+)\/([a-f0-9]{40})\/(captures\/[A-Za-z0-9/._-]+)$/.exec(url.pathname);
    if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== this.repo.toLowerCase() || url.search || url.hash)
      throw new Error('Capture is outside the configured repository');
    if (!this.tokens) throw new Error('GitHub capture requires an installation token');
    const token = this.tokens.get();
    return execFileSync('gh', ['api', `/repos/${this.repo}/contents/${match[4]}?ref=${match[3]}`,
      '-H', 'Accept: application/vnd.github.raw+json'], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }, timeout: 15000, maxBuffer: 5_100_000,
    });
  }
  graphql<T>(query: string, variables: Record<string, unknown>): T {
    const answer = this.api('graphql', 'POST', { query, variables }) as { errors?: { message: string }[]; data?: unknown };
    if (answer.errors?.length) throw new Error(answer.errors[0]!.message);
    return answer.data as T;
  }
  whoAmI(): Identity {
    try {
      const installation = this.api('/installation/repositories') as { repositories?: unknown } | null;
      if (Array.isArray(installation?.repositories)) return { kind: 'agents', id: this.settings.app_login };
      if (this.tokens) throw new Error('GitHub App installation identity could not be verified');
    } catch (error) {
      if (this.tokens) throw error;
      // Injected API clients in adapter tests may represent a human account.
    }
    const user = this.api('/user') as { login: string };
    return { kind: user.login === this.settings.owner_id ? 'human' : 'shared', id: user.login };
  }
  statusLabel(issue: GithubIssue): string {
    const labels = issue.labels.map((label) => typeof label === 'string' ? label : label.name);
    const statuses = labels.filter((label) => label.startsWith('status:'));
    if (statuses.length !== 1) throw new UnclassifiedIssueError(`Issue #${issue.number} must have exactly one status label`);
    return statuses[0]!.slice(7);
  }
  projectStatus(number: number): ProjectStatus {
    const projectId = this.settings.project_v2_id;
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){projectItems(first:100){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`;
    const [owner, repo] = this.repo.split('/');
    const nodes = this.graphql<{ repository: { issue: { projectItems: Page<{ id: string; project: { id: string }; fieldValueByName?: StatusField }> } } }>(query, { owner, repo, number }).repository.issue.projectItems.nodes;
    const item = nodes.find((node) => node.project.id === projectId);
    if (!item) throw new UnclassifiedIssueError(`Issue #${number} is not in the configured project`);
    return { item: item.id, status: item.fieldValueByName?.name };
  }
  projectItems(): Map<number, ProjectItem> {
    const query = 'query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){nodes{updatedAt content{... on Issue{number repository{nameWithOwner}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage endCursor}}}}}';
    const items = new Map<number, ProjectItem>();
    let cursor: string | null = null;
    do {
      const page: Page<ProjectV2Item> | undefined = this.graphql<{ node?: { items?: Page<ProjectV2Item> } | null }>(query, { id: this.settings.project_v2_id, cursor }).node?.items;
      if (!page) throw new Error('The configured GitHub Project could not be read');
      for (const item of page.nodes) {
        if (item.content?.repository?.nameWithOwner?.toLowerCase() !== this.repo.toLowerCase()) continue;
        if (!item.fieldValueByName?.name) {
          console.error(`tracker: skipping issue #${item.content!.number}: no project status`);
          continue;
        }
        items.set(item.content!.number, { status: item.fieldValueByName.name, updatedAt: item.updatedAt });
      }
      if (!page.pageInfo?.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error('Project item cursor did not advance');
      cursor = page.pageInfo.endCursor;
    } while (true);
    return items;
  }
  normalize(issue: GithubIssue, projectItem?: ProjectItem | null): Ticket {
    // A project item without a status gives an undefined status, as before.
    const status = (this.settings.project_v2_id ? (projectItem || this.projectStatus(issue.number)).status : this.statusLabel(issue)) as string;
    return { id: String(issue.number), identifier: `GH-${issue.number}`, title: issue.title,
      description: issue.body || '', body: issue.body || '', labels: issue.labels.map((label) => typeof label === 'string' ? label : label.name),
      project: this.repo, state: status, status, url: issue.html_url,
      createdAt: issue.created_at, updatedAt: projectItem && projectItem.updatedAt > issue.updated_at ? projectItem.updatedAt : issue.updated_at };
  }
  getTicket(id: string | number): Ticket { return this.normalize(this.rest<GithubIssue>(`/issues/${asNumber(id)}`)); }
  trackedIssues(issues: GithubIssue[], projectItems: Map<number, ProjectItem> | null): TrackedIssue[] {
    return issues.filter((issue) => !issue.pull_request).flatMap((issue): TrackedIssue[] => {
      if (projectItems && !projectItems.has(issue.number)) return [];
      try { return [{ ...this.normalize(issue, projectItems?.get(issue.number)),
        firstVisibleAt: projectItems?.get(issue.number)?.updatedAt || issue.updated_at,
        agent: issue.user?.type === 'Bot' && botLogin(issue.user.login, this.settings.app_login) }]; }
      catch (error) {
        if (!(error instanceof UnclassifiedIssueError)) throw error;
        console.error(`tracker: skipping issue #${issue.number}: ${error.message}`);
        return [];
      }
    });
  }
  listTickets({ status }: { status?: string } = {}): TrackedIssue[] {
    const issues = this.rest<GithubIssue[]>('/issues?state=all&per_page=100');
    return this.trackedIssues(issues, this.settings.project_v2_id ? this.projectItems() : null)
      .filter((issue) => !status || issue.status === status);
  }
  createTicket({ title, body = '', labels = [] }: NewTicket): Ticket {
    if (this.whoAmI().kind !== 'agents') throw new Error('Agent ticket creation requires a GitHub App installation token');
    guard([title, body, ...labels].join('\n'));
    const status = this.settings.todo_state;
    if (!status) throw new Error('Missing required [tracker] todo_state');
    const issue = this.rest<GithubIssue>('/issues', 'POST', { title, body, labels: this.settings.project_v2_id ? labels : [...labels, `status:${status}`] });
    if (this.settings.project_v2_id) {
      const q = 'mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}';
      this.graphql(q, { project: this.settings.project_v2_id, content: issue.node_id });
      this.moveTicket(issue.number, status);
    }
    return this.getTicket(issue.number);
  }
  moveTicket(id: string | number, status: string): Ticket {
    const actor = this.whoAmI();
    const statuses = ['todo_state', 'progress_state', 'review_state', 'validate_state', 'go_state', 'done_state']
      .map((key) => this.settings[key]).filter(Boolean);
    if (!statuses.includes(status)) throw new Error(`Unknown configured ticket status: ${status}`);
    if (status === this.settings.go_state && actor.kind !== 'human') throw new Error('Only the configured human account can approve a ticket');
    const number = asNumber(id);
    if (this.settings.project_v2_id) {
      const { item } = this.projectStatus(number);
      const q = 'query($id:ID!){node(id:$id){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}';
      const field = this.graphql<{ node: { field: { id: string; options: { id: string; name: string }[] } } }>(q, { id: this.settings.project_v2_id }).node.field;
      const option = field.options.find((entry) => entry.name === status);
      if (!option) throw new Error(`Unknown project status: ${status}`);
      const mutation = 'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}';
      this.graphql(mutation, { project: this.settings.project_v2_id, item, field: field.id, option: option.id });
    } else {
      const issue = this.rest<{ labels: { name: string }[] }>(`/issues/${number}`);
      const labels = issue.labels.map((label) => label.name);
      const next = `status:${status}`;
      const prior = labels.filter((label) => label.startsWith('status:'));
      if (prior.length === 1 && prior[0] === next) return this.getTicket(number);
      const removed: string[] = [];
      for (const old of prior) {
        this.rest(`/issues/${number}/labels/${encodeURIComponent(old)}`, 'DELETE');
        removed.push(old);
      }
      try { this.rest(`/issues/${number}/labels`, 'POST', { labels: [next] }); }
      catch (error) {
        // Preserve the previous status if the replacement fails. Unrelated
        // labels are never replaced, including labels added concurrently.
        for (const old of removed) {
          try { this.rest(`/issues/${number}/labels`, 'POST', { labels: [old] }); }
          catch { /* The original failure still needs to be reported. */ }
        }
        throw error;
      }
    }
    return this.getTicket(number);
  }
  actorOf(actor: GithubActor, automated = false): ActionAuthor {
    const kind = actor?.__typename || actor?.type;
    const app = this.settings.app_login;
    const agent = kind === 'Bot' && botLogin(actor!.login, app);
    return { kind: agent ? 'agents' : !automated && kind === 'User' && actor?.login === this.settings.owner_id ? 'human' : 'other',
      id: agent ? app : actor?.login || actor?.id || 'unknown' };
  }
  // Who set each label: the actor of its last "labeled" event (one done
  // through an app is never the user's); the project is the repository, so
  // its setter is whoever opened the issue. The timeline is read whole (every
  // page); one that cannot be read says nothing.
  labelActors(id: string | number): LabelActors {
    const number = asNumber(id);
    const issue = this.rest<GithubIssue>(`/issues/${number}`);
    const events = this.rest<TimelineEvent[]>(`/issues/${number}/timeline?per_page=100`);
    if (!Array.isArray(events)) throw new Error('the timeline of the issue cannot be read');
    const labels: Record<string, ActionAuthor> = {};
    for (const label of issue.labels.map((entry) => (typeof entry === 'string' ? entry : entry.name))) {
      const last = events.filter((event) => event.event === 'labeled' && event.label?.name === label)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1);
      labels[label] = last ? this.actorOf(last.actor, Boolean(last.performed_via_github_app)) : { kind: 'other', id: 'unknown' };
    }
    return { labels, project: this.actorOf(issue.user, Boolean(issue.performed_via_github_app)) };
  }
  history(id: string | number): StatusChange[] {
    const number = asNumber(id);
    const by = (actor: GithubActor, automated = false) => this.actorOf(actor, automated);
    if (this.settings.project_v2_id) {
      const [account, repo] = this.repo.split('/');
      const q = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){issue(number:$number){timelineItems(first:100,after:$cursor,itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){nodes{... on ProjectV2ItemStatusChangedEvent{status createdAt actor{__typename login ... on User{id} ... on Bot{id}} project{id} wasAutomated}} pageInfo{hasNextPage endCursor}}}}}`;
      const nodes: StatusChangedEvent[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<StatusChangedEvent> = this.graphql<{ repository: { issue: { timelineItems: Page<StatusChangedEvent> } } }>(q, { owner: account, repo, number, cursor }).repository.issue.timelineItems;
        nodes.push(...page.nodes);
        if (!page.pageInfo?.hasNextPage) break;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error('Project status history cursor did not advance');
        cursor = page.pageInfo.endCursor;
      } while (true);
      return nodes.filter((event) => event.project?.id === this.settings.project_v2_id)
        .map((event) => ({ status: event.status, by: by(event.actor, event.wasAutomated), at: event.createdAt }));
    }
    const events = this.rest<TimelineEvent[]>(`/issues/${number}/timeline?per_page=100`);
    return events.filter((event) => event.event === 'labeled' && event.label?.name?.startsWith('status:'))
      .map((event) => ({ status: event.label!.name!.slice(7), by: by(event.actor), at: event.created_at }));
  }
  comments(id: string | number, { since }: { since?: string } = {}): TicketComment[] {
    return this.rest<GithubComment[]>(`/issues/${asNumber(id)}/comments?per_page=100`).filter((comment) => !since || comment.created_at > since || comment.updated_at > since)
      .map((comment) => {
        const agent = comment.user?.type === 'Bot' && botLogin(comment.user.login, this.settings.app_login);
        // REST does not expose the editor. A changed human comment cannot be
        // treated as an authenticated instruction, even if the author is right.
        const human = comment.user?.login === this.settings.owner_id && comment.user?.type === 'User'
          && comment.updated_at === comment.created_at;
        return { id: String(comment.id), body: comment.body, createdAt: comment.created_at,
          editedAt: comment.updated_at, url: comment.html_url, agent,
          by: { kind: agent ? 'agents' : human ? 'human' : 'other', id: agent ? this.settings.app_login : comment.user?.login || 'unknown' },
          byOwner: human };
      });
  }
  comment(id: string | number, body: string, { images = [] }: { images?: string[] } = {}): GithubComment {
    if (this.whoAmI().kind !== 'agents') throw new Error('Agent comments require a GitHub App installation token');
    guard(body);
    const links = images.map((path) => this.upload(path));
    const final = `${body}${links.map((url) => `\n![capture](${url})`).join('')}`;
    guard(final);
    return this.rest<GithubComment>(`/issues/${asNumber(id)}/comments`, 'POST', { body: final });
  }
  editComment(id: string | number, commentId: string | number, body: string): GithubComment {
    const prior = this.comments(id).find((item) => item.id === String(commentId));
    if (!prior || prior.by.kind !== this.whoAmI().kind || prior.by.id !== this.whoAmI().id) throw new Error('Cannot edit another actor’s comment');
    guard(body);
    return this.rest<GithubComment>(`/issues/comments/${commentId}`, 'PATCH', { body });
  }
  upload(path: string): string {
    if (this.whoAmI().kind !== 'agents') throw new Error('Capture publishing requires a GitHub App installation token');
    const capture = checkedImage(path, this.settings.capture_roots);
    let ocr: string;
    const scanDir = mkdtempSync(join(tmpdir(), 'cleared-capture-scan-'));
    try {
      const scanFile = join(scanDir, `capture.${capture.extension}`);
      writeFileSync(scanFile, capture.bytes, { mode: 0o600 });
      ocr = execFileSync('tesseract', [scanFile, 'stdout'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 });
    }
    catch { throw new Error('Capture could not be read by OCR; nothing published'); }
    finally { rmSync(scanDir, { recursive: true, force: true }); }
    if (!ocr.trim()) throw new Error('Capture has no readable text for the guard; nothing published');
    guard(ocr);
    const digest = createHash('sha256').update(capture.bytes).digest('hex');
    const branch = this.settings.capture_branch || 'cleared-captures';
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw new Error('Invalid [tracker] capture_branch');
    const name = `captures/${digest.slice(0, 2)}/${digest}.${capture.extension}`;
    const ref = `/git/ref/heads/${branch}`;
    let current: string;
    try { current = this.rest<{ object: { sha: string } }>(ref).object.sha; }
    catch {
      const base = this.settings.capture_base || 'main';
      const start = this.rest<{ object: { sha: string } }>(`/git/ref/heads/${base}`).object.sha;
      this.rest('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: start });
      current = start;
    }
    const blob = this.rest<{ sha: string }>('/git/blobs', 'POST', { content: capture.bytes.toString('base64'), encoding: 'base64' }).sha;
    for (let attempt = 0; attempt < 3; attempt++) {
      const commit = this.rest<{ tree: { sha: string } }>(`/git/commits/${current}`);
      const tree = this.rest<{ sha: string }>('/git/trees', 'POST', { base_tree: commit.tree.sha,
        tree: [{ path: name, mode: '100644', type: 'blob', sha: blob }] }).sha;
      const next = this.rest<{ sha: string }>('/git/commits', 'POST', { message: 'chore: add ticket capture', tree, parents: [current] }).sha;
      try {
        this.rest(`/git/refs/heads/${branch}`, 'PATCH', { sha: next, force: false });
        return `https://github.com/${this.repo}/raw/${next}/${name}`;
      } catch (error) {
        if (attempt === 2) throw error;
        current = this.rest<{ object: { sha: string } }>(ref).object.sha;
      }
    }
    throw new Error('Capture could not be published');
  }
  changesSince(cursor?: string): { events: TicketChange[]; cursor: string } {
    const readAt = time();
    const since = cursor || '1970-01-01T00:00:00Z';
    const candidates = new Map(this.rest<GithubIssue[]>(`/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`)
      .filter((issue) => !issue.pull_request).map((issue): [number, GithubIssue] => [issue.number, issue]));
    const projectItems = this.settings.project_v2_id ? this.projectItems() : null;
    for (const [number, item] of projectItems || []) {
      if (item.updatedAt > since && !candidates.has(number)) candidates.set(number, this.rest<GithubIssue>(`/issues/${number}`));
    }
    const issues = this.trackedIssues([...candidates.values()], projectItems);
    return { events: issues.map((issue) => ({ ...issue,
      comments: this.comments(issue.id) })), cursor: readAt };
  }
}
