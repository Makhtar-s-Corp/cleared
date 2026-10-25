// The forge step's GitLab choice (docs/v2/milestone-5-plan.md, section 11):
// an address (gitlab.com by default, or a self-managed GitLab) and a token,
// checked on the spot through the forge contract (the GitLab adapter's
// listing of the token's projects) and the token's own page (its scopes:
// `api` is what opening and merging a merge request needs). A token GitLab
// accepts is written to its own file of mode 600, named in the settings with
// the address, and never answered back. Against a fake GitLab on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSettings } from '../../src/setup/settings.ts';
import { emptyGitLab, FakeGitLab, type GitLabProject } from '../forge/fakes/gitlab.ts';
import { PASSWORD, startSetup, type SetupService } from './support.ts';

// Built here, so no line of the repository holds a value shaped like a credential.
const GOOD = ['gitlab', 'credential', 'of', 'the', 'step'].join('-');
const BAD = ['not', 'a', 'known', 'one'].join('-');
const NAMED = '/srv/state/forge-gitlab.token';

const project = (path: string): GitLabProject => ({ path_with_namespace: path, http_url_to_repo: `https://gitlab.invalid/${path}.git`, default_branch: 'main', visibility: 'private', archived: false, access_level: 30 });

async function withGitLab(run: (service: SetupService, lab: FakeGitLab, address: string, owner: string) => Promise<void>, env: Record<string, string> = {}, projects = [project('example/guestbook'), project('example/apps/filter-api')]): Promise<void> {
  const lab = new FakeGitLab(GOOD, { ...emptyGitLab(), projects });
  const address = await lab.listen();
  const service = await startSetup({ env });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    await run(service, lab, address, owner.id);
  } finally {
    await service.close();
    await lab.close();
  }
}

test('the view offers GitLab beside GitHub, at gitlab.com until an address is saved', async () => {
  await withGitLab(async (service, _lab, _address, owner) => {
    const view = await service.call('/api/setup/forge', { user: owner });
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.gitlab, { credential: { set: false }, address: 'https://gitlab.com' });
    assert.deepEqual(view.json.credential, { set: false }, 'GitHub\'s, as before');
  });
});

test('a GitLab token is checked through the contract, written to its file, named in the settings with its address, and never answered back', async () => {
  await withGitLab(async (service, lab, address, owner) => {
    const saved = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { forge: 'gitlab', address: `${address}/`, value: ` ${GOOD} ` } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.forge, 'gitlab');
    assert.equal(saved.json.repositories, 2);
    assert.deepEqual(saved.json.sample, ['example/apps/filter-api', 'example/guestbook']);
    assert.equal(saved.json.more, false);
    assert.equal(saved.json.credential.source, 'assistant');
    assert.ok(!saved.text.includes(GOOD), 'the answer never holds the token');
    assert.ok(lab.requests.some((r) => r.path === '/api/v4/projects' && r.query.membership === 'true'), 'the adapter\'s listing');
    assert.ok(lab.requests.some((r) => r.path === '/api/v4/personal_access_tokens/self'), 'the token\'s scopes');
    assert.ok(lab.requests.every((r) => r.token));
    const file = join(service.dir, 'forge-gitlab.token');
    assert.equal(readFileSync(file, 'utf8'), `${GOOD}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const settings = readSettings(join(service.dir, 'settings.conf'));
    assert.deepEqual(settings.env, { CLEARED_V2_GITLAB_TOKEN_FILE: file, CLEARED_V2_GITLAB_URL: address });
    assert.deepEqual(settings.files, {}, 'the token is no variable\'s value: the adapter reads its file');
    assert.ok(!readFileSync(join(service.dir, 'settings.conf'), 'utf8').includes(GOOD));
    assert.equal(service.env.CLEARED_V2_GITLAB_TOKEN_FILE, file, 'the service uses it at once, with no restart');
    assert.equal(service.env.CLEARED_V2_GITLAB_URL, address);
    assert.equal(service.env.GH_TOKEN, undefined, 'GitHub\'s is not touched');
    const after = await service.call('/api/setup/forge', { user: owner });
    assert.deepEqual(after.json.gitlab.address, address);
    assert.equal(after.json.gitlab.credential.set, true);
    assert.ok(!after.text.includes(GOOD));
    const view = (await service.call('/api/setup', { user: owner })).json;
    assert.equal(view.steps.find((s: { id: string }) => s.id === 'forge').state, 'done');
  });
});

test('a token GitLab refuses, one without the api scope, one that reaches no project, an address in clear, and no answer: nothing written, the reason said', async () => {
  await withGitLab(async (service, lab, address, owner) => {
    const post = (body: Record<string, unknown>) => service.call('/api/setup/forge', { method: 'POST', user: owner, body: { forge: 'gitlab', address, value: GOOD, ...body } });
    const refused = await post({ value: BAD });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'refused');
    assert.ok(!refused.text.includes(BAD));
    assert.equal((await post({ address: 'http://gitlab.example.org' })).json.error, 'address');
    assert.equal((await post({ address: 'not an address' })).json.error, 'address');
    assert.equal((await post({ forge: 'bitbucket' })).json.error, 'invalid');
    lab.world.scopes = ['read_api', 'read_repository'];
    assert.equal((await post({})).json.error, 'scope');
    lab.world.scopes = null;
    lab.status = 403;
    assert.equal((await post({})).json.error, 'forbidden');
    lab.status = undefined;
    lab.world.projects = [];
    assert.equal((await post({})).json.error, 'empty');
    await lab.close();
    assert.equal((await post({})).json.error, 'unreachable');
    assert.deepEqual(readSettings(join(service.dir, 'settings.conf')).env, {});
    assert.equal(service.env.CLEARED_V2_GITLAB_TOKEN_FILE, undefined);
  });
});

test('a GitLab whose token page is not there (an older one) is checked by its listing alone', async () => {
  await withGitLab(async (service, lab, address, owner) => {
    lab.world.scopes = null;
    const saved = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { forge: 'gitlab', address, value: GOOD } });
    assert.equal(saved.status, 200, saved.text);
  });
});

test('a GitLab token file the environment names is shown as such and not replaced from the browser', async () => {
  await withGitLab(async (service, _lab, address, owner) => {
    const view = await service.call('/api/setup/forge', { user: owner });
    assert.deepEqual(view.json.gitlab.credential, { set: true, at: null, source: 'environment' });
    const refused = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { forge: 'gitlab', address, value: GOOD } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'environment');
  }, { CLEARED_V2_GITLAB_TOKEN_FILE: NAMED });
});
