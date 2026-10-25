// The address follows the ticket's live session (docs/v2/ui-overhaul-plan.md,
// 2.3.2, lane 36): when the reviewer starts, the view replaces the address
// by the reviewer's without a navigation, and the shell must find the same
// kept view there, never make a second one. A view says which other
// sessions of its ticket it draws (keepWith); the shell's place then names
// that view's session and address, so its stack, its scroll and its focus
// see no move. The first view of a ticket keeps its sessions until it is
// dropped from the stack (forgetView).
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetView, keepWith, placeOf } from '../../web/lib/routes.ts';

test('a session another view draws is placed on that view; forgetting the view places it on its own again', () => {
  assert.deepEqual(placeOf('/sessions/reviewer-1'), { screen: 'session', path: '/sessions/reviewer-1', session: 'reviewer-1' });
  keepWith('reviewer-1', 'author-1');
  assert.deepEqual(placeOf('/sessions/reviewer-1'), { screen: 'session', path: '/sessions/author-1', session: 'author-1' });
  assert.deepEqual(placeOf('/sessions/author-1'), { screen: 'session', path: '/sessions/author-1', session: 'author-1' });
  // The first view of the ticket keeps it: a second view does not take its sessions, nor is it moved itself.
  keepWith('reviewer-1', 'other-view');
  keepWith('author-1', 'reviewer-1');
  assert.equal(placeOf('/sessions/reviewer-1')?.session, 'author-1');
  assert.equal(placeOf('/sessions/author-1')?.session, 'author-1');
  keepWith('author-1', 'author-1');
  assert.equal(placeOf('/sessions/author-1')?.session, 'author-1', 'a view is not kept with itself');
  forgetView('author-1');
  assert.equal(placeOf('/sessions/reviewer-1')?.session, 'reviewer-1');
  assert.deepEqual(placeOf('/inbox'), { screen: 'inbox', path: '/inbox' });
});
