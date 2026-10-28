// The agent profile and its environment (issue #452): two objects, each a
// list of versions the ledger never changes; an edit is a new version, a
// rollback a new version that copies an old one; the first version of each
// is the service as it ran before profiles, so a ledger from before them
// changes in nothing; no secret in either. Fictitious values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openStore } from '../../src/store/db.ts';
import { ProfileError, profileVersions, recordSessionVersions, sessionVersions } from '../../src/profiles/store.ts';
import { DEFAULT_ENVIRONMENT, DEFAULT_PROFILE } from '../../src/profiles/types.ts';
import { tempDir } from '../workspace/git.ts';

const AT = '2026-10-28T09:00:00.000Z';

function open() {
  const store = openStore(':memory:');
  return { store, versions: profileVersions(store.db, () => new Date(AT)) };
}

// The refusal's code, and the message, which must never hold the value refused.
function refused(run: () => unknown, code: string, value?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProfileError, String(error));
    assert.equal(error.code, code);
    if (value !== undefined) {
      assert.ok(!error.message.includes(value), `the message "${error.message}" holds the value`);
      assert.ok(!JSON.stringify(error).includes(value), 'the error holds the value');
    }
    return true;
  });
}

test('a new ledger has the default profile and the default environment, version 1 each, written by the service', () => {
  const { versions } = open();
  const profile = versions.profile.current();
  const environment = versions.environment.current();
  assert.equal(profile.version, 1);
  assert.deepEqual(profile.body, DEFAULT_PROFILE);
  assert.equal(profile.createdBy, 'cleared');
  assert.equal(profile.restoredFrom, null);
  assert.equal(profile.createdAt, null, 'the service as it always ran: no day');
  assert.equal(environment.version, 1);
  assert.deepEqual(environment.body, DEFAULT_ENVIRONMENT);
  assert.deepEqual(DEFAULT_PROFILE, {
    harness: 'claude-code', authorModel: null, reviewerModel: null, rolePrompts: { author: '', reviewer: '' }, allowedTools: [], mcpServers: [], skills: 'project',
  });
  assert.deepEqual(DEFAULT_ENVIRONMENT, { image: null, network: 'project', allowedHosts: [], cpus: null, memory: null });
});

test('opening a ledger writes nothing; the first version is written with the second', () => {
  const file = join(tempDir('profiles'), 'ledger.db');
  openStore(file).close();
  const store = openStore(file);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_profile_versions').get()?.n, 0, 'an empty ledger stays empty');
  const versions = profileVersions(store.db);
  assert.equal(versions.profile.list().length, 1);
  assert.equal(versions.environment.list().length, 1);
  versions.profile.save({ harness: 'auto' }, 'u1');
  assert.deepEqual((store.db.prepare('SELECT version, created_at, created_by FROM agent_profile_versions ORDER BY version').all() as { version: number; created_at: string | null; created_by: string }[])
    .map((r) => [r.version, r.created_at === null, r.created_by]), [[1, true, 'cleared'], [2, false, 'u1']]);
  store.close();
});

test('an edit is a new version; the old one stays readable and unchanged; the other object keeps its history', () => {
  const { versions } = open();
  const before = versions.profile.get(1);
  const second = versions.profile.save({ authorModel: 'claude-opus-5-1', rolePrompts: { author: 'Write the changelog line too.', reviewer: '' } }, 'u1');
  assert.equal(second.version, 2);
  assert.equal(second.createdBy, 'u1');
  assert.equal(second.createdAt, AT);
  assert.equal(second.body.authorModel, 'claude-opus-5-1');
  assert.equal(second.body.harness, 'claude-code', 'what the edit does not name is the current version\'s');
  assert.deepEqual(versions.profile.get(1), before, 'version 1 is unchanged');
  assert.equal(versions.profile.current().version, 2);
  assert.deepEqual(versions.profile.list().map((v) => v.version), [1, 2]);
  assert.deepEqual(versions.environment.list().map((v) => v.version), [1], 'the environment is another object');

  versions.environment.save({ allowedHosts: ['api.example.com'], cpus: '1', memory: '2g' }, 'u1');
  assert.deepEqual(versions.environment.list().map((v) => v.version), [1, 2]);
  assert.deepEqual(versions.profile.list().map((v) => v.version), [1, 2], 'the profile is another object');
});

test('the ledger itself refuses to change or remove a version', () => {
  const { store, versions } = open();
  versions.profile.save({ authorModel: 'claude-opus-5-1' }, 'u1');
  versions.environment.save({ cpus: '1' }, 'u1');
  assert.throws(() => store.db.prepare("UPDATE agent_profile_versions SET body = '{}' WHERE version = 1").run(), /never changed/);
  assert.throws(() => store.db.prepare('DELETE FROM agent_profile_versions WHERE version = 1').run(), /never changed/);
  assert.throws(() => store.db.prepare("UPDATE environment_versions SET created_by = 'u2'").run(), /never changed/);
  assert.throws(() => store.db.prepare('DELETE FROM environment_versions').run(), /never changed/);
  assert.deepEqual(versions.profile.get(1)?.body, DEFAULT_PROFILE);
});

test('a rollback is a new version that copies an old one; the versions between stay', () => {
  const { versions } = open();
  versions.profile.save({ authorModel: 'claude-opus-5-1' }, 'u1');
  const back = versions.profile.restore(1, 'u2');
  assert.equal(back.version, 3);
  assert.equal(back.restoredFrom, 1);
  assert.equal(back.createdBy, 'u2');
  assert.deepEqual(back.body, DEFAULT_PROFILE);
  assert.equal(versions.profile.get(2)?.body.authorModel, 'claude-opus-5-1');
  assert.equal(versions.profile.current().version, 3);

  versions.environment.save({ network: 'model-only' }, 'u1');
  assert.equal(versions.environment.restore(1, 'u1').body.network, 'project');

  refused(() => versions.profile.restore(9, 'u1'), 'version');
  refused(() => versions.profile.restore(3, 'u1'), 'unchanged');
  refused(() => versions.profile.restore(1, 'u1'), 'unchanged', undefined);
  refused(() => versions.profile.save({}, 'u1'), 'unchanged');
  assert.equal(versions.profile.list().length, 3, 'a refusal writes nothing');
});

test('the harness is Claude Code or auto: Codex and Cursor only through the pick, P87 standing', () => {
  const { versions } = open();
  assert.equal(versions.profile.save({ harness: 'auto' }, 'u1').body.harness, 'auto');
  for (const harness of ['cursor', 'codex', 'gemini', '', 3]) refused(() => versions.profile.save({ harness }, 'u1'), 'harness');
});

test('what a profile refuses, each with its code, and nothing written', () => {
  const { versions } = open();
  refused(() => versions.profile.save({ authorModel: 'gpt-6-luna' }, 'u1'), 'model');
  refused(() => versions.profile.save({ authorModel: 'claude opus' }, 'u1'), 'model');
  refused(() => versions.profile.save({ authorModel: 'claude-sonnet-5-5', reviewerModel: 'claude-sonnet-5-5' }, 'u1'), 'same_models');
  refused(() => versions.profile.save({ rolePrompts: { author: 'x'.repeat(4001), reviewer: '' } }, 'u1'), 'prompt');
  refused(() => versions.profile.save({ rolePrompts: { author: 'Fine.' } }, 'u1'), 'prompt');
  for (const tool of ['*', '* --force', 'make\ncheck', '', 'x'.repeat(201)])
    refused(() => versions.profile.save({ allowedTools: [tool] }, 'u1'), 'tools');
  refused(() => versions.profile.save({ allowedTools: 'make check' }, 'u1'), 'tools');
  refused(() => versions.profile.save({ mcpServers: [{ name: 'tracker', command: 'tracker-mcp' }] }, 'u1'), 'mcp');
  refused(() => versions.profile.save({ skills: 'none' }, 'u1'), 'skills');
  refused(() => versions.profile.save({ model: 'claude-opus-5-1' }, 'u1'), 'body');
  refused(() => versions.profile.save(['claude-code'], 'u1'), 'body');
  assert.equal(versions.profile.list().length, 1);
});

test('what an environment refuses: an image Cleared did not build, an unknown network, hosts it cannot read, limits out of bounds', () => {
  const { versions } = open();
  for (const image of ['ubuntu:latest', 'cleared-v2-session', 'registry.example.com/cleared-v2-session:1', 'cleared-v2-session:a b'])
    refused(() => versions.environment.save({ image }, 'u1'), 'image');
  refused(() => versions.environment.save({ network: 'open' }, 'u1'), 'network');
  for (const host of ['*', 'http://api.example.com', 'a b', 'api.example.com/path', ''])
    refused(() => versions.environment.save({ allowedHosts: [host] }, 'u1'), 'hosts');
  refused(() => versions.environment.save({ network: 'model-only', allowedHosts: ['api.example.com'] }, 'u1'), 'hosts');
  for (const cpus of ['0', '0.1', '17', 'two', '1.234']) refused(() => versions.environment.save({ cpus }, 'u1'), 'cpus');
  for (const memory of ['10k', '128m', '65g', '2 g', '2']) refused(() => versions.environment.save({ memory }, 'u1'), 'memory');
  assert.equal(versions.environment.list().length, 1);

  const ok = versions.environment.save({ image: 'cleared-v2-session:2.1.306', allowedHosts: ['api.example.com', '*.cdn.example.net'], cpus: '0.5', memory: '512m' }, 'u1');
  assert.deepEqual(ok.body, { image: 'cleared-v2-session:2.1.306', network: 'project', allowedHosts: ['api.example.com', '*.cdn.example.net'], cpus: '0.5', memory: '512m' });
});

test('no secret in a profile or an environment: a value that looks like one is refused, never said back, and nothing is written', () => {
  const { versions } = open();
  // Built from parts, so this file holds no secret-looking literal.
  const anthropic = ['sk', 'ant', 'api03', 'Fx7Qd2Lm9Rt4Vw8Yz1Bc5Ng3Hk6Jp0'].join('-');
  const github = ['ghp', 'Q7f2L9m4R1t8V3w6Y0z5B2c7N4h9K1j3P6sD'].join('_');
  const slack = ['xoxb', '1234567890', 'Fx7Qd2Lm9Rt4'].join('-');
  const aws = ['AKIA', 'Q7F2L9M4R1T8V3W6'].join('');
  const bearer = `curl -H "Authorization: Bearer ${'Fx7Qd2Lm9Rt4Vw8Yz1Bc5Ng3'}" https://api.example.com`;
  const word = ['hunter2', 'hunter2'].join('');
  const inUrl = `https://bot:${word}@tracker.example.com/mcp`;
  const assigned = `Use API_TOKEN=${'Fx7Qd2Lm9Rt4Vw8Y'} when you call it.`;
  const cases: [string, Record<string, unknown>, 'profile' | 'environment'][] = [
    [anthropic, { rolePrompts: { author: `The key is ${anthropic}.`, reviewer: '' } }, 'profile'],
    [github, { rolePrompts: { author: '', reviewer: github } }, 'profile'],
    [slack, { allowedTools: [`notify --token ${slack}`] }, 'profile'],
    [aws, { rolePrompts: { author: aws, reviewer: '' } }, 'profile'],
    ['Fx7Qd2Lm9Rt4Vw8Yz1Bc5Ng3', { allowedTools: [bearer] }, 'profile'],
    [word, { mcpServers: [{ name: 'tracker', url: inUrl }] }, 'profile'],
    [word, { mcpServers: [{ name: 'tracker', env: { TRACKER_PASSWORD: word } }] }, 'profile'],
    ['Fx7Qd2Lm9Rt4Vw8Y', { rolePrompts: { author: assigned, reviewer: '' } }, 'profile'],
    [word, { allowedHosts: [`bot:${word}@api.example.com`] }, 'environment'],
  ];
  for (const [value, change, object] of cases) refused(() => versions[object].save(change, 'u1'), 'secret', value);
  assert.equal(versions.profile.list().length, 1);
  assert.equal(versions.environment.list().length, 1);
});

test('a session keeps the versions it started on; one from before profiles ran on version 1 of each; the lead and a reader have none', () => {
  const { store, versions } = open();
  recordSessionVersions(store.db, 's-new', { profile: 2, environment: 1, auto: true });
  recordSessionVersions(store.db, 's-new', { profile: 5, environment: 5, auto: false });
  assert.deepEqual(sessionVersions(store.db, 's-new', 'author'), { profile: 2, environment: 1, auto: true }, 'a session\'s versions are written once');
  assert.throws(() => store.db.prepare('UPDATE session_profiles SET profile = 3').run(), /never changed/);
  assert.deepEqual(sessionVersions(store.db, 's-old', 'author'), { profile: 1, environment: 1, auto: false });
  assert.deepEqual(sessionVersions(store.db, 's-old', 'reviewer'), { profile: 1, environment: 1, auto: false });
  assert.equal(sessionVersions(store.db, 's-lead', 'lead'), undefined);
  assert.equal(sessionVersions(store.db, 's-reader', 'reader'), undefined);
  assert.equal(versions.profile.list().length, 1);
});
