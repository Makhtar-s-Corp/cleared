// The first screen's sheet before the first draw (review of 248, F1; lane
// 38): the server names every screen's sheet off (media="not all"), which
// never blocks the first paint, so the page turns the first screen's on and
// waits for them to load before it draws anything, as a sheet in the head
// would make it wait; a sheet that never answers holds it a bounded time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetsReady } from '../../web/lib/sheets.ts';

type Link = { media: string; dataset: { screens?: string }; sheet: object | null; fire?: (type: string) => void; addEventListener(type: string, run: () => void, options?: unknown): void };
function link(screens: string, loaded: boolean): Link {
  const runs = new Map<string, () => void>();
  return {
    media: 'not all', dataset: { screens }, sheet: loaded ? {} : null,
    addEventListener: (type, run) => { runs.set(type, run); },
    fire(type) { if (type === 'load') this.sheet = {}; runs.get(type)?.(); },
  };
}
const rootOf = (links: Link[]) => ({ querySelectorAll: () => links }) as unknown as Pick<Document, 'querySelectorAll'>;

test('the first screen\'s sheets are turned on, and the draw waits for those not loaded yet', async () => {
  const inbox = link('inbox', false);
  const session = link('session', false);
  const loaded = link('inbox lead', true);
  let done = false;
  const ready = sheetsReady('inbox', rootOf([inbox, session, loaded]), 5_000).then(() => { done = true; });
  assert.equal(inbox.media, 'all');
  assert.equal(loaded.media, 'all');
  assert.equal(session.media, 'not all');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, 'the inbox\'s sheet has not loaded');
  inbox.fire?.('load');
  await ready;
  assert.equal(done, true);
});

test('a sheet that fails or never answers holds the first draw a bounded time only', async () => {
  const failed = link('tower', false);
  const ready = sheetsReady('tower', rootOf([failed]), 5_000);
  failed.fire?.('error');
  await ready;
  const silent = link('tower', false);
  const started = Date.now();
  await sheetsReady('tower', rootOf([silent]), 50);
  assert.ok(Date.now() - started < 1_000);
  await sheetsReady('tower', rootOf([]), 50);
});
