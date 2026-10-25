// The mirrors' conflict rule (P230, docs/v2/mirrors.md): against the state
// both sides last agreed on, the side that changed wins; when both changed,
// a person's change beats an agent's whatever the times, the later of two
// people's wins, and the app's wins between two agents or at the same time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Side } from '../../src/tickets/mirror.ts';

const side = (status: string, kind: Side['kind'], at: string): Side => ({ status, kind, at });
const T1 = '2026-10-25T09:00:01.000Z';
const T2 = '2026-10-25T09:00:02.000Z';

test('nothing changed on either side: nothing to do', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('Todo', 'agents', T1), remote: side('Todo', 'human', T2) }), 'none');
});

test('one side changed: it is written on the other, whoever made it', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('In Progress', 'agents', T2), remote: side('Todo', 'human', T1) }), 'push');
  assert.equal(decide({ agreed: 'Todo', local: side('Todo', 'human', T2), remote: side('In Review', 'agents', T1) }), 'pull');
  assert.equal(decide({ agreed: 'Todo', local: side('Todo', 'agents', T2), remote: side('Done', 'human', T1) }), 'pull');
});

test('both changed to the same state: they agree', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('Done', 'agents', T1), remote: side('Done', 'human', T2) }), 'agree');
});

test('a person beats an agent, even when the agent came later', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('In Review', 'agents', T2), remote: side('Todo', 'human', T1) }), 'push',
    'the tracker is in the agreed state: it did not change, so there is no conflict and the agent\'s move is written');
  assert.equal(decide({ agreed: 'In Progress', local: side('In Review', 'agents', T2), remote: side('Todo', 'human', T1) }), 'pull');
  assert.equal(decide({ agreed: 'In Progress', local: side('Todo', 'human', T1), remote: side('Done', 'agents', T2) }), 'push');
});

test('between two people the later wins; at the same time the app wins', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('In Review', 'human', T1), remote: side('Done', 'human', T2) }), 'pull');
  assert.equal(decide({ agreed: 'Todo', local: side('In Review', 'human', T2), remote: side('Done', 'human', T1) }), 'push');
  assert.equal(decide({ agreed: 'Todo', local: side('In Review', 'human', T1), remote: side('Done', 'human', T1) }), 'push');
});

test('between two agents the app wins, whatever the times', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('In Review', 'agents', T1), remote: side('Done', 'agents', T2) }), 'push');
});

test('a remote state the app does not have is no change', () => {
  assert.equal(decide({ agreed: 'Todo', local: side('In Progress', 'agents', T1), remote: null }), 'push');
  assert.equal(decide({ agreed: 'Todo', local: side('Todo', 'agents', T1), remote: null }), 'none');
});
