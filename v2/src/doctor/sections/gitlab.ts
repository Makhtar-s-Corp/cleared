// The gitlab section (docs/v2/milestone-5-plan.md, section 11): run only
// when named (`node scripts/doctor.ts gitlab`, `cleared doctor gitlab`), as
// mirror, and read only: GET /user, the token's own page and each GitLab
// service's project, nothing written. It says, in this order: the address
// (CLEARED_V2_GITLAB_URL, gitlab.com by default); the token's file
// (CLEARED_V2_GITLAB_TOKEN_FILE), looked at as the adapter reads it, never
// printed; whether GitLab accepts the token and as whom (401, 403 and no
// answer in time said apart); whether it has the api scope, which opening
// and merging a merge request need; each GitLab service's project, with the
// role the token holds there (Developer at least). Its words are
// messages/gitlab.<language>.json.
import { lstatSync, type Stats } from 'node:fs';
import { isAbsolute } from 'node:path';
import { checkProject, GitLabClient, GitLabError, gitlabAddress, GITLAB_TIMEOUT_MS, projectSegment, readGitLabToken } from '../../../../lib/gitlab.ts';
import type { Language } from '../../../app/src/catalog.ts';
import { lasted } from '../../../app/web/lib/time.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../../flow/config.ts';
import { forgeKindOf } from '../../forge/index.ts';
import { GITLAB_TOKEN_FILE, GITLAB_URL } from '../../forge/gitlab.ts';
import type { WorkspaceConfig } from '../../workspace/config.ts';
import { doctorTranslator, type DoctorLevel, type DoctorLine, type DoctorSection } from '../section.ts';

export { GITLAB_TIMEOUT_MS };

type Check = 'gitlab_address' | 'gitlab_file' | 'gitlab_account' | 'gitlab_scope' | 'gitlab_project';

// GitLab's roles, by the access level its API gives.
const ROLES: readonly [number, string][] = [[50, 'owner'], [40, 'maintainer'], [30, 'developer'], [20, 'reporter'], [15, 'planner'], [10, 'guest'], [5, 'minimal']];
const DEVELOPER = 30;

const roleOf = (level: number): string => ROLES.find(([at]) => level >= at)?.[1] ?? 'none';
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);

// What is wrong with the token's file, as the adapter would refuse it; undefined when it reads.
function fileProblem(file: string): { key: string; mode?: string } | undefined {
  if (!isAbsolute(file)) return { key: 'file_relative' };
  let stats: Stats;
  try { stats = lstatSync(file); } catch { return { key: 'file_missing' }; }
  if (stats.isSymbolicLink()) return { key: 'file_link' };
  if (!stats.isFile()) return { key: 'file_not_file' };
  if (stats.uid !== process.getuid?.()) return { key: 'file_owner' };
  if ((stats.mode & 0o077) !== 0) return { key: 'file_open', mode: (stats.mode & 0o777).toString(8) };
  try { readGitLabToken(file, GITLAB_TOKEN_FILE); } catch { return { key: 'file_unreadable' }; }
  return undefined;
}

export async function gitlabChecks(input: { readonly env: NodeJS.ProcessEnv; readonly language: Language; readonly fetch?: typeof fetch }): Promise<DoctorLine[]> {
  const { env } = input;
  const t = doctorTranslator('gitlab', input.language);
  const lines: DoctorLine[] = [];
  const say = (id: Check, level: DoctorLevel, key: string, values: Record<string, string | number> = {}, todo?: string) =>
    lines.push({ id, level, text: t(key, values), ...(todo ? { todo: t(todo, values) } : {}) });

  const file = env[GITLAB_TOKEN_FILE]?.trim();
  if (!file) {
    say('gitlab_file', 'notice', 'none', {}, 'none_todo');
    return lines;
  }

  let address: string | undefined;
  try {
    address = gitlabAddress(env[GITLAB_URL]);
    say('gitlab_address', 'ok', 'address_ok', { address });
  } catch {
    say('gitlab_address', 'fail', 'address_fail', { given: String(env[GITLAB_URL]).slice(0, 200) }, 'address_todo');
  }

  const problem = fileProblem(file);
  if (problem) say('gitlab_file', 'fail', problem.key, { path: file, mode: problem.mode ?? '' }, 'file_todo');
  else say('gitlab_file', 'ok', 'file_ok', { path: file });

  const limit = lasted(GITLAB_TIMEOUT_MS, t);
  let client: GitLabClient | undefined;
  if (address === undefined || problem) say('gitlab_account', 'off', 'after_settings');
  else {
    client = new GitLabClient({ address, token: readGitLabToken(file, GITLAB_TOKEN_FILE), ...(input.fetch ? { fetch: input.fetch } : {}) });
    try {
      const user = (await client.call('GET', '/user')).value as { username?: unknown } | null;
      say('gitlab_account', 'ok', 'account_ok', { address, name: String(user?.username ?? '?') });
    } catch (error) {
      const status = error instanceof GitLabError ? error.status : undefined;
      const values = { address, status: status ?? 0, limit };
      if (status === undefined) say('gitlab_account', 'fail', 'account_unreachable', values, 'account_unreachable_todo');
      else if (status === 401) say('gitlab_account', 'fail', 'account_refused', values, 'account_refused_todo');
      else if (status === 403) say('gitlab_account', 'fail', 'account_forbidden', values, 'account_forbidden_todo');
      else say('gitlab_account', 'fail', 'account_status', values, 'account_status_todo');
      client = undefined;
    }
  }

  if (!client) say('gitlab_scope', 'off', 'after_account');
  else {
    try {
      const self = (await client.call('GET', '/personal_access_tokens/self')).value as { scopes?: unknown } | null;
      const scopes = Array.isArray(self?.scopes) ? self.scopes.map(String) : [];
      if (scopes.includes('api')) say('gitlab_scope', 'ok', 'scope_ok');
      else say('gitlab_scope', 'fail', 'scope_missing', { scopes: scopes.join(', ') || '-' }, 'scope_todo');
    } catch (error) {
      say('gitlab_scope', 'notice', 'scope_unsaid', { reason: reasonOf(error) });
    }
  }

  // Each GitLab service of the workspace, read as the service reads it.
  let workspace: WorkspaceConfig | undefined;
  let refused: string | undefined;
  try {
    const flow = loadFlowConfig(env);
    workspace = flow ? workspaceOf(flow) : undefined;
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    refused = reasonOf(error);
  }
  const projects = [...new Set((workspace?.services ?? []).filter((service) => forgeKindOf(service) === 'gitlab').map((service) => service.repo))];
  if (refused !== undefined) say('gitlab_project', 'fail', 'workspace_refused', { reason: refused }, 'workspace_refused_todo');
  else if (projects.length === 0) say('gitlab_project', 'notice', 'projects_none', {}, 'projects_none_todo');
  else if (!client) say('gitlab_project', 'off', 'after_account');
  else {
    for (const project of projects) {
      try {
        checkProject(project);
        const seen = (await client.call('GET', `/projects/${projectSegment(project)}`)).value as { permissions?: { project_access?: { access_level?: unknown } | null; group_access?: { access_level?: unknown } | null } } | null;
        const level = Math.max(Number(seen?.permissions?.project_access?.access_level ?? 0), Number(seen?.permissions?.group_access?.access_level ?? 0));
        const values = { project, role: t(`role_${roleOf(level)}`) };
        if (level >= DEVELOPER) say('gitlab_project', 'ok', 'project_ok', values);
        else say('gitlab_project', 'fail', 'project_role', values, 'project_role_todo');
      } catch (error) {
        const status = error instanceof GitLabError ? error.status : undefined;
        const values = { project, address: client.address, status: status ?? 0, limit };
        if (status === 404) say('gitlab_project', 'fail', 'project_missing', values, 'project_missing_todo');
        else if (status === undefined) say('gitlab_project', 'fail', 'project_unreachable', values, 'account_unreachable_todo');
        else say('gitlab_project', 'fail', 'project_status', values, 'project_missing_todo');
      }
    }
  }
  return lines;
}

const gitlab: DoctorSection = {
  name: 'gitlab',
  byDefault: false,
  title: (language) => doctorTranslator('gitlab', language)('section_title'),
  run: (env, language) => gitlabChecks({ env, language }),
};

export default gitlab;
