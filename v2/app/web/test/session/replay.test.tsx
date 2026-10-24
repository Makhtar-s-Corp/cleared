// Resume from here as HTML (issue #272): every step of an author's thread
// whose branch the flow journaled offers it under its detail, a reviewer's
// steps and an author's without checkpoints do not, and the rows of a
// resume say where the ticket went on and came from, in fr and en.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, BASE_COMMIT, USER, sessionFixture, startReview } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { ResumeFrom, Timeline } from '../../screens/session/Session.tsx';
import type { TicketPart } from '../../screens/session/ticket.ts';
import { html, visibleText } from '../render.tsx';

const catalog = (language: 'en' | 'fr') => translator({ ...loadCatalog('shell', language), ...loadCatalog('session', language) });

function view(fixture = sessionFixture(FIXTURE_NOW, { review: 'later' })): SessionView {
  const parts: TicketPart[] = fixture.sessions.map((summary) => {
    const model = emptyModel();
    applyAll(model, fixture.store.events.after(summary.id));
    return { summary, thread: threadOf(model) };
  });
  const acting = parts.at(-1) as TicketPart;
  return {
    summary: acting.summary, thread: acting.thread as SessionView['thread'], parts, filter: 'all', ticket: fixture.ticket,
    siblings: parts.map((p) => p.summary), me: USER, language: 'en', now: FIXTURE_NOW, unfolded: new Set(parts.map((p) => p.summary.id)),
  };
}

const offered = (markup: string) => (markup.match(/data-act="resume_open"/g) ?? []).length;

test('each step of the author offers Resume from here; the reviewer\'s do not', () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  startReview(fixture);
  const markup = html(<Timeline view={view(fixture)} t={catalog('en')} />);
  const steps = (markup.match(/<details class="row step[^"]*" data-row="(read|edit|run|tool|channel)"/g) ?? []).length;
  const author = markup.slice(0, markup.indexOf('data-row="handover"'));
  const reviewer = markup.slice(markup.indexOf('data-row="handover"'));
  assert.equal(offered(author), (author.match(/<details class="row step[^"]*" data-row="(read|edit|run|tool|channel)"/g) ?? []).length, 'every step of the author');
  assert.ok(offered(author) >= 5);
  assert.equal(offered(reviewer), 0, 'none of the reviewer\'s');
  assert.ok(steps > offered(author));
  assert.match(visibleText(markup).join(' '), /Resume from here/);
});

test('an author whose branch the flow never journaled offers none', () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const plain = view(fixture);
  const parts = (plain.parts ?? []).map((part) => ({ ...part, thread: part.thread && { ...part.thread, checkpoints: [] } }));
  const markup = html(<Timeline view={{ ...plain, parts, thread: parts[0]?.thread as SessionView['thread'] }} t={catalog('en')} />);
  assert.equal((markup.match(/data-act="resume_open"/g) ?? []).length, 0);
});

test('the button and the resume rows are the catalog\'s, in fr and en', () => {
  for (const [language, button] of [['en', 'Resume from here'], ['fr', 'Reprendre d\'ici']] as const) {
    const markup = html(<ResumeFrom session={AUTHOR_ID} seq={12} commit={BASE_COMMIT} t={catalog(language)} />);
    assert.ok(visibleText(markup).includes(button), language);
  }
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const replay = { from: AUTHOR_ID, to: `${AUTHOR_ID}-r1`, seq: 12, commit: BASE_COMMIT, branch: 'cleared/LOCAL-161.r1', previous: 'cleared/LOCAL-161', by: USER, message: 'Group by ISO week.' };
  fixture.store.events.append({ at: FIXTURE_NOW.toISOString(), sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: fixture.project, event: { type: 'CUSTOM', name: 'cleared.replay', value: replay } });
  const resumed: SessionSummary = { ...(fixture.sessions[0] as SessionSummary), id: replay.to, phase: 'working', status: 'Working', startedAt: FIXTURE_NOW.toISOString() };
  fixture.store.events.append({ at: FIXTURE_NOW.toISOString(), sessionId: replay.to, ticket: 'LOCAL-161', project: fixture.project, event: { type: 'CUSTOM', name: 'cleared.replay', value: replay } });
  fixture.sessions.push(resumed);
  const markup = html(<Timeline view={view(fixture)} t={catalog('fr')} />);
  const fr = visibleText(markup).join(' ');
  // The continuation the resume left offers it no more: only the steps before the one resumed from.
  const seqs = [...markup.matchAll(/data-act="resume_open" data-seq="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(seqs.length > 0 && seqs.every((seq) => seq < replay.seq), JSON.stringify(seqs));
  assert.ok(fr.includes('Repris depuis une étape ci-dessus par vous : une nouvelle session continue plus bas, sur cleared/LOCAL-161.r1 depuis 3f1c9a0d2b7e.'));
  assert.ok(fr.includes('Repris par vous depuis une étape de la session précédente, sur cleared/LOCAL-161.r1 depuis 3f1c9a0d2b7e.'));
  assert.ok(fr.includes('Consigne corrigée'));
});
