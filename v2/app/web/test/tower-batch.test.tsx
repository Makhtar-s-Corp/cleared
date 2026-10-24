// Batches in the tower (requirement C6): a "Batch" chip in the bar opens a
// form, one ticket per line (2 to 20, each line refused in the page before
// any call); the batches under way are a card of the side, each with its
// count, what holds the queue (a lane to wait for, or the quota stop), and
// each ticket's state, in French and in English.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Batch } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { resourceOf, touchedBy } from '../lib/cache.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { BatchCards, BatchForm, Bar } from '../screens/tower/Tower.tsx';
import { BATCH_LINES_MAX, BATCH_LINES_MIN, batchBody, batchFailure, batchLine, batchLines, batchRows, holdLine } from '../screens/tower/model.ts';
import { ApiError } from '../lib/screen.ts';
import { html, visibleText } from './render.tsx';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('tower', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('tower', 'fr') });

const item = (position: number, state: 'queued' | 'started' | 'failed', status: string, note: string | null = null) =>
  ({ position, ticket: `LOCAL-${200 + position}`, title: `Ticket ${position}`, state, status, note }) as const;

const waiting: Batch = {
  id: 'batch-2', project: 'guestbook', by: 'owner', at: '2026-10-24T10:00:00.000Z', lanes: 3, running: 3,
  hold: { reason: 'lanes', running: 3, lanes: 3 },
  items: [item(1, 'started', 'In Progress'), item(2, 'started', 'In Review'), item(3, 'failed', 'Todo', 'the clone failed'), item(4, 'queued', 'Todo'), item(5, 'queued', 'Todo')],
};
const stopped: Batch = {
  id: 'batch-1', project: 'guestbook', by: 'owner', at: '2026-10-24T09:00:00.000Z', lanes: 3, running: 0,
  hold: { reason: 'quota', window: 'seven_day', percent: 86, stop: 85 },
  items: [item(1, 'queued', 'Todo'), item(2, 'queued', 'Todo')],
};
const finished: Batch = {
  id: 'batch-0', project: 'guestbook', by: 'owner', at: '2026-10-23T09:00:00.000Z', lanes: 3, running: 1, hold: null,
  items: [item(1, 'started', 'Needs Approval'), item(2, 'started', 'In Progress')],
};

test('the lines of the form: blank ones skipped, 2 to 20 tickets, each of at most 200 characters', () => {
  assert.deepEqual([BATCH_LINES_MIN, BATCH_LINES_MAX], [2, 20]);
  assert.deepEqual(batchLines(' Add a page \n\nSort them\r\n   \nThird one '), { titles: ['Add a page', 'Sort them', 'Third one'], problem: null });
  assert.equal(batchLines('').problem, 'few');
  assert.equal(batchLines('Alone\n\n').problem, 'few');
  assert.equal(batchLines(Array.from({ length: 21 }, (_, i) => `T${i}`).join('\n')).problem, 'many');
  assert.equal(batchLines(Array.from({ length: 20 }, (_, i) => `T${i}`).join('\n')).problem, null);
  assert.equal(batchLines(`Fine\n${'x'.repeat(201)}`).problem, 'long');
  assert.equal(batchLines(`Fine\n${'x'.repeat(200)}`).problem, null);
  assert.deepEqual(batchBody('guestbook', ['One', 'Two']), { project: 'guestbook', tickets: [{ title: 'One' }, { title: 'Two' }] });
});

test('the bar offers Batch beside Run a recipe, pressed when the form is open, in both languages', () => {
  const closed = html(<Bar t={en} title="" body="" batchOpen={false} />);
  assert.match(closed, /<button[^>]*data-bar="batch"[^>]*aria-expanded="false"[^>]*aria-controls="batch-form"[^>]*>Batch<\/button>|<button[^>]*aria-expanded="false"[^>]*aria-controls="batch-form"[^>]*data-bar="batch"[^>]*>Batch<\/button>/);
  assert.match(html(<Bar t={en} title="" body="" batchOpen />), /aria-expanded="true"[^>]*aria-controls="batch-form"|aria-controls="batch-form"[^>]*aria-expanded="true"/);
  assert.match(html(<Bar t={fr} title="" body="" />), /data-bar="batch"[^>]*>Lot<\/button>|>Lot<\/button>/);
  for (const text of visibleText(html(<Bar t={sentinel} title="" body="" />))) assert.ok(!/^Batch$/.test(text), 'the chip is from the catalog');
});

test('the form: a field of lines, what the batch does, the note, and Start the batch', () => {
  const markup = html(<BatchForm t={en} text={'One\nTwo'} note="Add at least 2 tickets, one per line." />);
  assert.match(markup, /<form[^>]*id="batch-form"/);
  assert.match(markup, /<textarea[^>]*id="batch-lines"[^>]*name="lines"[^>]*aria-label="One ticket per line"|<textarea[^>]*aria-label="One ticket per line"[^>]*id="batch-lines"/);
  assert.match(markup, /data-act="batch_run"[^>]*>Start the batch<\/button>/);
  assert.match(markup, /role="status"[^>]*>Add at least 2 tickets, one per line\./);
  assert.match(visibleText(markup).join(' '), /From 2 to 20 tickets, one session each/);
  const french = html(<BatchForm t={fr} text="" note="" />);
  assert.match(french, /aria-label="Un ticket par ligne"/);
  assert.match(french, />Lancer le lot<\/button>/);
  assert.match(visibleText(french).join(' '), /De 2 à 20 tickets, une session chacun/);
  for (const text of visibleText(html(<BatchForm t={sentinel} text="" note="" />))) assert.ok(!/Start the batch|One ticket per line|From 2 to 20/.test(text), `"${text}" is not from the catalog`);
});

test('the wording of a refused form and of a refused call', () => {
  assert.equal(en('batch_few', { n: 2 }), 'Add at least 2 tickets, one per line.');
  assert.equal(en('batch_many', { n: 20 }), 'A batch holds at most 20 tickets.');
  assert.equal(en('batch_long', { n: 200 }), 'A ticket\'s title is at most 200 characters.');
  assert.equal(fr('batch_few', { n: 2 }), 'Ajoutez au moins 2 tickets, un par ligne.');
  assert.equal(fr('batch_many', { n: 20 }), 'Un lot compte 20 tickets au plus.');
  assert.equal(batchFailure(new ApiError(400, 'refused')), 'batch_refused');
  assert.equal(batchFailure(new ApiError(503, 'off')), 'batch_off');
  assert.equal(batchFailure(new Error('network')), 'batch_failed');
});

test('a batch card says how many started, what holds the rest, and each ticket', () => {
  const rows = batchRows([waiting, stopped, finished]);
  assert.deepEqual(rows.map((r) => [r.id, r.total, r.started, r.waiting, r.failed]), [['batch-2', 5, 2, 2, 1], ['batch-1', 2, 0, 2, 0], ['batch-0', 2, 2, 0, 0]]);
  assert.equal(batchLine(rows[0]!, en), '2 of 5 started · 2 waiting · 1 failed');
  assert.equal(batchLine(rows[1]!, en), '0 of 2 started · 2 waiting');
  assert.equal(batchLine(rows[2]!, en), '2 of 2 started');
  assert.equal(batchLine(rows[0]!, fr), '2 sur 5 lancés · 2 en attente · 1 en échec');
  assert.equal(holdLine(waiting.hold, en), 'Waiting for a free lane: 3 of 3 in use.');
  assert.equal(holdLine(stopped.hold, en), 'Waiting: the seven-day window is at 86 % (the stop is at 85 %).');
  assert.equal(holdLine({ reason: 'quota', window: 'five_hour', percent: 90, stop: 85 }, en), 'Waiting: the five-hour window is at 90 % (the stop is at 85 %).');
  assert.equal(holdLine(waiting.hold, fr), 'En attente d\'une voie libre : 3 sur 3 utilisées.');
  assert.equal(holdLine(stopped.hold, fr), 'En attente : la fenêtre de sept jours est à 86 % (l\'arrêt est à 85 %).');
  assert.equal(holdLine(null, en), '');
  assert.equal(batchRows([waiting, stopped, finished, waiting, stopped]).length, 3, 'the three newest');
  assert.deepEqual(batchRows([]), []);
});

test('the card draws each batch with its tickets, in English and in French', () => {
  const rows = batchRows([waiting, stopped]);
  const english = html(<BatchCards t={en} rows={rows} />);
  assert.match(english, /<h2 id="batches-title">Batches<\/h2>/);
  assert.equal([...english.matchAll(/data-batch="/g)].length, 2);
  const lines = visibleText(english);
  for (const wanted of ['2 of 5 started', '2 waiting', '1 failed', 'Waiting for a free lane: 3 of 3 in use.', 'Waiting: the seven-day window is at 86 % (the stop is at 85 %).', 'Ticket 1', 'LOCAL-201']) {
    assert.ok(lines.some((line) => line.includes(wanted)), `"${wanted}" is drawn`);
  }
  // A started ticket says its state; a queued one says it waits; a failed one says why.
  assert.match(english, /data-item-state="started"[^>]*>(?:(?!<\/li>).)*In Progress/);
  assert.match(english, /data-item-state="queued"[^>]*>(?:(?!<\/li>).)*Waiting for its turn/);
  assert.match(english, /data-item-state="failed"[^>]*>(?:(?!<\/li>).)*Did not start: the clone failed/);
  const french = html(<BatchCards t={fr} rows={rows} />);
  assert.match(french, /<h2 id="batches-title">Lots<\/h2>/);
  for (const wanted of ['2 sur 5 lancés', '2 en attente', '1 en échec', 'En attente d\'une voie libre : 3 sur 3 utilisées.']) {
    assert.ok(visibleText(french).some((line) => line.includes(wanted)), `"${wanted}" is drawn`);
  }
  assert.match(french, /data-item-state="queued"[^>]*>(?:(?!<\/li>).)*Attend son tour/);
  assert.equal(html(<BatchCards t={en} rows={[]} />), '', 'no batch, no card');
  for (const text of visibleText(html(<BatchCards t={sentinel} rows={rows} />))) assert.ok(!/Batches|started|waiting|failed|free lane|window/.test(text), `"${text}" is not from the catalog`);
});

test('the cache knows the batches: a read key, and a write refetches them with the tickets and the sessions', () => {
  assert.deepEqual(resourceOf('/batches'), ['batches']);
  const touched = touchedBy('/batches').map((key) => key.join(':'));
  for (const key of ['batches', 'tickets', 'sessions']) assert.ok(touched.includes(key), key);
});
