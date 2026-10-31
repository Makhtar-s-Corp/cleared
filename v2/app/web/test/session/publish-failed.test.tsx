// A session whose publication failed (issue #507): the screen says that the review
// passed and the publication failed, why and what to do, in the person's words;
// the reason as it came is in the fold; the stages do not stay on one in progress.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { PUBLISH_FAILURES } from '../../../../src/flow/publish-failure.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionThread, type SessionView } from '../../screens/session/model.ts';
import { doingNow, pendingAction, publishFailureOf, stageOf } from '../../screens/session/glance.ts';
import { ActionCard, SessionHead, StageCard } from '../../screens/session/Glance.tsx';
import { html, visibleText } from '../render.tsx';

const fr: Translate = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const en: Translate = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const NOW = new Date('2026-10-31T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const TICKET = 'LOCAL-7';
const DETAIL = 'git push failed: remote: Permission denied. The requested URL returned error: 403';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's-reviewer', project: 'p', ticket: TICKET, role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', phase: 'done', status: 'Done', startedAt: at(10), updatedAt: at(1), lastSeq: 1, service: 'livre', ...over,
});
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: TICKET, title: 'Afficher la date', body: '', labels: [], project: 'p', status: 'Todo', createdAt: at(40), updatedAt: at(1), services: [{ name: 'livre', branch: null, pr: null, state: 'open' }], ...over,
});
let seq = 0;
const threadOfEvents = (session: string, events: readonly { minutes: number; event: Record<string, unknown> }[]): SessionThread => {
  const model = emptyModel();
  applyAll(model, events.map(({ minutes, event }) => ({ seq: ++seq, at: at(minutes), sessionId: session, ticket: TICKET, event })) as never);
  return threadOf(model);
};
const failure = (code: string, minutes = 2) => ({ minutes, event: { type: 'CUSTOM', name: 'cleared.publish_failed', value: { code, service: null, detail: DETAIL } } });
const view = (events: readonly { minutes: number; event: Record<string, unknown> }[], over: Partial<SessionView> = {}): SessionView => {
  const s = summary();
  const thread = threadOfEvents(s.id, events);
  return { summary: s, thread, ticket: ticket(), siblings: [s], me: 'me', language: 'fr', now: NOW, parts: [{ summary: s, thread }], ...over } as SessionView;
};

test('the head says it in one sentence: the review passed and the publication failed, and the ticket is back in the queue', () => {
  const failed = view([failure('token_denied')]);
  assert.match(doingNow(failed, fr), /relecture a réussi.*publication a échoué/i);
  assert.match(doingNow({ ...failed, language: 'en' }, en), /review passed.*publication failed/i);
  const text = visibleText(html(<SessionHead view={failed} t={fr} />)).join(' ');
  assert.match(text, /revenu dans la file/);
  assert.doesNotMatch(text, /Cette session est terminée/);
});

test('the action: why, in human words, what to do, the reason as it came behind "Voir le détail"', () => {
  const failed = view([failure('token_denied')]);
  const action = pendingAction(failed, []);
  assert.equal(action?.kind, 'publish');
  const markup = html(<ActionCard action={action as never} view={failed} t={fr} />);
  const [front, fold] = markup.split('<details');
  assert.match(front ?? '', /jeton/);
  assert.match(front ?? '', /href="\/setup\/forge"/);
  assert.ok(!(front ?? '').includes(DETAIL), 'the raw reason is not on the screen');
  assert.ok((fold ?? '').includes(DETAIL), 'it is in the fold');
  assert.match(markup, /Voir le détail/);
});

test('every cause has its own words in both languages, and an action', () => {
  for (const code of PUBLISH_FAILURES) {
    for (const t of [fr, en]) {
      const failed = view([failure(code)]);
      const markup = html(<ActionCard action={pendingAction(failed, []) as never} view={failed} t={t} />);
      assert.doesNotMatch(markup, /⟦/, `${code}: no missing key`);
      assert.doesNotMatch(markup, /\u2014/, `${code}: no em dash`);
      assert.match(markup, /data-act="publish_restart"/, code);
    }
  }
  const taken = view([failure('branch_taken')]);
  const denied = view([failure('token_denied')]);
  assert.notEqual(html(<ActionCard action={pendingAction(taken, []) as never} view={taken} t={fr} />), html(<ActionCard action={pendingAction(denied, []) as never} view={denied} t={fr} />));
});

test('the action is a real gesture: the ticket starts again from here, and what stops it is said', () => {
  const failed = view([failure('network')]);
  const action = pendingAction(failed, []);
  const markup = html(<ActionCard action={action as never} view={failed} t={fr} onRestart={() => undefined} />);
  assert.match(markup, /data-act="publish_restart"[^>]*>Relancer le ticket/);
  assert.doesNotMatch(markup, /data-act="publish_token"/, 'only a token\'s failure sends to the token');
  assert.match(html(<ActionCard action={action as never} view={failed} t={fr} restarting />), /disabled/);
  assert.match(html(<ActionCard action={action as never} view={failed} t={fr} restartNote="Le ticket n'a pas pu repartir." />), /role="alert"/);
});

test('the stages: the review is done, the publication is where it stopped, and nothing is in progress', () => {
  const failed = view([failure('token_denied')]);
  const stage = stageOf(failed, []);
  assert.deepEqual(stage?.stages.map((one) => [one.key, one.state]), [['prepare', 'done'], ['write', 'done'], ['review', 'done'], ['publish', 'failed'], ['ship', 'todo']]);
  assert.equal(stage?.current, 4);
  const text = visibleText(html(<StageCard stage={stage as never} view={failed} t={fr} />)).join(' ');
  assert.match(text, /Publication/);
  assert.match(text, /arrêtée ici/);
  assert.doesNotMatch(text, /en cours/);
});

test('any session ended on a ticket back in Todo: no stage stays in progress', () => {
  const ended = view([]);
  const stage = stageOf(ended, []);
  assert.ok(stage?.stages.every((one) => one.state !== 'current'), JSON.stringify(stage?.stages));
  assert.equal(publishFailureOf(ended), null);
});

test('an old failure is not said once the ticket moved on: it runs again, or a later session started', () => {
  assert.equal(publishFailureOf(view([failure('token_denied')], { ticket: ticket({ status: 'In Progress' }) })), null);
  assert.equal(pendingAction(view([failure('token_denied')], { ticket: ticket({ status: 'In Progress' }) }), []), null);
  const earlier = { summary: summary(), thread: threadOfEvents('s-reviewer', [failure('token_denied', 3)]) };
  const later = { summary: summary({ id: 's-author-2', role: 'author', startedAt: at(1), phase: 'failed' }), thread: threadOfEvents('s-author-2', []) };
  assert.equal(publishFailureOf(view([], { parts: [earlier, later] })), null);
});

test('the author\'s session of the same ticket says it too', () => {
  const reviewerPart = { summary: summary(), thread: threadOfEvents('s-reviewer', [failure('token_denied')]) };
  const own = summary({ id: 's-author', role: 'author', startedAt: at(30) });
  const thread = threadOfEvents('s-author', []);
  const author = view([], { summary: own, thread, parts: [{ summary: own, thread }, reviewerPart] });
  assert.equal(publishFailureOf(author)?.code, 'token_denied');
  assert.equal(pendingAction(author, [])?.kind, 'publish');
});
