// The engine's part of decision 24 (docs/v2/milestone-2-plan.md, lane 17):
// a service's `reviewer:<model>` sensitivity names the reviewer of the
// tickets that touch it, and a Quick ticket on a `full` service is written
// by the author model, not Haiku. The plan level and the approver are lane
// 18's.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { quickAuthor, setup, until, type Setup } from './support.ts';

const service = (name: string, sensitivity: ServiceConfig['sensitivity']): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity, consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
});
const workspace = (...services: ServiceConfig[]): WorkspaceConfig => ({ id: 'guestbook', name: 'Guestbook', file: null, services });

async function run(t: Setup, labels: string[] = []): Promise<{ author: string; reviewer: string }> {
  const ticket = await t.tickets.create({ title: 'Newest entry first', project: 'guestbook', labels }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 2, 'the review');
  await t.engine.settled();
  await t.engine.close();
  return { author: t.startedSessions[0]!.input.model, reviewer: t.startedSessions[1]!.input.model };
}

test('a ticket on a reviewer:claude-opus-5-5 service gets Opus as its reviewer, with a Sonnet author', async () => {
  const t = await setup({
    scripts: { author: quickAuthor },
    config: { authorModel: 'claude-sonnet-5-5', reviewerModel: 'claude-haiku-5-5', workspace: workspace(service('guestbook', 'reviewer:claude-opus-5-5')) },
  });
  assert.deepEqual(await run(t), { author: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5' });
});

test('a normal service keeps the configured reviewer', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, config: { workspace: workspace(service('guestbook', 'normal')) } });
  assert.deepEqual(await run(t), { author: 'claude-opus-5-5', reviewer: 'claude-sonnet-5-5' });
});

test('a Quick ticket on a full service gets the author model, not Haiku', async () => {
  const quick = await setup({ scripts: { author: quickAuthor }, config: { workspace: workspace(service('guestbook', 'normal')) } });
  assert.equal((await run(quick, ['Quick'])).author, 'claude-haiku-5-5', 'the fast lane elsewhere');
  const t = await setup({ scripts: { author: quickAuthor }, config: { workspace: workspace(service('guestbook', 'full')) } });
  assert.deepEqual(await run(t, ['Quick']), { author: 'claude-opus-5-5', reviewer: 'claude-sonnet-5-5' });
});

test('a Quick ticket on a reviewer:claude-haiku-5-5 service is not written by Haiku: the reviewer is always another model', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, config: { workspace: workspace(service('guestbook', 'reviewer:claude-haiku-5-5')) } });
  assert.deepEqual(await run(t, ['Quick']), { author: 'claude-opus-5-5', reviewer: 'claude-haiku-5-5' });
});

test('a ticket of two services: the reviewer of the first service it names that names one, and full on any of them refuses the fast lane', async () => {
  const services = workspace(service('guestbook', 'normal'), service('filter-api', 'reviewer:claude-opus-5-5'), service('tools', 'full'));
  const t = await setup({ scripts: { author: quickAuthor }, config: { authorModel: 'claude-sonnet-5-5', workspace: services } });
  const ticket = await t.tickets.create({ title: 'Held for review', project: 'guestbook', labels: ['Quick'], services: ['guestbook', 'filter-api', 'tools'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 2, 'the review');
  await t.engine.settled();
  assert.equal(t.startedSessions[0]!.input.model, 'claude-sonnet-5-5', 'tools is full: no Haiku');
  assert.equal(t.startedSessions[1]!.input.model, 'claude-opus-5-5');
  await t.engine.close();
});
