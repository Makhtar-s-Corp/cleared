// The Consumption screen's model lever on the flow (O15): the author model
// of the sessions that start after the choice is the owner's, and never the
// ticket's reviewer model (the lever acts on #authorModel alone).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Levers } from '../../src/consumption/levers.ts';
import { quickAuthor, setup } from '../flow/support.ts';

const levers = (model: string | null): { read(): Levers } => ({ read: () => ({ model, maxLanes: null, paused: false }) });

test('with no lever the author runs on the configured model', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.settled();
  assert.equal(t.startedSessions[0]?.input.model, 'claude-opus-5-5');
  await t.engine.close();
});

test('the model lever changes the author of the sessions that start', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, levers: levers('claude-haiku-5-5') });
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.settled();
  assert.equal(t.startedSessions[0]?.input.role, 'author');
  assert.equal(t.startedSessions[0]?.input.model, 'claude-haiku-5-5');
  await t.engine.close();
});

test('a model that is the ticket\'s reviewer falls back to the configured author model', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, levers: levers('claude-sonnet-5-5') });
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.settled();
  assert.equal(t.startedSessions[0]?.input.model, 'claude-opus-5-5');
  await t.engine.close();
});
