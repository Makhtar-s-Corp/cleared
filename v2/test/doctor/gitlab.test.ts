// The doctor's gitlab section (docs/v2/milestone-5-plan.md, section 11): run
// only when named, as mirror, and read only. It says the GitLab address, the
// token file (looked at as the adapter reads it, never printed), whether
// GitLab accepts the token and as whom, whether the token has the api scope,
// and each GitLab service's project with the role the token holds on it.
// French and English, against a fake GitLab on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import gitlab, { GITLAB_TIMEOUT_MS, gitlabChecks } from '../../src/doctor/sections/gitlab.ts';
import { loadSections, SECTIONS_DIR } from '../../src/doctor/sections.ts';
import type { DoctorLine } from '../../src/doctor/section.ts';
import { emptyGitLab, FakeGitLab, type GitLabProject } from '../forge/fakes/gitlab.ts';
import { tempDir } from '../workspace/git.ts';

const TOKEN = ['gitlab', 'credential', 'of', 'the', 'doctor'].join('-');
const project = (path: string, access_level = 30): GitLabProject => ({ path_with_namespace: path, http_url_to_repo: `https://gitlab.invalid/${path}.git`, default_branch: 'main', visibility: 'private', archived: false, access_level });

async function withLab(run: (lab: FakeGitLab, env: Record<string, string>, dir: string) => Promise<void>, services = '[service guestbook]\nrepository = example/guestbook\nurl = https://gitlab.invalid/example/guestbook.git\nforge = gitlab\n\n[service filter-api]\nrepository = example/filter-api\nurl = https://github.com/example/filter-api.git\n'): Promise<void> {
  const lab = new FakeGitLab(TOKEN, { ...emptyGitLab(), projects: [project('example/guestbook')] });
  const address = await lab.listen();
  const dir = tempDir('doctor-gitlab');
  const file = join(dir, 'forge-gitlab.token');
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  const workspace = join(dir, 'workspace.conf');
  writeFileSync(workspace, `[workspace]\nid = demo\n\n${services}`);
  const env = { HOME: dir, CLEARED_STATE_DIR: dir, CLEARED_V2_STATE_DIR: dir, CLEARED_V2_WORKSPACE: workspace, CLEARED_V2_GITLAB_URL: address, CLEARED_V2_GITLAB_TOKEN_FILE: file };
  try { await run(lab, env, dir); } finally { await lab.close(); }
}

const one = (lines: readonly DoctorLine[], id: string): DoctorLine => {
  const found = lines.filter((line) => line.id === id);
  assert.equal(found.length, 1, `one ${id} line: ${JSON.stringify(lines)}`);
  return found[0]!;
};
const clean = (lines: readonly DoctorLine[]) => {
  const text = JSON.stringify(lines);
  assert.ok(!text.includes(TOKEN), 'the token is in no line');
  assert.ok(!text.includes('⟦'), `no missing word: ${text}`);
  for (const line of lines) if (line.level === 'fail') assert.ok(line.todo, `${line.id} says what to do`);
};

test('a section of its own file, named gitlab, run only when named', async () => {
  const sections = await loadSections(SECTIONS_DIR);
  const found = sections.find((section) => section.name === 'gitlab');
  assert.equal(found, gitlab);
  assert.equal(gitlab.byDefault, false);
  assert.notEqual(gitlab.title('en'), gitlab.title('fr'));
});

test('an install that is well: the address, the file, the account, the scope and each GitLab service\'s project pass, in English and in French; GitHub\'s services are not its', async () => {
  await withLab(async (lab, env) => {
    for (const language of ['en', 'fr'] as const) {
      const lines = await gitlabChecks({ env, language });
      clean(lines);
      assert.deepEqual(lines.filter((line) => line.level !== 'ok'), [], `all ok in ${language}: ${JSON.stringify(lines)}`);
      assert.deepEqual(lines.map((line) => line.id), ['gitlab_address', 'gitlab_file', 'gitlab_account', 'gitlab_scope', 'gitlab_project']);
      assert.match(one(lines, 'gitlab_account').text, /@cleared-bot/);
      assert.match(one(lines, 'gitlab_project').text, /example\/guestbook/);
      assert.match(one(lines, 'gitlab_project').text, language === 'en' ? /Developer/ : /Développeur/);
    }
    assert.ok(lab.requests.every((r) => r.method === 'GET'), 'read only');
    assert.ok(!lab.requests.some((r) => r.path.includes('filter-api')), 'a GitHub service is not asked of GitLab');
  });
});

test('not set up: one notice, nothing asked of GitLab', async () => {
  await withLab(async (lab, env) => {
    const { CLEARED_V2_GITLAB_TOKEN_FILE: _file, ...without } = env;
    const lines = await gitlabChecks({ env: without, language: 'en' });
    clean(lines);
    assert.deepEqual(lines.map((line) => [line.id, line.level]), [['gitlab_file', 'notice']]);
    assert.equal(lab.requests.length, 0);
  });
});

test('a role below Developer, a project GitLab does not show, a token without api, and a GitLab with no token page are each said', async () => {
  await withLab(async (lab, env) => {
    lab.world.projects = [project('example/guestbook', 20)];
    let lines = await gitlabChecks({ env, language: 'en' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_project').level, 'fail');
    assert.match(one(lines, 'gitlab_project').text, /Reporter/);
    lab.world.projects = [];
    lines = await gitlabChecks({ env, language: 'fr' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_project').level, 'fail');
    lab.world.projects = [project('example/guestbook')];
    lab.world.scopes = ['read_api'];
    lines = await gitlabChecks({ env, language: 'en' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_scope').level, 'fail');
    assert.match(one(lines, 'gitlab_scope').text, /read_api/);
    lab.world.scopes = null;
    lines = await gitlabChecks({ env, language: 'en' });
    assert.equal(one(lines, 'gitlab_scope').level, 'notice');
  });
});

test('a token GitLab refuses or forbids, and a GitLab that does not answer in time: said apart, the projects not asked', async () => {
  await withLab(async (lab, env) => {
    lab.status = 401;
    let lines = await gitlabChecks({ env, language: 'en' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_account').level, 'fail');
    assert.match(one(lines, 'gitlab_account').text, /refused/);
    assert.equal(one(lines, 'gitlab_project').level, 'off');
    lab.status = 403;
    lines = await gitlabChecks({ env, language: 'en' });
    assert.match(one(lines, 'gitlab_account').text, /403/);
    lab.status = undefined;
    const silent: typeof fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    lines = await gitlabChecks({ env, language: 'en', fetch: silent });
    clean(lines);
    assert.match(one(lines, 'gitlab_account').text, /15 s|15s/);
    assert.equal(GITLAB_TIMEOUT_MS, 15_000);
  });
});

test('an address in clear off loopback, and a token file others can read, fail with what to do before GitLab is asked anything', async () => {
  await withLab(async (lab, env) => {
    let lines = await gitlabChecks({ env: { ...env, CLEARED_V2_GITLAB_URL: 'http://gitlab.example.org' }, language: 'en' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_address').level, 'fail');
    chmodSync(env.CLEARED_V2_GITLAB_TOKEN_FILE!, 0o644);
    lines = await gitlabChecks({ env, language: 'fr' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_file').level, 'fail');
    assert.equal(lab.requests.length, 0);
  });
});

test('a workspace with no GitLab service is a notice', async () => {
  await withLab(async (_lab, env) => {
    const lines = await gitlabChecks({ env, language: 'en' });
    clean(lines);
    assert.equal(one(lines, 'gitlab_project').level, 'notice');
  }, '[service filter-api]\nrepository = example/filter-api\nurl = https://github.com/example/filter-api.git\n');
});
