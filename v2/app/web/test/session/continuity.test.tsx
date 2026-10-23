// The session view follows the ticket, as HTML (docs/v2/ui-overhaul-plan.md,
// 2.3 and U6, U7, lane 36): the fixtures source's LOCAL-152, its author done
// and its reviewer reviewing, drawn as one thread with a handover row; the
// steps as rows that open their detail (a command said by its intent, its
// raw command folded; consecutive edits of one file as one row); the checks
// said by their intent; empty cards left out; Take over on the ticket's
// live session whatever its role, through pull request 242's takeoverOf;
// the Editor's last turn beside all changes; and a thread agent whose
// stream pauses while its view is hidden.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import type { SessionEvent } from '../../../../src/session/events.ts';
import { ENVELOPE_AUTHOR_ID, ENVELOPE_BODY, ENVELOPE_TICKET, USER, envelopeStory } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { SessionAgent } from '../../screens/session/agent.ts';
import { applyAll, emptyModel, threadOf, type SessionView, type StreamLike } from '../../screens/session/model.ts';
import { LeftCards, RightCards, StatusHead, Timeline } from '../../screens/session/Session.tsx';
import { EditorTab, TakeoverButton } from '../../screens/session/Tabs.tsx';
import { takeoverOf } from '../../screens/session/tabs.ts';
import { actingSession, type TicketPart } from '../../screens/session/ticket.ts';
import { html, renderIndex, visibleText } from '../render.tsx';

const catalog = (language: 'en' | 'fr') => translator({ ...loadCatalog('shell', language), ...loadCatalog('session', language) });
const en = catalog('en');
const fr = catalog('fr');

const REVIEWER: SessionSummary = {
  id: 'fixture-2', project: 'guestbook', ticket: ENVELOPE_TICKET, role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', phase: 'reviewing',
  status: 'Reading the diff of src/screens/Envelope.jsx', startedAt: new Date(FIXTURE_NOW.getTime() - 4 * 60_000).toISOString(), updatedAt: FIXTURE_NOW.toISOString(), lastSeq: 1,
};

function ticketView(overrides: Partial<SessionView> = {}): SessionView {
  const story = envelopeStory(FIXTURE_NOW, REVIEWER);
  const thread = (id: string, events: readonly SessionEvent[]) => {
    const model = emptyModel();
    applyAll(model, events.filter((e) => e.sessionId === id));
    return threadOf(model);
  };
  const parts: TicketPart[] = [
    { summary: story.author, thread: thread(ENVELOPE_AUTHOR_ID, story.store.events.after(ENVELOPE_AUTHOR_ID)) },
    { summary: REVIEWER, thread: thread(REVIEWER.id, story.store.events.after(REVIEWER.id)) },
  ];
  const sessions = parts.map((p) => p.summary);
  const acting = actingSession(sessions, ENVELOPE_AUTHOR_ID) as SessionSummary;
  return {
    summary: acting, thread: parts.find((p) => p.summary.id === acting.id)?.thread as SessionView['thread'], parts, filter: 'all',
    ticket: { id: ENVELOPE_TICKET, title: 'Envelope sheet shows its previous months', body: ENVELOPE_BODY, labels: [], project: 'guestbook', status: 'In Review', createdAt: '', updatedAt: '' },
    siblings: sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides,
  };
}

test('one thread of the ticket: the author\'s steps, the handover row, the reviewer\'s steps, live', () => {
  const view = ticketView();
  assert.equal(view.summary.id, REVIEWER.id, 'the view acts on the reviewer: it runs');
  const markup = html(<Timeline view={view} t={en} />);
  const rows = [...markup.matchAll(/data-row="([a-z]+)"/g)].map((m) => m[1]);
  const handover = rows.indexOf('handover');
  assert.ok(handover > 0, 'a handover row, after the author\'s rows');
  assert.deepEqual(rows.slice(handover), ['handover', 'run', 'run', 'read'], 'then the reviewer\'s');
  assert.ok(visibleText(markup).includes('Sonnet started the review at 09:37. The author\'s work is above.'));
  assert.ok(visibleText(html(<Timeline view={view} t={fr} />)).includes('Sonnet a commencé la relecture à 09:37. Le travail de l\'auteur est au-dessus.'));
  const status = visibleText(html(<StatusHead view={view} t={en} />));
  assert.deepEqual(status.slice(0, 1), ['Reading the diff of src/screens/Envelope.jsx']);
  assert.deepEqual([status[1], /^4 min/.test(status[2] ?? '')], ['Reviewer · Sonnet ·', true], 'the status says whose it is when the ticket has two');
});

test('each step opens its detail: a command said by its intent, the command folded one a line; two edits of one file as one row', () => {
  const markup = html(<Timeline view={ticketView()} t={en} onFile={() => {}} />);
  assert.match(markup, /<details class="row step" data-row="run"><summary>/);
  const text = visibleText(markup);
  assert.ok(text.includes('List files and run the tests'), 'the reviewer\'s compound command, each class once');
  assert.ok(text.includes('Read the repository\'s history and diff'));
  assert.ok(text.includes('Commit the changes'));
  for (const line of ['ls node_modules >/dev/null 2>&1', 'npm test 2>&1', 'tail -8', 'npm run typecheck 2>&1', 'tail -5']) assert.ok(text.some((t) => t.endsWith(line)), `folded: ${line}`);
  assert.match(markup, /<span class="op">&amp;&amp; <\/span>npm test 2&gt;&amp;1/);
  const edits = /<details class="row step" data-row="edit"><summary>[\s\S]*?<\/details>/.exec(markup)?.[0] ?? '';
  assert.ok(visibleText(edits).some((line) => line.endsWith('2 edits')), 'the two edits of the sheet in a row are one row');
  assert.ok(visibleText(edits).includes('+14'));
  assert.match(edits, /data-act="open_diff"/, 'the detail opens the change in the Editor');
  assert.match(markup, /data-act="open_file"/, 'a read path opens the file');
});

test('the checks: a check named by its command is said by its intent, the command folded; the ticket\'s checks go on', () => {
  const markup = html(<RightCards view={ticketView()} t={en} />);
  const checks = /<ul class="checks">[\s\S]*?<\/ul>/.exec(markup)?.[0] ?? '';
  const text = visibleText(checks);
  assert.deepEqual(text.filter((line) => !line.startsWith('·') && !/[|&]|^npm|^git|^tail/.test(line)), ['Run the project\'s tests', 'Commit the changes', 'Review']);
  assert.equal([...checks.matchAll(/<details>/g)].length, 2, 'two checks named by commands, folded');
  assert.ok(text.includes('npm test 2>&1') && text.includes('tail -8'), 'the raw command, one a line');
  const changes = visibleText(/<ul class="changes">[\s\S]*?<\/ul>/.exec(markup)?.[0] ?? '');
  assert.deepEqual(changes, ['src/screens/Envelope.jsx', '+15', '−2', 'test/envelope.test.mjs', '+13'], 'the ticket\'s changes, the author\'s');
  assert.ok(visibleText(markup).includes('Review'), 'the time by step adds up the review');
});

test('a card with nothing to say is not drawn: no criteria, no plan, the ticket card alone', () => {
  const view = ticketView();
  const left = html(<LeftCards view={view} t={en} />);
  assert.equal([...left.matchAll(/<section class="card"/g)].length, 2, 'the ticket and its criteria; no session plan on this ticket');
  const bare = html(<LeftCards view={{ ...view, ticket: { ...view.ticket!, body: 'Only words.' } }} t={en} />);
  assert.equal([...bare.matchAll(/<section class="card"/g)].length, 1);
  assert.ok(!visibleText(bare).some((line) => /no criteria|No session plan/.test(line)));
});

test('Take over is offered on the ticket\'s live session whatever its role, through takeoverOf as pull request 242 left it', () => {
  const view = ticketView();
  const offer = (summary: SessionSummary) => html(<TakeoverButton t={en} takeover={takeoverOf({ takenOver: summary.takenOver, me: USER, role: summary.role, ended: false })} />);
  assert.match(offer(view.summary), /id="takeover"/, 'on the reviewer');
  assert.match(offer({ ...view.summary, role: 'author' }), /id="takeover"/, 'on an author');
  const mine = { ...view.summary, takenOver: { by: USER, at: FIXTURE_NOW.toISOString() } };
  assert.match(offer(mine), /id="giveback"/, 'given back by the one who took it');
  assert.equal(html(<TakeoverButton t={en} takeover={takeoverOf({ takenOver: null, me: USER, role: 'author', ended: true })} />), '', 'an ended session is nobody\'s');
});

test('the Editor holds the ticket\'s changes, or its last turn\'s', () => {
  const files = [{ path: 'src/screens/Envelope.jsx', added: 15, removed: 2 }, { path: 'test/envelope.test.mjs', added: 13, removed: 0 }];
  const all = html(<EditorTab t={en} files={files} mode="diff" scope={{ value: 'all', all: 2, last: 1 }} />);
  assert.deepEqual([...all.matchAll(/data-scope="([a-z]+)" aria-pressed="(true|false)"/g)].map((m) => [m[1], m[2]]), [['all', 'true'], ['last', 'false']]);
  assert.ok(visibleText(all).includes('All changes') && visibleText(all).includes('Last turn'));
  const last = html(<EditorTab t={fr} files={files.slice(0, 1)} mode="diff" scope={{ value: 'last', all: 2, last: 1 }} />);
  assert.match(last, /data-scope="last" aria-pressed="true"/);
  assert.ok(visibleText(last).includes('Dernier tour'));
  assert.match(html(<EditorTab t={en} files={files} mode="diff" scope={{ value: 'all', all: 2, last: 0 }} />), /data-scope="last" aria-pressed="false" disabled=""/, 'no turn changed a file yet');
});

test('every word of the ticket view comes from the catalogs, French included', () => {
  const view = ticketView();
  const sentinel: Translate = (key) => `«${key}»`;
  const words = (t: Translate) => [html(<Timeline view={view} t={t} />), html(<RightCards view={view} t={t} />), html(<LeftCards view={view} t={t} />), html(<StatusHead view={view} t={t} />)].flatMap(visibleText);
  assert.ok(words(sentinel).some((line) => line.includes('«handover_reviewer»')));
  const french = words(fr).join('\n');
  for (const english of ['started the review', 'Read the repository', 'Commit the changes', 'edits', 'Show the changes']) assert.ok(!french.includes(english), english);
  assert.doesNotMatch(french, /⟦/);
});

// A stand-in for EventSource: the URLs opened, and whether each is closed.
function streams() {
  const opened: { url: string; closed: boolean; hear?: (event: { data: string }) => void }[] = [];
  return {
    opened,
    open: (url: string): StreamLike => {
      const entry: (typeof opened)[number] = { url, closed: false };
      opened.push(entry);
      return { addEventListener: (_name, listener) => { entry.hear ??= listener; }, close: () => { entry.closed = true; }, onerror: null };
    },
  };
}

test('a thread\'s stream pauses while its view is hidden, and goes on after the last event it read', () => {
  const stream = streams();
  const agent = new SessionAgent({ sessionId: 's1', open: stream.open, later: () => {} });
  const published: number[] = [];
  const stop = (agent as unknown as { follow(publish: (state: { lastSeq: number }) => void): () => void }).follow((state) => { published.push(state.lastSeq); });
  assert.equal(stream.opened.length, 1);
  stream.opened[0]?.hear?.({ data: JSON.stringify({ seq: 3, at: FIXTURE_NOW.toISOString(), sessionId: 's1', ticket: 'T', project: 'p', event: { type: 'RUN_STARTED', threadId: 's1', runId: 'r' } }) });
  agent.setOpen(false);
  assert.ok(stream.opened[0]?.closed, 'hidden: no connection held');
  assert.equal(agent.streaming, false);
  agent.setOpen(true);
  assert.equal(stream.opened.length, 2);
  assert.match(stream.opened[1]?.url ?? '', /\/sessions\/s1\/events\?after=3$/, 'shown again: from the last event read');
  stop();
  assert.ok(stream.opened[1]?.closed);
  // Made closed (a hidden view, an ended session read already): no connection at all until opened.
  const quiet = streams();
  const closed = new SessionAgent({ sessionId: 's2', open: quiet.open, later: () => {}, streaming: false });
  const end = (closed as unknown as { follow(publish: () => void): () => void }).follow(() => {});
  assert.equal(quiet.opened.length, 0);
  closed.setOpen(true);
  assert.equal(quiet.opened.length, 1);
  end();
});

test('the whole ticket folds an ended session a later one followed into one row, unless the view saw it live or a filter shows it', () => {
  const view = ticketView();
  const markup = html(<Timeline view={view} t={en} />);
  const fold = /<details class="earlier" data-session="([^"]+)"><summary>[\s\S]*?<span>([^<]+)<\/span><\/summary>/.exec(markup);
  assert.equal(fold?.[1], ENVELOPE_AUTHOR_ID);
  assert.match(fold?.[2] ?? '', /^Author · Opus · \d+ steps$/);
  assert.ok(markup.indexOf('class="earlier"') < markup.indexOf('data-row="handover"'), 'folded above the handover row');
  assert.doesNotMatch(html(<Timeline view={{ ...view, unfolded: new Set([ENVELOPE_AUTHOR_ID]) }} t={en} />), /class="earlier"/, 'seen live: never folded under the person\'s eyes');
  assert.doesNotMatch(html(<Timeline view={{ ...view, filter: 'author' }} t={en} />), /class="earlier"/);
  assert.match(html(<Timeline view={view} t={fr} />), /Auteur · Opus · \d+ étapes/);
});

test('the sessions index has one card per ticket: the session its view acts on', () => {
  const view = ticketView();
  const markup = renderIndex({ sessions: view.siblings, tickets: [view.ticket!], now: FIXTURE_NOW }, en);
  assert.equal([...markup.matchAll(/class="session-card"/g)].length, 1);
  assert.match(markup, /href="\/sessions\/fixture-2"/);
  assert.ok(visibleText(markup).includes('Reviewer'));
});
