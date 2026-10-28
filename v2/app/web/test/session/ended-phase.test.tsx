// Issue #233: an author given back, then ended, read "Working" on its
// screen, and on the real adapter "Stopped": the journal's last state is the
// Give back's snapshot, or the adapter's own delta when its runner stops,
// both later than nothing the screen could trust. The session's row is the
// word on an ended session; a live one keeps the journal's, which moves first.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AUTHOR_ID, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, phaseOf, phrase, statusTone, threadOf, type SessionView } from '../../screens/session/model.ts';
import type { SessionPhase, SessionSummary } from '../../../../src/api/types.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

function view(row: SessionPhase, journal: SessionPhase): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const thread = threadOf(model);
  const state = { ...(thread.state as NonNullable<typeof thread.state>), phase: journal, status: journal === 'working' ? 'Working' : 'Stopped' };
  return {
    summary: { ...(fixture.sessions[0] as SessionSummary), phase: row }, thread: { ...thread, state, pending: [] },
    ticket: fixture.ticket, siblings: fixture.sessions, me: 'demo-id', language: 'en', now: FIXTURE_NOW,
  };
}

test('an ended session reads the phase of its row, whatever the journal\'s last state says', () => {
  for (const journal of ['working', 'stopped', 'waiting_human'] as const) {
    const done = view('done', journal);
    assert.equal(phaseOf(done), 'done', `the journal at ${journal}`);
    assert.equal(statusTone(done), 'ended');
    assert.equal(phrase(done, en), en('status_done'));
    assert.equal(phrase(done, fr), fr('status_done'));
  }
  assert.equal(phaseOf(view('stopped', 'working')), 'stopped');
  assert.equal(phaseOf(view('failed', 'working')), 'failed');
});

test('a live session keeps the journal\'s phase, which moves before its row', () => {
  assert.equal(phaseOf(view('working', 'waiting_human')), 'waiting_human');
  assert.equal(phaseOf(view('waiting_human', 'working')), 'working');
  assert.equal(phaseOf(view('working', 'done')), 'done', 'an end the journal says first is shown at once');
});
