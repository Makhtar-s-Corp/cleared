// The assistant's forge step (docs/v2/milestone-5-plan.md, section 5.2): a
// GitHub credential, checked on the spot by reading the repositories it
// reaches (GET /user/repos, one page of 100), on its own: the forge contract
// of lane v2-j5-forge is made in the same wave, and lane v2-j5-gitlab moves
// this step onto it. A credential GitHub accepts and that reaches a
// repository is written to <state>/forge-github.token (mode 600), named in
// the settings as GH_TOKEN's file, which gh reads, and set in this process
// at once. The value travels in the authorization header only; no answer,
// no line of the settings and no log holds it.
//
//   GET  /api/setup/forge   -> ForgeView
//   POST /api/setup/forge   { value } -> ForgeChecked, or 400 { error }:
//        invalid, refused (401), forbidden (403), unreachable, empty;
//        409 { error: environment } when the environment gives GH_TOKEN
import { join } from 'node:path';
import { readCredential, readSettings, settingsPath, stateFolder, writeCredential, writeSettings } from '../settings.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import type { SetupStep, StepDeps } from '../step.ts';
import { FORGE_RIGHTS, type CredentialView, type ForgeChecked, type ForgeView } from '../types.ts';

export const FORGE_FILE = 'forge-github.token';
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

type Checked = { readonly ok: true; readonly names: readonly string[]; readonly more: boolean } | { readonly ok: false; readonly error: string };

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

const forge: SetupStep = {
  id: 'forge',
  filled: true,
  skippable: false,
  routes: (deps) => [
    {
      method: 'GET', path: '/api/setup/forge',
      handle: guarded(deps, async (context) => {
        answer(context, 200, { credential: credentialOf(deps), rights: FORGE_RIGHTS } satisfies ForgeView);
      }),
    },
    {
      method: 'POST', path: '/api/setup/forge',
      handle: guarded(deps, async (context) => {
        const raw = (await readBody(context.request)).value;
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value === '' || /\s/.test(value) || value.length > 512) throw new HttpError(400, 'invalid');
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
        answer(context, 200, { credential: credentialOf(deps), repositories: checked.names.length, more: checked.more, sample: checked.names.slice(0, SAMPLE) } satisfies ForgeChecked);
      }),
    },
  ],
};

export default forge;
