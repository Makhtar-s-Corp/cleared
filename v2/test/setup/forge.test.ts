// The forge step (docs/v2/milestone-5-plan.md, section 5.2, lane
// v2-j5-assistant): a GitHub credential, checked on the spot by reading the
// repositories it reaches, written to its own file of mode 600 and named in
// the settings, never answered back. Against a fake GitHub on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORGE_RIGHTS, forgeApi } from '../../src/setup/steps/forge.ts';
import { readSettings } from '../../src/setup/settings.ts';
import { FakeForge } from './fakes/github.ts';
import { PASSWORD, startSetup, type SetupService } from './support.ts';

// Built here, so no line of the repository holds a value shaped like a credential.
const GOOD = ['forge', 'credential', 'of', 'the', 'test'].join('-');
const BAD = ['not', 'a', 'known', 'one'].join('-');

async function withForge(run: (service: SetupService, fake: FakeForge, owner: string) => Promise<void>, env: Record<string, string> = {}, repos: readonly string[] = ['org/guestbook', 'org/filter-api']): Promise<void> {
  const fake = new FakeForge({ [GOOD]: repos });
  const api = await fake.listen();
  const service = await startSetup({ env: { CLEARED_V2_FORGE_GITHUB_API: api, ...env } });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    await run(service, fake, owner.id);
  } finally {
    await service.close();
    await fake.close();
  }
}

test('the API address is GitHub\'s, or one on loopback for a test; any other is refused', () => {
  assert.equal(forgeApi({}), 'https://api.github.com');
  assert.equal(forgeApi({ CLEARED_V2_FORGE_GITHUB_API: 'http://127.0.0.1:4010/' }), 'http://127.0.0.1:4010');
  assert.throws(() => forgeApi({ CLEARED_V2_FORGE_GITHUB_API: 'http://example.com' }), /loopback/);
});

test('the rights a fine-grained credential needs are listed, each with what Cleared does with it', () => {
  const names = FORGE_RIGHTS.map((right) => right.permission);
  for (const name of ['metadata', 'contents', 'pull_requests', 'commit_statuses']) assert.ok(names.includes(name as never), name);
  assert.equal(FORGE_RIGHTS.find((r) => r.permission === 'contents')?.access, 'write');
  assert.equal(FORGE_RIGHTS.find((r) => r.permission === 'metadata')?.access, 'read');
  assert.ok(FORGE_RIGHTS.some((r) => r.optional), 'some only for a feature that is off by default');
});

test('a credential GitHub accepts is checked, written to its file, named in the settings, and never answered back', async () => {
  await withForge(async (service, fake, owner) => {
    const before = await service.call('/api/setup/forge', { user: owner });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.credential, { set: false });
    const saved = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: ` ${GOOD} ` } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.repositories, 2);
    assert.deepEqual(saved.json.sample, ['org/guestbook', 'org/filter-api']);
    assert.equal(saved.json.more, false);
    assert.equal(saved.json.credential.set, true);
    assert.equal(saved.json.credential.source, 'assistant');
    assert.ok(!saved.text.includes(GOOD), 'the answer never holds the credential');
    assert.deepEqual(fake.requests.map((r) => [r.method, r.auth, r.version]), [['GET', `Bearer ${GOOD}`, '2022-11-28']]);
    const file = join(service.dir, 'forge-github.token');
    assert.equal(readFileSync(file, 'utf8'), `${GOOD}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readSettings(join(service.dir, 'settings.conf')).files, { GH_TOKEN: file });
    assert.ok(!readFileSync(join(service.dir, 'settings.conf'), 'utf8').includes(GOOD), 'the settings name the file, never the value');
    assert.equal(service.env.GH_TOKEN, GOOD, 'the service uses it at once, with no restart');
    const after = await service.call('/api/setup/forge', { user: owner });
    assert.ok(!after.text.includes(GOOD));
    assert.equal(after.json.credential.set, true);
    const view = (await service.call('/api/setup', { user: owner })).json;
    const forge = view.steps.find((s: { id: string }) => s.id === 'forge');
    assert.equal(forge.state, 'done');
    assert.ok(forge.machineMs >= 0);
  });
});

test('a credential GitHub refuses, one that reaches no repository, an empty one, and no answer: nothing written, the reason said', async () => {
  await withForge(async (service, fake, owner) => {
    const refused = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: BAD } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'refused');
    assert.ok(!refused.text.includes(BAD));
    assert.equal((await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: '  ' } })).json.error, 'invalid');
    assert.equal((await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: 'two words' } })).json.error, 'invalid');
    fake.status = 403;
    assert.equal((await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: GOOD } })).json.error, 'forbidden');
    fake.status = undefined;
    await fake.close();
    assert.equal((await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: GOOD } })).json.error, 'unreachable');
    assert.deepEqual(readSettings(join(service.dir, 'settings.conf')).files, {});
    assert.equal(service.env.GH_TOKEN, undefined);
  });
  await withForge(async (service, _fake, owner) => {
    const empty = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: GOOD } });
    assert.equal(empty.json.error, 'empty');
  }, {}, []);
});

test('a first page full says there are more; only the first five names come back', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `org/repo-${i}`);
  await withForge(async (service, _fake, owner) => {
    const saved = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: GOOD } });
    assert.equal(saved.json.repositories, 100);
    assert.equal(saved.json.more, true);
    assert.equal(saved.json.sample.length, 5);
  }, {}, many);
});

test('a credential the environment gives (GH_TOKEN) is shown as such and not replaced from the browser', async () => {
  await withForge(async (service, _fake, owner) => {
    const view = await service.call('/api/setup/forge', { user: owner });
    assert.deepEqual(view.json.credential, { set: true, at: null, source: 'environment' });
    assert.ok(!view.text.includes('from-the-environment'));
    const refused = await service.call('/api/setup/forge', { method: 'POST', user: owner, body: { value: GOOD } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'environment');
  }, { GH_TOKEN: ['set', 'from', 'the', 'environment'].join('-') });
});
