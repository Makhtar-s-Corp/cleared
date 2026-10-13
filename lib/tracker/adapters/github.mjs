import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCH_HOME } from '../../conf.mjs';
import { createHash } from 'node:crypto';
import { checkedImage } from '../images.mjs';
import { GithubAppTokens } from './github-auth.mjs';
import { captureUrl } from './capture-hosts.mjs';

const time = () => new Date().toISOString();
class UnclassifiedIssueError extends Error {}
const botLogin = (login, configured) => login === configured || `${login}[bot]` === configured || login === `${configured}[bot]`;
const asNumber = (id) => {
  const match = /^(?:GH-)?([1-9][0-9]*)$/.exec(String(id));
  if (!match) throw new Error(`Invalid issue identifier: ${id}`);
  return Number(match[1]);
};
const guard = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-tracker-guard-'));
  try {
    const file = join(dir, 'outbound.txt');
    writeFileSync(file, text);
    execFileSync(join(ORCH_HOME, 'lib/tracker/guard.sh'), [file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

export class GithubTracker {
  constructor({ conf, api, tokens } = {}) {
    this.conf = conf;
    this.settings = conf?.sections?.tracker || {};
    this.repo = this.settings.repository;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo || '')) throw new Error('Missing or invalid [tracker] repository');
    if (!this.settings.owner_id || !this.settings.app_login || this.settings.owner_id === this.settings.app_login)
      throw new Error('GitHub tracking requires distinct [tracker] owner_id and app_login');
    this.tokens = tokens || (api ? null : new GithubAppTokens(this.settings));
    this.api = api || ((path, method = 'GET', input) => {
      const token = this.tokens.get();
      const paged = method === 'GET' && path.includes('per_page=100');
      const args = ['api', '--method', method, path];
      if (paged) args.push('--paginate', '--slurp');
      if (input !== undefined) args.push('--input', '-');
      const answer = execFileSync('gh', args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } });
      if (!answer.trim()) return {};
      const result = JSON.parse(answer);
      return paged ? result.flat() : result;
    });
  }
  rest(path, method = 'GET', body) { return this.api(`/repos/${this.repo}${path}`, method, body); }
  downloadCapture(input) {
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
  graphql(query, variables) {
    const answer = this.api('graphql', 'POST', { query, variables });
    if (answer.errors?.length) throw new Error(answer.errors[0].message);
    return answer.data;
  }
  whoAmI() {
    try {
      const installation = this.api('/installation/repositories');
      if (Array.isArray(installation?.repositories)) return { kind: 'agents', id: this.settings.app_login };
      if (this.tokens) throw new Error('GitHub App installation identity could not be verified');
    } catch (error) {
      if (this.tokens) throw error;
      // Injected API clients in adapter tests may represent a human account.
    }
    const user = this.api('/user');
    return { kind: user.login === this.settings.owner_id ? 'human' : 'shared', id: user.login };
  }
  statusLabel(issue) {
    const labels = issue.labels.map((label) => typeof label === 'string' ? label : label.name);
    const statuses = labels.filter((label) => label.startsWith('status:'));
    if (statuses.length !== 1) throw new UnclassifiedIssueError(`Issue #${issue.number} must have exactly one status label`);
    return statuses[0].slice(7);
  }
  projectStatus(number) {
    const projectId = this.settings.project_v2_id;
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){projectItems(first:100){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`;
    const [owner, repo] = this.repo.split('/');
    const nodes = this.graphql(query, { owner, repo, number }).repository.issue.projectItems.nodes;
    const item = nodes.find((node) => node.project.id === projectId);
    if (!item) throw new UnclassifiedIssueError(`Issue #${number} is not in the configured project`);
    return { item: item.id, status: item.fieldValueByName?.name };
  }
  projectItems() {
    const query = 'query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){nodes{updatedAt content{... on Issue{number repository{nameWithOwner}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage endCursor}}}}}';
    const items = new Map();
    let cursor = null;
    do {
      const page = this.graphql(query, { id: this.settings.project_v2_id, cursor }).node?.items;
      if (!page) throw new Error('The configured GitHub Project could not be read');
      for (const item of page.nodes) {
        if (item.content?.repository?.nameWithOwner?.toLowerCase() !== this.repo.toLowerCase()) continue;
        if (!item.fieldValueByName?.name) {
          console.error(`tracker: skipping issue #${item.content.number}: no project status`);
          continue;
        }
        items.set(item.content.number, { status: item.fieldValueByName.name, updatedAt: item.updatedAt });
      }
      if (!page.pageInfo?.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error('Project item cursor did not advance');
      cursor = page.pageInfo.endCursor;
    } while (true);
    return items;
  }
  normalize(issue, projectItem) {
    const status = this.settings.project_v2_id ? (projectItem || this.projectStatus(issue.number)).status : this.statusLabel(issue);
    return { id: String(issue.number), identifier: `GH-${issue.number}`, title: issue.title,
      description: issue.body || '', body: issue.body || '', labels: issue.labels.map((label) => typeof label === 'string' ? label : label.name),
      project: this.repo, state: status, status, url: issue.html_url,
      createdAt: issue.created_at, updatedAt: projectItem && projectItem.updatedAt > issue.updated_at ? projectItem.updatedAt : issue.updated_at };
  }
  getTicket(id) { return this.normalize(this.rest(`/issues/${asNumber(id)}`)); }
  trackedIssues(issues, projectItems) {
    return issues.filter((issue) => !issue.pull_request).flatMap((issue) => {
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
  listTickets({ status } = {}) {
    const issues = this.rest('/issues?state=all&per_page=100');
    return this.trackedIssues(issues, this.settings.project_v2_id ? this.projectItems() : null)
      .filter((issue) => !status || issue.status === status);
  }
  createTicket({ title, body = '', labels = [] }) {
    if (this.whoAmI().kind !== 'agents') throw new Error('Agent ticket creation requires a GitHub App installation token');
    guard([title, body, ...labels].join('\n'));
    const status = this.settings.todo_state;
    if (!status) throw new Error('Missing required [tracker] todo_state');
    const issue = this.rest('/issues', 'POST', { title, body, labels: this.settings.project_v2_id ? labels : [...labels, `status:${status}`] });
    if (this.settings.project_v2_id) {
      const q = 'mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}';
      this.graphql(q, { project: this.settings.project_v2_id, content: issue.node_id });
      this.moveTicket(issue.number, status);
    }
    return this.getTicket(issue.number);
  }
  moveTicket(id, status) {
    const actor = this.whoAmI();
    const statuses = ['todo_state', 'progress_state', 'review_state', 'validate_state', 'go_state', 'done_state']
      .map((key) => this.settings[key]).filter(Boolean);
    if (!statuses.includes(status)) throw new Error(`Unknown configured ticket status: ${status}`);
    if (status === this.settings.go_state && actor.kind !== 'human') throw new Error('Only the configured human account can approve a ticket');
    const number = asNumber(id);
    if (this.settings.project_v2_id) {
      const { item } = this.projectStatus(number);
      const q = 'query($id:ID!){node(id:$id){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}';
      const field = this.graphql(q, { id: this.settings.project_v2_id }).node.field;
      const option = field.options.find((entry) => entry.name === status);
      if (!option) throw new Error(`Unknown project status: ${status}`);
      const mutation = 'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}';
      this.graphql(mutation, { project: this.settings.project_v2_id, item, field: field.id, option: option.id });
    } else {
      const issue = this.rest(`/issues/${number}`);
      const labels = issue.labels.map((label) => label.name);
      const next = `status:${status}`;
      const prior = labels.filter((label) => label.startsWith('status:'));
      if (prior.length === 1 && prior[0] === next) return this.getTicket(number);
      const removed = [];
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
  history(id) {
    const number = asNumber(id);
    const owner = this.settings.owner_id;
    const app = this.settings.app_login;
    const by = (actor, automated = false) => {
      const kind = actor?.__typename || actor?.type;
      const agent = kind === 'Bot' && botLogin(actor.login, app);
      return { kind: agent ? 'agents' : !automated && kind === 'User' && actor?.login === owner ? 'human' : 'other',
        id: agent ? app : actor?.login || actor?.id || 'unknown' };
    };
    if (this.settings.project_v2_id) {
      const [account, repo] = this.repo.split('/');
      const q = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){issue(number:$number){timelineItems(first:100,after:$cursor,itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){nodes{... on ProjectV2ItemStatusChangedEvent{status createdAt actor{__typename login ... on User{id} ... on Bot{id}} project{id} wasAutomated}} pageInfo{hasNextPage endCursor}}}}}`;
      const nodes = [];
      let cursor = null;
      do {
        const page = this.graphql(q, { owner: account, repo, number, cursor }).repository.issue.timelineItems;
        nodes.push(...page.nodes);
        if (!page.pageInfo?.hasNextPage) break;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error('Project status history cursor did not advance');
        cursor = page.pageInfo.endCursor;
      } while (true);
      return nodes.filter((event) => event.project?.id === this.settings.project_v2_id)
        .map((event) => ({ status: event.status, by: by(event.actor, event.wasAutomated), at: event.createdAt }));
    }
    const events = this.rest(`/issues/${number}/timeline?per_page=100`);
    return events.filter((event) => event.event === 'labeled' && event.label?.name?.startsWith('status:'))
      .map((event) => ({ status: event.label.name.slice(7), by: by(event.actor), at: event.created_at }));
  }
  comments(id, { since } = {}) {
    return this.rest(`/issues/${asNumber(id)}/comments?per_page=100`).filter((comment) => !since || comment.created_at > since || comment.updated_at > since)
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
  comment(id, body, { images = [] } = {}) {
    if (this.whoAmI().kind !== 'agents') throw new Error('Agent comments require a GitHub App installation token');
    guard(body);
    const links = images.map((path) => this.upload(path));
    const final = `${body}${links.map((url) => `\n![capture](${url})`).join('')}`;
    guard(final);
    return this.rest(`/issues/${asNumber(id)}/comments`, 'POST', { body: final });
  }
  editComment(id, commentId, body) {
    const prior = this.comments(id).find((item) => item.id === String(commentId));
    if (!prior || prior.by.kind !== this.whoAmI().kind || prior.by.id !== this.whoAmI().id) throw new Error('Cannot edit another actor’s comment');
    guard(body);
    return this.rest(`/issues/comments/${commentId}`, 'PATCH', { body });
  }
  upload(path) {
    if (this.whoAmI().kind !== 'agents') throw new Error('Capture publishing requires a GitHub App installation token');
    const capture = checkedImage(path, this.settings.capture_roots);
    let ocr;
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
    let current;
    try { current = this.rest(ref).object.sha; }
    catch {
      const base = this.settings.capture_base || 'main';
      const start = this.rest(`/git/ref/heads/${base}`).object.sha;
      this.rest('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: start });
      current = start;
    }
    const blob = this.rest('/git/blobs', 'POST', { content: capture.bytes.toString('base64'), encoding: 'base64' }).sha;
    for (let attempt = 0; attempt < 3; attempt++) {
      const commit = this.rest(`/git/commits/${current}`);
      const tree = this.rest('/git/trees', 'POST', { base_tree: commit.tree.sha,
        tree: [{ path: name, mode: '100644', type: 'blob', sha: blob }] }).sha;
      const next = this.rest('/git/commits', 'POST', { message: 'chore: add ticket capture', tree, parents: [current] }).sha;
      try {
        this.rest(`/git/refs/heads/${branch}`, 'PATCH', { sha: next, force: false });
        return `https://github.com/${this.repo}/raw/${next}/${name}`;
      } catch (error) {
        if (attempt === 2) throw error;
        current = this.rest(ref).object.sha;
      }
    }
    throw new Error('Capture could not be published');
  }
  changesSince(cursor) {
    const readAt = time();
    const since = cursor || '1970-01-01T00:00:00Z';
    const candidates = new Map(this.rest(`/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`)
      .filter((issue) => !issue.pull_request).map((issue) => [issue.number, issue]));
    const projectItems = this.settings.project_v2_id ? this.projectItems() : null;
    for (const [number, item] of projectItems || []) {
      if (item.updatedAt > since && !candidates.has(number)) candidates.set(number, this.rest(`/issues/${number}`));
    }
    const issues = this.trackedIssues([...candidates.values()], projectItems);
    return { events: issues.map((issue) => ({ ...issue,
      comments: this.comments(issue.id) })), cursor: readAt };
  }
}
