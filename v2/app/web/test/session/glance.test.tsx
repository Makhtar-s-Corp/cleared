// The session in five seconds (the owner's request of 2026-10-31, issue #499):
// which ticket, what the agent does now in one human sentence, where it is, the
// one thing it expects from the person, cost and duration, the result. Each
// wrong reading of the capture before this pass is a case here.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NextInboxItem, SessionSummary } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionThread, type SessionView } from '../../screens/session/model.ts';
import { doingNow, pendingAction, planSteps, pullRequestOf, resultOf, sessionFacts, stageOf } from '../../screens/session/glance.ts';
import { ActionCard, ResultCard, SessionHead, SideFacts, StageCard } from '../../screens/session/Glance.tsx';
import { Criteria } from '../../screens/session/Tabs.tsx';
import { html, visibleText } from '../render.tsx';

const fr: Translate = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const en: Translate = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });

const NOW = new Date('2026-10-31T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const TICKET = 'LOCAL-7';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's-author', project: 'p', ticket: TICKET, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working', status: 'Working', startedAt: at(30), updatedAt: at(1), lastSeq: 1, service: 'livre', ...over,
});
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: TICKET, title: 'Afficher la date', body: '', labels: [], project: 'p', status: 'In Progress', createdAt: at(40), updatedAt: at(1), services: [{ name: 'livre', branch: 'b', pr: null, state: 'open' }], ...over,
});

let seq = 0;
type Raw = { readonly type: string } & Record<string, unknown>;
const threadFrom = (session: string, events: readonly Raw[]): SessionThread => {
  const model = emptyModel();
  applyAll(model, events.map((event) => ({ seq: ++seq, at: at(5), sessionId: session, ticket: TICKET, event })) as never);
  return threadOf(model);
};
const toolCall = (id: string, name: string, input: unknown, output?: unknown): Raw[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(input) },
  ...(output === undefined ? [] : [{ type: 'TOOL_CALL_RESULT', toolCallId: id, content: JSON.stringify(output) }]),
];
const custom = (name: string, value: unknown): Raw => ({ type: 'CUSTOM', name, value });
const askOf = (requestId: string, command: string): Raw[] => [
  ...toolCall(`call-${requestId}`, 'Bash', { kind: 'execute', command }),
  custom('cleared.permission_request', { requestId, toolCallId: `call-${requestId}`, tool: 'Bash', input: { kind: 'execute', command }, suggestion: { decision: 'ask', rule: 'x', reason: 'y' } }),
];
const PLAN = { steps: ['Lire `Message`', 'Ajouter la **date**'], files: ['web/Message.tsx'], confidence: 'high', reason: 'petit', proposedAt: at(20) };

const view = (events: readonly Raw[], over: Partial<SessionView> = {}, own: Partial<SessionSummary> = {}): SessionView => {
  const s = summary(own);
  const thread = threadFrom(s.id, events);
  return { summary: s, thread, ticket: ticket(), siblings: [s], me: 'me', language: 'fr', now: NOW, parts: [{ summary: s, thread }], ...over };
};
const release = (over: Record<string, unknown> = {}) => ({
  id: 'release:LOCAL-7:12', kind: 'release', ticket: TICKET, project: 'p', since: at(2), state: 'waiting', title: 't', announcement: 'a', pr: { number: 12, url: 'https://forge.example/o/r/pull/12', checks: 'passed' }, heads: [], requestedAt: at(2), captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [], ...over,
}) as unknown as NextInboxItem;
const otherPlan = { id: 'session_plan:autre:1', kind: 'session_plan', ticket: 'LOCAL-9', project: 'p', since: at(1), state: 'waiting', sessionId: 'autre', plan: { ...PLAN, go: null } } as unknown as NextInboxItem;
const otherRelease = release({ id: 'release:LOCAL-9:3', ticket: 'LOCAL-9' });

// ------------------------------------------------------------- what it expects

test('nothing is expected of the person while the agent works, whatever waits on another ticket', () => {
  assert.equal(pendingAction(view(toolCall('c', 'Bash', { kind: 'execute', command: 'npm test' })), [otherPlan, otherRelease]), null);
});

test('a permission is the one action, with how many wait behind it, the oldest first', () => {
  const action = pendingAction(view([...askOf('r1', 'npm install a'), ...askOf('r2', 'npm install b')]), [otherPlan]);
  assert.equal(action?.kind, 'permission');
  assert.equal(action?.kind === 'permission' ? action.requestId : '', 'r1');
  assert.equal(action?.total, 2);
});

test('a permission of the ticket\'s reviewer is this ticket\'s too, answered on its own session', () => {
  const author = summary({ phase: 'done' });
  const reviewer = summary({ id: 's-review', role: 'reviewer', phase: 'waiting_human', startedAt: at(4) });
  const thread = threadFrom(reviewer.id, askOf('r9', 'npm test'));
  const action = pendingAction({ summary: reviewer, thread, ticket: ticket(), siblings: [author, reviewer], me: 'me', language: 'fr', now: NOW, parts: [{ summary: author, thread: threadFrom(author.id, []) }, { summary: reviewer, thread }] }, []);
  assert.equal(action?.kind === 'permission' ? action.session : '', 's-review');
});

test('a question is the one action', () => {
  const action = pendingAction(view([custom('cleared.question', { requestId: 'q1', questions: [{ question: 'Quel format ?', header: 'f', multiSelect: false, options: [] }] })]), []);
  assert.equal(action?.kind, 'question');
});

test('a plan waiting for its agreement is the one action, and no longer once given or once the session ended', () => {
  assert.equal(pendingAction(view([custom('cleared.session_plan', { ...PLAN, go: null })], {}, { phase: 'waiting_human' }), [])?.kind, 'plan');
  assert.equal(pendingAction(view([custom('cleared.session_plan', { ...PLAN, go: { by: 'me', at: at(1) } })]), []), null);
  assert.equal(pendingAction(view([custom('cleared.session_plan', { ...PLAN, go: null })], {}, { phase: 'failed' }), []), null);
});

test('a request of a session that ended is not asked any more; a session the watchdog stopped still asks it', () => {
  assert.equal(pendingAction(view(askOf('r1', 'npm test'), {}, { phase: 'failed' }), []), null);
  assert.equal(pendingAction(view(askOf('r1', 'npm test'), {}, { phase: 'stopped', dormant: true }), [])?.kind, 'permission');
});

test('a release of this ticket waiting in the inbox is the action, on the screen that signs it: the capture said "nothing"', () => {
  const action = pendingAction(view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' }), [otherRelease, release()]);
  assert.equal(action?.kind, 'review');
  assert.equal(action?.kind === 'review' ? action.href : '', '/inbox#release%3ALOCAL-7%3A12');
  assert.equal(action?.kind === 'review' ? action.pr?.number : 0, 12);
});

test('a handled release and another ticket\'s are never this session\'s action', () => {
  assert.equal(pendingAction(view([], {}, { phase: 'done' }), [release({ state: 'handled' }), otherRelease]), null);
});

test('a session taken over by the person asks them to give it back, before anything else', () => {
  const action = pendingAction(view(askOf('r1', 'npm test'), { takenOver: { by: 'me', at: at(1) } }), [release()]);
  assert.equal(action?.kind, 'giveback');
});

// --------------------------------------------------------------- the sentence

const NAMES = /npm|docker|sudo|web\/|\.tsx|\.json|Running|Reading|Paused|Bash/;

test('the sentence says what the agent does in the person\'s language: never a path, a command or the harness\'s English', () => {
  const cases: readonly [readonly Raw[], RegExp][] = [
    [toolCall('c', 'Bash', { kind: 'execute', command: 'npm test' }), /^L'agent est en train de lancer les tests du projet\.$/],
    [toolCall('c', 'Read', { kind: 'read', path: 'web/Message.tsx' }), /^L'agent lit le code\.$/],
    [toolCall('c', 'Edit', { kind: 'edit', path: 'web/Message.tsx', added: 1, removed: 0 }), /^L'agent modifie le code\.$/],
    [toolCall('c', 'Grep', { kind: 'search', pattern: 'Message' }), /^L'agent cherche dans le code\.$/],
    [toolCall('c', 'Bash', { kind: 'execute', command: 'docker ps' }), /^L'agent lance une commande\.$/],
    [toolCall('c', 'Bash', { kind: 'execute', command: 'sudo rm -rf /tmp/x' }), /^L'agent lance une commande\.$/],
    [[], /^L'agent travaille sur le ticket\.$/],
  ];
  for (const [events, expected] of cases) {
    const v = view(events, {}, { status: 'Running npm test' });
    const said = doingNow(v, fr);
    assert.match(said, expected);
    assert.doesNotMatch(said, NAMES);
  }
});

test('a command the person cannot read is not said by the agent\'s own description, which may be in another language', () => {
  const said = doingNow(view(toolCall('c', 'Bash', { kind: 'execute', command: 'frobnicate --all', description: 'Run the frobnicator on web/Message.tsx' })), fr);
  assert.equal(said, 'L\'agent lance une commande.');
});

test('the reviewer is named as such', () => {
  assert.equal(doingNow(view(toolCall('c', 'Read', { kind: 'read', path: 'a' }), {}, { id: 's-r', role: 'reviewer', phase: 'reviewing' }), fr), 'Le relecteur lit le code.');
});

test('what it waits for, how it ended: one sentence each, in both languages', () => {
  const waits = view(askOf('r1', 'npm install a'), {}, { phase: 'waiting_human' });
  assert.equal(doingNow(waits, fr), 'L\'agent attend votre accord pour continuer.');
  assert.equal(doingNow(waits, en), 'The agent is waiting for your agreement to go on.');
  assert.equal(doingNow(view([custom('cleared.session_plan', { ...PLAN, go: null })], {}, { phase: 'waiting_human' }), fr), 'L\'agent a préparé son plan et attend votre accord.');
  assert.equal(doingNow(view([custom('cleared.question', { requestId: 'q', questions: [] })], {}, { phase: 'waiting_human' }), fr), 'L\'agent vous pose une question.');
  assert.equal(doingNow(view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' }), fr), 'Le travail est prêt : il attend votre relecture.');
  assert.equal(doingNow(view([], { ticket: ticket({ status: 'In Review' }) }, { phase: 'done' }), fr), 'L\'auteur a fini : la relecture va commencer.');
  assert.equal(doingNow(view([], { ticket: ticket({ status: 'Ready to Ship' }) }, { phase: 'done' }), fr), 'Vous avez approuvé : la mise en production suit son cours.');
  assert.equal(doingNow(view([], { ticket: ticket({ status: 'Done' }) }, { phase: 'done' }), fr), 'Ce ticket est terminé.');
  assert.equal(doingNow(view([], {}, { phase: 'stopped' }), fr), 'La session a été arrêtée.');
  assert.equal(doingNow(view([], {}, { phase: 'starting' }), fr), 'La session démarre.');
  assert.equal(doingNow(view(askOf('r1', 'npm test'), {}, { phase: 'stopped', dormant: true }), fr), 'L\'agent attend votre accord pour continuer.');
  assert.equal(doingNow(view([], { takenOver: { by: 'me', at: at(1) } }), fr), 'Vous avez la main : l\'agent est en pause.');
  assert.equal(doingNow(view([], { takenOver: { by: 'other', at: at(1) } }), fr), 'Un collègue a la main : l\'agent est en pause.');
});

test('a failure says what happened in the person\'s words, never the service\'s English', () => {
  assert.equal(doingNow(view([{ type: 'RUN_ERROR', message: 'container exited', code: 'container_failed' }], {}, { phase: 'failed' }), fr), 'La session s\'est arrêtée : son conteneur n\'a pas pu rester en marche.');
  assert.equal(doingNow(view([{ type: 'RUN_ERROR', message: 'container gone', code: 'container_lost' }], {}, { phase: 'failed' }), fr), 'La session s\'est arrêtée : son conteneur a disparu.');
  assert.equal(doingNow(view([{ type: 'RUN_ERROR', message: 'Boom in web/x.ts' }], {}, { phase: 'failed' }), fr), 'La session s\'est arrêtée sur une erreur.');
});

// ------------------------------------------------------------------ the stage

const stage = (v: SessionView, inbox: readonly NextInboxItem[] = []) => {
  const found = stageOf(v, inbox);
  return found && { n: found.current, total: found.total, key: found.stages[found.current - 1]?.key, state: found.stages[found.current - 1]?.state };
};

test('where it is, out of the ticket\'s five stages, from what the service knows', () => {
  assert.deepEqual(stage(view([], {}, { phase: 'starting' })), { n: 1, total: 5, key: 'prepare', state: 'current' });
  assert.deepEqual(stage(view(toolCall('c', 'Read', { kind: 'read', path: 'a' }))), { n: 1, total: 5, key: 'prepare', state: 'current' });
  assert.deepEqual(stage(view([custom('cleared.session_plan', { ...PLAN, go: null })], {}, { phase: 'waiting_human' })), { n: 1, total: 5, key: 'prepare', state: 'current' });
  assert.deepEqual(stage(view([custom('cleared.session_plan', { ...PLAN, go: { by: 'delay', at: at(1) } })])), { n: 2, total: 5, key: 'write', state: 'current' });
  assert.deepEqual(stage(view(toolCall('c', 'Edit', { kind: 'edit', path: 'a', added: 1, removed: 0 }))), { n: 2, total: 5, key: 'write', state: 'current' });
  assert.deepEqual(stage(view([], {}, { role: 'reviewer', phase: 'reviewing' })), { n: 3, total: 5, key: 'review', state: 'current' });
  assert.deepEqual(stage(view([], { ticket: ticket({ status: 'In Review' }) }, { phase: 'done' })), { n: 3, total: 5, key: 'review', state: 'current' });
  assert.deepEqual(stage(view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' })), { n: 4, total: 5, key: 'decide', state: 'current' });
  assert.deepEqual(stage(view([], {}, { phase: 'done' }), [release()]), { n: 4, total: 5, key: 'decide', state: 'current' });
  assert.deepEqual(stage(view([], { ticket: ticket({ status: 'Ready to Ship' }) }, { phase: 'done' })), { n: 5, total: 5, key: 'ship', state: 'current' });
  assert.deepEqual(stage(view([], { ticket: ticket({ status: 'Done' }) }, { phase: 'done' })), { n: 5, total: 5, key: 'ship', state: 'done' });
});

test('a stage before the current one is done, one after it is to do, whatever another ticket\'s state', () => {
  const found = stageOf(view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' }), [otherRelease]);
  assert.deepEqual(found?.stages.map((s) => s.state), ['done', 'done', 'done', 'current', 'todo']);
  assert.deepEqual(stage(view([], {}, { phase: 'working' }), [otherRelease]), { n: 1, total: 5, key: 'prepare', state: 'current' });
});

test('a failure marks the stage it stopped at, even when the ticket went back to the queue', () => {
  const failed = view([...toolCall('c', 'Edit', { kind: 'edit', path: 'a', added: 1, removed: 0 }), { type: 'RUN_ERROR', message: 'x' }], { ticket: ticket({ status: 'Todo' }) }, { phase: 'failed' });
  assert.deepEqual(stage(failed), { n: 2, total: 5, key: 'write', state: 'failed' });
});

test('a session outside a ticket\'s path (the lead\'s, a reader\'s) has no stage', () => {
  assert.equal(stageOf(view([], {}, { role: 'lead' }), []), null);
  assert.equal(stageOf(view([], {}, { role: 'reader' }), []), null);
});

test('the plan\'s steps are read as sentences, never as raw Markdown', () => {
  assert.deepEqual(planSteps(PLAN), ['Lire Message', 'Ajouter la date']);
  assert.deepEqual(planSteps({ steps: ['- [ ] Voir [la doc](https://example.org)', '1. Puis *tester*', '## Finir'] }), ['Voir la doc', 'Puis tester', 'Finir']);
});

// -------------------------------------------------------------- cost, duration

test('the duration runs over the whole ticket and stops when its sessions ended', () => {
  const author = summary({ phase: 'done', startedAt: at(30), updatedAt: at(10) });
  const reviewer = summary({ id: 's-r', role: 'reviewer', phase: 'done', startedAt: at(10), updatedAt: at(4) });
  const ended: SessionView = { summary: reviewer, thread: threadFrom(reviewer.id, []), ticket: ticket(), siblings: [author, reviewer], me: 'me', language: 'fr', now: NOW, parts: [{ summary: author, thread: undefined }, { summary: reviewer, thread: undefined }] };
  assert.equal(sessionFacts(ended, fr).duration, '26 min');
  assert.equal(sessionFacts(view([]), fr).duration, '30 min');
});

test('the cost is the dollars the agents reported, else the tokens, never an estimate', () => {
  const base = { ticket: TICKET, sessions: 1, turns: 1, workMs: 1, elapsedMs: 1 };
  assert.match(sessionFacts(view([], { cost: { ...base, tokens: 48_200, costUsd: 0.84 } }), fr).cost ?? '', /0,84/);
  assert.match(sessionFacts(view([], { cost: { ...base, tokens: 48_200, costUsd: null } }), fr).cost ?? '', /48.200 jetons/);
  assert.equal(sessionFacts(view([], { cost: { ...base, tokens: null, costUsd: null } }), fr).cost, undefined);
  assert.equal(sessionFacts(view([], { cost: null }), fr).cost, undefined);
});

// ----------------------------------------------------------------- the result

const SERVICES = [{ name: 'livre', url: 'https://github.com/o/livre.git' }, { name: 'gl', url: 'https://gitlab.com/o/gl' }];

test('the pull request of a ticket: the release card\'s, else built as the service builds it, a GitLab one too', () => {
  assert.deepEqual(pullRequestOf(ticket(), SERVICES, [release()]), { number: 12, url: 'https://forge.example/o/r/pull/12' });
  assert.deepEqual(pullRequestOf(ticket({ services: [{ name: 'livre', branch: 'b', pr: 12, state: 'open' }] }), SERVICES, []), { number: 12, url: 'https://github.com/o/livre/pull/12' });
  assert.deepEqual(pullRequestOf(ticket({ services: [{ name: 'gl', branch: 'b', pr: 4, state: 'open' }] }), SERVICES, []), { number: 4, url: 'https://gitlab.com/o/gl/-/merge_requests/4' });
  assert.equal(pullRequestOf(ticket(), SERVICES, []), undefined);
  assert.equal(pullRequestOf(ticket({ services: [{ name: 'inconnu', branch: 'b', pr: 3, state: 'open' }] }), SERVICES, []), undefined);
  assert.equal(pullRequestOf(ticket({ services: [{ name: 'gl', branch: 'b', pr: 4, state: 'open' }] }), [{ name: 'gl', url: 'javascript:alert(1)' }], []), undefined);
  assert.deepEqual(pullRequestOf(ticket(), SERVICES, [otherRelease]), undefined);
});

test('the result: its pull request and its receipt, whichever session journaled the captures; nothing before the end', () => {
  const author = summary({ phase: 'done' });
  const reviewer = summary({ id: 's-r', role: 'reviewer', phase: 'done', startedAt: at(4) });
  const authorThread = threadFrom(author.id, [custom('cleared.proof_captured', { service: 'livre', before: 'before.png', after: 'after.png', missing: [] })]);
  const shipped = ticket({ status: 'Done', services: [{ name: 'livre', branch: 'b', pr: 12, state: 'open' }] });
  const done: SessionView = { summary: reviewer, thread: threadFrom(reviewer.id, []), ticket: shipped, siblings: [author, reviewer], me: 'me', language: 'fr', now: NOW, parts: [{ summary: author, thread: authorThread }, { summary: reviewer, thread: undefined }], production: [{ service: 'livre', pr: 12, url: 'https://x.example', at: at(1), file: 'production.png', missing: null }] };
  const result = resultOf(done, SERVICES, []);
  assert.deepEqual(result?.pr, { number: 12, url: 'https://github.com/o/livre/pull/12' });
  assert.deepEqual(result?.captures.map((c) => [c.kind, c.href]), [
    ['before', '/api/service/tickets/LOCAL-7/proof/livre/before.png'],
    ['after', '/api/service/tickets/LOCAL-7/proof/livre/after.png'],
    ['production', '/api/service/tickets/LOCAL-7/proof/livre/production.png'],
  ]);
  assert.equal(resultOf(view([]), SERVICES, []), null);
  assert.equal(resultOf(view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' }), SERVICES, [release()]), null, 'the action carries it while it waits');
});

test('a ticket done with no pull request says so, rather than draw an empty result', () => {
  const result = resultOf(view([], { ticket: ticket({ status: 'Done' }) }, { phase: 'done' }), SERVICES, []);
  assert.equal(result?.pr, undefined);
  assert.deepEqual(result?.captures, []);
});

// ------------------------------------------------------------------ the cards

const TOP_NAMES = /npm|docker|sudo|web\/|\.tsx|\.json|`|\*\*|##/;

test('what is read first holds no path, no command and no Markdown while the agent works', () => {
  const v = view([custom('cleared.session_plan', { ...PLAN, steps: ['Lire **le** composant', 'Ajouter la `date`'], go: { by: 'delay', at: at(1) } }), ...toolCall('c', 'Bash', { kind: 'execute', command: 'npm test' })], { ticket: ticket({ body: 'x' }) }, { status: 'Running npm test' });
  const top = html(<><SessionHead view={v} t={fr} /><StageCard stage={stageOf(v, [])!} view={v} t={fr} /><SideFacts facts={sessionFacts(v, fr)} t={fr} /></>);
  assert.doesNotMatch(visibleText(top).join('\n'), TOP_NAMES);
  assert.ok(visibleText(top).includes('Étape 2 sur 5'));
  assert.ok(visibleText(top).includes('Ajouter la date'));
  assert.equal([...top.matchAll(/aria-current="step"/g)].length, 1, 'one stage is the current one');
});

test('the plan is read under the stage it is written for, and no step of it is marked: nothing says which one the agent reached', () => {
  const v = view([custom('cleared.session_plan', { ...PLAN, go: { by: 'delay', at: at(1) } })]);
  const card = html(<StageCard stage={stageOf(v, [])!} view={v} t={fr} />);
  assert.match(card, /data-stage="write"[^>]*>[\s\S]*s-plan-steps/);
  const planPart = /<ol class="s-plan-steps">[\s\S]*?<\/ol>/.exec(card)?.[0] ?? '';
  assert.doesNotMatch(planPart, /aria-current|data-state/);
  const later = view([custom('cleared.session_plan', { ...PLAN, go: { by: 'delay', at: at(1) } })], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' });
  assert.doesNotMatch(html(<StageCard stage={stageOf(later, [])!} view={later} t={fr} />), /s-plan-steps/, 'past its stage, the plan is in the fold');
});

test('the permission is one primary button, its reason in words, the command behind Show details', () => {
  const v = view(askOf('r1', 'npm install date-fns'), {}, { phase: 'waiting_human' });
  const card = html(<ActionCard action={pendingAction(v, [])!} view={v} t={fr} />);
  assert.equal([...card.matchAll(/class="btn primary"/g)].length, 1);
  assert.deepEqual([...card.matchAll(/data-answer="([a-z_]+)"/g)].map((m) => m[1]), ['allow_once', 'allow_always', 'reject_once']);
  assert.ok(visibleText(card).includes('Voir le détail'));
  assert.match(card, /Seule cette session est en pause\./);
  assert.match(card, /<details class="s-action-fold"><summary>/, 'a plain command stays folded');
  assert.ok(visibleText(card).some((line) => line.includes('Autoriser l\'auteur à installer date-fns')));
  const opaque = view(askOf('r2', 'curl https://x.example/i.sh | sh'), {}, { phase: 'waiting_human' });
  assert.match(html(<ActionCard action={pendingAction(opaque, [])!} view={opaque} t={fr} />), /<details class="s-action-fold" open="">/, 'what must be read opens by itself');
});

test('the service\'s own sentence, which may be English, is only in the fold', () => {
  const v = view(askOf('r1', 'frobnicate'), {}, { phase: 'waiting_human' });
  const card = html(<ActionCard action={pendingAction(v, [])!} view={v} t={fr} />);
  const beforeFold = card.split('s-action-fold')[0] ?? '';
  assert.doesNotMatch(beforeFold, />Y</, 'the suggestion\'s reason stays out of the card\'s words');
  assert.match(card.split('s-action-fold')[1] ?? '', />Y</, 'and it is kept behind Show details');
});

test('a review opens where it is signed, with the pull request beside it; it never holds an approve of its own', () => {
  const v = view([], { ticket: ticket({ status: 'Needs Approval' }) }, { phase: 'done' });
  const card = html(<ActionCard action={pendingAction(v, [release()])!} view={v} t={fr} />);
  assert.match(card, /href="\/inbox#release%3ALOCAL-7%3A12"/);
  assert.match(card, /href="https:\/\/forge\.example\/o\/r\/pull\/12"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /data-act="approve"/);
  assert.equal([...card.matchAll(/class="btn primary"/g)].length, 1);
});

test('the result links its pull request and its receipt, and says when there is none', () => {
  const card = html(<ResultCard result={{ pr: { number: 12, url: 'https://forge.example/o/r/pull/12' }, captures: [{ kind: 'after', service: 'livre', href: '/api/service/tickets/LOCAL-7/proof/livre/after.png' }] }} t={fr} />);
  assert.ok(visibleText(card).includes('Pull request n° 12'));
  assert.ok(visibleText(card).includes('Capture après'));
  assert.ok(visibleText(html(<ResultCard result={{ captures: [] }} t={fr} />)).includes('Ce ticket n\'a pas ouvert de pull request.'));
});

test('a failure back in the queue says so under its sentence', () => {
  const v = view([{ type: 'RUN_ERROR', message: 'x', code: 'container_failed' }], { ticket: ticket({ status: 'Todo' }) }, { phase: 'failed' });
  assert.ok(visibleText(html(<SessionHead view={v} t={fr} />)).includes('Son ticket est revenu dans la file.'));
});

test('a criterion is read as a sentence, its Markdown gone', () => {
  const v = view([], { ticket: ticket({ body: '- [ ] `npm test` passe\n- [x] La **date** s\'affiche' }) });
  const text = visibleText(html(<Criteria view={v} t={fr} />));
  assert.ok(text.includes('npm test passe'));
  assert.ok(text.includes('La date s\'affiche'));
});
