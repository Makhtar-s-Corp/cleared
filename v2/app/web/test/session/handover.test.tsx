// The Hand over button of the composer as HTML, in both languages (matrix
// B6.3, P153): it names the other harness, carries its target, and is off,
// with its reason, where the service would refuse.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { Composer } from '../../screens/session/Session.tsx';
import { visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

function composer(summary: Partial<SessionSummary>, t = en, props: { handing?: boolean; takenOver?: SessionView['takenOver'] } = {}): string {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const view: SessionView = {
    summary: { ...(fixture.sessions[0] as SessionSummary), ...summary }, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions,
    me: USER, language: 'en', now: FIXTURE_NOW, ...(props.takenOver !== undefined ? { takenOver: props.takenOver } : {}),
  };
  return renderToStaticMarkup(<Composer view={view} t={t} handing={props.handing ?? false} />);
}

test('the button names the other harness, in English and in French, and carries its target', () => {
  const toCodex = composer({ harness: 'claude-code' });
  assert.match(toCodex, /<button[^>]*id="handover"[^>]*data-to="codex"/);
  assert.ok(visibleText(toCodex).includes('Hand over to Codex'));
  assert.ok(visibleText(composer({ harness: 'codex' })).includes('Hand back to Claude Code'));
  assert.match(composer({ harness: 'codex' }), /data-to="claude-code"/);
  assert.ok(visibleText(composer({ harness: 'claude-code' }, fr)).includes('Confier à Codex'));
  assert.ok(visibleText(composer({ harness: 'codex' }, fr)).includes('Confier à Claude Code'));
});

test('the button is off, with its reason, for Cursor, a reviewer and a session taken over (an ended one: app/test/session/handover.test.ts); it is disabled while the gesture runs', () => {
  const reason = 'Only a live author\'s session is handed over, when nobody has taken it over.';
  for (const html of [
    composer({ harness: 'cursor' }), composer({ role: 'reviewer' }),
    composer({}, en, { takenOver: { by: USER, at: FIXTURE_NOW.toISOString() } }),
  ]) {
    assert.match(html, /<button[^>]*id="handover"[^>]*aria-disabled="true"/);
    assert.doesNotMatch(html, /id="handover"[^>]*data-to/);
    assert.ok(visibleText(html).includes(reason));
  }
  assert.match(composer({ harness: 'claude-code' }, en, { handing: true }), /<button[^>]*id="handover"[^>]*disabled/);
});
