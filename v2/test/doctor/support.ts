// An install the ready section finds well, for the doctor's tests, made of
// fakes only: a scratch state folder (mode 700) with its settings file and
// the forge credential's file (mode 600), a Claude Code login file the
// doctor only looks at, a bare remote and the service's checkout of it, the
// fake docker CLI with the two session images, and a fake GitHub answering
// in this process. Each test then breaks one part.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Docker, LABEL } from '../../src/container/docker.ts';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../../src/container/session-runtime.ts';
import type { ReadyProbes } from '../../src/doctor/ready.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { remote, tempDir } from '../workspace/git.ts';

// Assembled at run time, so no line of the repository holds a value shaped like a credential.
export const FORGE_VALUE = ['forge', 'value', 'never', 'printed', '7Qx2'].join('-');
export const MODEL_VALUE = ['model', 'login', 'never', 'read', '9Zk4'].join('-');
export const REPO = 'org/guestbook';
export const GB = 1024 ** 3;

export type GitHubAnswer = { readonly status: number; readonly body?: unknown } | 'silent';

// GitHub as the ready section reads it: GET /user, then GET /repos/{repo}.
export class FakeGitHubReads {
  readonly requests: { path: string; auth: string | null }[] = [];
  user: GitHubAnswer = { status: 200, body: { login: 'cleared-bot' } };
  repos = new Map<string, GitHubAnswer>([[REPO, { status: 200, body: { full_name: REPO, permissions: { admin: false, push: true, pull: true } } }]]);

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    this.requests.push({ path: url.pathname, auth });
    const answer = url.pathname === '/user' ? this.user : this.repos.get(url.pathname.replace(/^\/repos\//, '')) ?? { status: 404, body: { message: 'Not Found' } };
    if (answer === 'silent') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (auth !== `Bearer ${FORGE_VALUE}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    return Response.json(answer.body ?? {}, { status: answer.status });
  };
}

export type Install = {
  readonly root: string;
  readonly state: string;
  readonly checkout: string;
  readonly remote: string;
  readonly modelFile: string;
  readonly forgeFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly docker: FakeDocker;
  readonly github: FakeGitHubReads;
  free: number;                                 // bytes free on the state folder's disk
  probes(): ReadyProbes;
};

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

export function install(): Install {
  const root = tempDir('doctor');
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const forgeFile = join(state, 'forge-github.token');
  writeFileSync(forgeFile, `${FORGE_VALUE}\n`, { mode: 0o600 });
  const modelFile = join(state, 'claude.token');
  writeFileSync(modelFile, `${MODEL_VALUE}\n`, { mode: 0o600 });
  // Never read by the doctor: a file no one may read still reads as present.
  chmodSync(modelFile, 0o000);
  writeFileSync(join(state, 'settings.conf'), `[env]\nCLEARED_V2_OWNER_ID = alex\n\n[env_files]\nGH_TOKEN = ${forgeFile}\n`, { mode: 0o600 });
  const bare = remote();
  const checkout = join(root, 'checkout');
  execFileSync('git', ['clone', '-q', bare, checkout], { stdio: 'ignore' });
  git(checkout, ['fetch', '-q', 'origin']);
  const docker = new FakeDocker();
  for (const [index, tag] of [SESSION_IMAGE, EGRESS_IMAGE].entries()) docker.images.push({ id: `sha256:${String(index + 1).padStart(64, '0')}`, name: tag, labels: { 'cleared.dev': 'v2' } });
  const github = new FakeGitHubReads();
  const env: NodeJS.ProcessEnv = {
    HOME: root, CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state,
    GH_TOKEN: FORGE_VALUE, CLEARED_V2_FORGE_GITHUB_API: 'http://127.0.0.1:9/',
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: checkout, CLEARED_V2_REPO: REPO, CLEARED_V2_REPO_URL: bare,
  };
  const made: Install = {
    root, state, checkout, remote: bare, modelFile, forgeFile, env, docker, github, free: 120 * GB,
    probes: () => ({
      docker: new Docker(docker.runner, docker.spawner),
      fetch: github.fetch,
      statfs: () => ({ bavail: Math.floor(made.free / 4096), bsize: 4096 }),
      interfaces: () => ({}),
      daemonConfig: () => undefined,
    }),
  };
  return made;
}

export { LABEL };
