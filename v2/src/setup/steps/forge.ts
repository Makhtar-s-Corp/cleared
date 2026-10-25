// The assistant's forge step (docs/v2/milestone-5-plan.md, sections 5.2 and
// 11): GitHub or GitLab, the credential checked on the spot.
//
// GitHub: the repositories the credential reaches (GET /user/repos, one page
// of 100), read here, so that 401 and 403 are told apart without gh. A
// credential GitHub accepts and that reaches a repository is written to
// <state>/forge-github.token (mode 600), named in the settings as GH_TOKEN's
// file, which gh reads, and set in this process at once.
//
// GitLab: an address (gitlab.com by default; https, or http on loopback for
// a test) and a token, checked through the forge contract (the GitLab
// adapter's listing of the token's projects) and the token's own page, whose
// scopes must hold api (an older GitLab without that page is checked by the
// listing alone). A token GitLab accepts is written to
// <state>/forge-gitlab.token (mode 600); the settings name the file
// (CLEARED_V2_GITLAB_TOKEN_FILE) and the address (CLEARED_V2_GITLAB_URL),
// which the adapter reads, and both are set in this process at once.
//
// The value travels in a header only; no answer, no line of the settings and
// no log holds it.
//
//   GET  /api/setup/forge   -> ForgeView
//   POST /api/setup/forge   { forge?: github | gitlab, value, address? } -> ForgeChecked,
//        or 400 { error }: invalid, address, refused (401), forbidden (403),
//        scope, unreachable, empty; 409 { error: environment } when the
//        environment gives GH_TOKEN, or CLEARED_V2_GITLAB_TOKEN_FILE for GitLab
import { join } from 'node:path';
import { GITLAB_COM, GitLabClient, GitLabError } from '../../../../lib/gitlab.ts';
import { ForgeError } from '../../forge/contract.ts';
import { GITLAB_FILE_SETTING, GITLAB_URL, GitLabForge, gitlabAddress } from '../../forge/gitlab.ts';
import { readCredential, readSettings, settingsPath, stateFolder, writeCredential, writeSettings } from '../settings.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';
import { FORGE_RIGHTS, type CredentialView, type ForgeChecked, type ForgeView, type GitLabView } from '../types.ts';

export const FORGE_FILE = 'forge-github.token';
export const GITLAB_FILE = 'forge-gitlab.token';
const MAX_LISTED = 1000;                 // the adapter's listing stops there
const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
const TIMEOUT_MS = 15_000;
const SAMPLE = 5;

export { FORGE_RIGHTS };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// GitHub's API, or one on loopback for a test (CLEARED_V2_FORGE_GITHUB_API).
export function forgeApi(env: NodeJS.ProcessEnv): string {
  const given = env.CLEARED_V2_FORGE_GITHUB_API;
  if (!given) return GITHUB_API;
  let url: URL;
  try { url = new URL(given); } catch { throw new Error('CLEARED_V2_FORGE_GITHUB_API is not an address'); }
  const base = given.replace(/\/+$/, '');
  if (base === GITHUB_API) return base;
  if (!(url.protocol === 'http:' || url.protocol === 'https:') || !LOOPBACK.has(url.hostname)) throw new Error('CLEARED_V2_FORGE_GITHUB_API is GitHub\'s API or an address on loopback');
  return base;
}

const ENVIRONMENT = ['GH_TOKEN', 'GITHUB_TOKEN'];

function credentialOf(deps: StepDeps): CredentialView {
  if (ENVIRONMENT.some((name) => deps.fromEnvironment.has(name))) return { set: true, at: null, source: 'environment' };
  const path = settingsPath(deps.env);
  const file = path ? readSettings(path).files.GH_TOKEN : undefined;
  if (!file || readCredential(file) === undefined) return { set: false };
  return { set: true, at: deps.records.get('forge')?.doneAt ?? null, source: 'assistant' };
}

// GitLab's token: the file the environment names, or the one the settings name.
function gitlabOf(deps: StepDeps): GitLabView {
  const path = settingsPath(deps.env);
  const settings = path ? readSettings(path).env : {};
  const address = deps.env[GITLAB_URL] || settings[GITLAB_URL] || GITLAB_COM;
  if (deps.fromEnvironment.has(GITLAB_FILE_SETTING)) return { credential: { set: true, at: null, source: 'environment' }, address };
  const file = settings[GITLAB_FILE_SETTING];
  if (!file || readCredential(file) === undefined) return { credential: { set: false }, address };
  return { credential: { set: true, at: deps.records.get('forge')?.doneAt ?? null, source: 'assistant' }, address };
}

type Checked = { readonly ok: true; readonly names: readonly string[]; readonly more: boolean } | { readonly ok: false; readonly error: string };

// A refusal of GitLab's, as the screen says it.
const refusalOf = (error: unknown): string => {
  const status = error instanceof ForgeError || error instanceof GitLabError ? error.status : undefined;
  return status === 401 ? 'refused' : status === 403 ? 'forbidden' : 'unreachable';
};

// Through the contract: the projects the token is a member of; then its
// scopes, when GitLab has the token's own page.
async function checkGitLab(deps: StepDeps, address: string, value: string): Promise<Checked> {
  let names: string[];
  try {
    const forge = new GitLabForge({ address, token: value, dir: stateFolder(deps.env), fetch: deps.fetch });
    names = (await forge.listRepositories()).map((repository) => repository.repo);
  } catch (error) {
    return { ok: false, error: refusalOf(error) };
  }
  try {
    const self = (await new GitLabClient({ address, token: value, fetch: deps.fetch }).call('GET', '/personal_access_tokens/self')).value as { scopes?: unknown } | null;
    if (Array.isArray(self?.scopes) && !self.scopes.includes('api')) return { ok: false, error: 'scope' };
  } catch (error) {
    if (!(error instanceof GitLabError && error.status === 404)) return { ok: false, error: refusalOf(error) };
  }
  if (names.length === 0) return { ok: false, error: 'empty' };
  return { ok: true, names, more: names.length >= MAX_LISTED };
}

async function check(deps: StepDeps, value: string): Promise<Checked> {
  let response: Response;
  try {
    response = await deps.fetch(`${forgeApi(deps.env)}/user/repos?per_page=${PER_PAGE}&sort=updated`, {
      headers: { authorization: `Bearer ${value}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'cleared-v2-setup' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (response.status === 401) return { ok: false, error: 'refused' };
  if (response.status === 403) return { ok: false, error: 'forbidden' };
  if (!response.ok) return { ok: false, error: 'unreachable' };
  let page: unknown;
  try { page = await response.json(); } catch { return { ok: false, error: 'unreachable' }; }
  if (!Array.isArray(page)) return { ok: false, error: 'unreachable' };
  const names = page.map((repo) => (repo as { full_name?: unknown }).full_name).filter((name): name is string => typeof name === 'string');
  if (names.length === 0) return { ok: false, error: 'empty' };
  return { ok: true, names, more: /rel="next"/.test(response.headers.get('link') ?? '') };
}

async function saveGitLab(deps: StepDeps, context: Parameters<typeof answer>[0], value: string, given: unknown): Promise<void> {
  if (given !== undefined && typeof given !== 'string') throw new HttpError(400, 'address');
  let address: string;
  try { address = gitlabAddress(given); } catch { throw new HttpError(400, 'address'); }
  if (deps.fromEnvironment.has(GITLAB_FILE_SETTING)) throw new HttpError(409, 'environment');
  const started = Date.now();
  const checked = await checkGitLab(deps, address, value);
  deps.records.machine('forge', Date.now() - started);
  if (!checked.ok) throw new HttpError(400, checked.error);
  const path = settingsPath(deps.env);
  if (!path) throw new HttpError(503, 'no state folder: set CLEARED_STATE_DIR');
  const file = join(stateFolder(deps.env), GITLAB_FILE);
  writeCredential(file, value);
  writeSettings(path, { env: { [GITLAB_FILE_SETTING]: file, [GITLAB_URL]: address } });
  deps.env[GITLAB_FILE_SETTING] = file;
  if (!deps.fromEnvironment.has(GITLAB_URL)) deps.env[GITLAB_URL] = address;
  deps.records.done('forge');
  answer(context, 200, { forge: 'gitlab', credential: gitlabOf(deps).credential, repositories: checked.names.length, more: checked.more, sample: checked.names.slice(0, SAMPLE) } satisfies ForgeChecked);
}

const forge: SetupStep = {
  id: 'forge',
  filled: true,
  skippable: false,
  routes: (deps) => [
    {
      method: 'GET', path: '/api/setup/forge',
      handle: guarded(deps, async (context) => {
        answer(context, 200, { credential: credentialOf(deps), rights: FORGE_RIGHTS, gitlab: gitlabOf(deps) } satisfies ForgeView);
      }),
    },
    {
      method: 'POST', path: '/api/setup/forge',
      handle: guarded(deps, async (context) => {
        const body = await readBody(context.request);
        const raw = body.value;
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value === '' || /\s/.test(value) || value.length > 512) throw new HttpError(400, 'invalid');
        if (body.forge !== undefined && body.forge !== 'github' && body.forge !== 'gitlab') throw new HttpError(400, 'invalid');
        if (body.forge === 'gitlab') return saveGitLab(deps, context, value, body.address);
        const current = credentialOf(deps);
        if (current.set && current.source === 'environment') throw new HttpError(409, 'environment');
        const started = Date.now();
        const checked = await check(deps, value);
        deps.records.machine('forge', Date.now() - started);
        if (!checked.ok) throw new HttpError(400, checked.error);
        const path = settingsPath(deps.env);
        if (!path) throw new HttpError(503, 'no state folder: set CLEARED_STATE_DIR');
        const file = join(stateFolder(deps.env), FORGE_FILE);
        writeCredential(file, value);
        writeSettings(path, { files: { GH_TOKEN: file } });
        deps.env.GH_TOKEN = value;
        deps.records.done('forge');
        answer(context, 200, { forge: 'github', credential: credentialOf(deps), repositories: checked.names.length, more: checked.more, sample: checked.names.slice(0, SAMPLE) } satisfies ForgeChecked);
      }),
    },
  ],
};

export default forge;
