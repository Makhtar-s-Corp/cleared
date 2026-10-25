// The engine when an effect fails (lane j3-test-gaps): the forge cannot say
// a release's checks, the lock throws instead of answering, the author's
// handover cannot be stored, a variant's checkout cannot be made. Each
// failure is said without its message where a log could carry a secret, and
// cleaned where the ticket says it; the flow goes on where it can.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../src/api/types.ts';
import { approved, finished, quickAuthor, setup, started, text, until } from './support.ts';

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const release = (t: Awaited<ReturnType<typeof setup>>) => t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');

test('checks the forge cannot say leave the card pending, are logged without the error\'s message, and are asked again a minute later', async (context) => {
  const logged: string[] = [];
  context.mock.method(console, 'error', (line: string) => { logged.push(line); });
  let fails = 1;
  const t = await setup({ scripts: { author: quickAuthor }, effects: { async prChecks() { if (fails-- > 0) throw new Error(`401 for ${SECRET}`); return 'passed'; } } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => release(t)?.state === 'waiting', 'the release item', 5000);
  await t.engine.settled();
  await t.engine.tick();
  assert.equal(release(t)?.pr.checks, 'pending');
  assert.deepEqual(logged.filter((line) => line.includes('checks')), ['cleared-v2: the checks of pull request #7 could not be read (Error)']);
  assert.ok(!logged.some((line) => line.includes(SECRET)));
  // Within the minute the forge is not asked again.
  t.clock.now += 30_000;
  await t.engine.tick();
  assert.equal(release(t)?.pr.checks, 'pending');
  t.clock.now += 30_000;
  await t.engine.tick();
  assert.equal(release(t)?.pr.checks, 'passed');
});

test('a lock that throws is asked again after the retry delay, and the ticket is not put back meanwhile', async () => {
  const asked: number[] = [];
  let fails = 1;
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: {
      async mergeRelease() {
        asked.push(t.clock.now);
        if (fails-- > 0) throw new Error('the lock is not reachable');
        return { outcome: 'merged', message: '' };
      },
    },
  });
  await approved(t);
  // The approval writer asks the lock first: the flow asks one interval later.
  t.clock.now += t.deps.config.mergeRetryMs;
  await t.engine.tick();
  await t.engine.settled();
  assert.equal(asked.length, 1);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.go);
  assert.ok(!t.flowEvents.some((e) => e.type === 'ticket_put_back' || e.type === 'release_merged'));
  // Not before the delay.
  t.clock.now += t.deps.config.mergeRetryMs - 1;
  await t.engine.tick();
  await t.engine.settled();
  assert.equal(asked.length, 1);
  t.clock.now += 1;
  await t.engine.tick();
  await t.engine.settled();
  assert.equal(asked.length, 2);
  assert.ok(t.flowEvents.some((e) => e.type === 'release_merged'));
});

test('an author handover that cannot be stored is said on the ticket, cleaned, and the review still runs', async () => {
  const t = await setup({
    scripts: { author: quickAuthor },
    clean: (text) => text.replaceAll(SECRET, '[removed]'),
    effects: { async captureHandover() { throw new Error(`disk full near ${SECRET}`); } },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => release(t)?.state === 'waiting', 'the release item', 5000);
  const said = (await t.tickets.comments(t.ticket.id)).map((c) => c.body).find((body) => body.includes('handover'));
  assert.match(said ?? '', /^The author's handover could not be stored: /);
  assert.ok(!said?.includes(SECRET), said);
  assert.ok(t.startedSessions.some((s) => s.input.role === 'reviewer'), 'the reviewer started');
});

test('a variant whose session cannot start fails alone, said on the ticket and cleaned; the other variant goes on', async () => {
  const t = await setup({
    scripts: { authors: [[started, ...text('a1', 'Done.'), finished(0.2)]] },
    clean: (said) => said.replaceAll(SECRET, '[removed]'),
    effects: {
      async prepareWorkdir({ ticket, role, variant }) {
        if (variant?.position === 2) throw new Error(`clone refused for ${SECRET}`);
        return { workdir: `/work/${ticket.id}-${role}-${variant?.position ?? 0}`, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
      async variantChanges() { return { files: ['src/a.ts'], diff: 'diff --git a/src/a.ts b/src/a.ts\n' }; },
    },
  });
  await t.engine.start(t.ticket.id, 'u1', undefined, 2);
  await until(async () => (await t.engine.ticketVariants(t.ticket.id))?.every((v) => v.state === 'failed' || v.state === 'done') ?? false, 'both variants ended');
  assert.deepEqual((await t.engine.ticketVariants(t.ticket.id))?.map((v) => v.state), ['done', 'failed']);
  const said = (await t.tickets.comments(t.ticket.id)).map((c) => c.body).find((body) => body.startsWith('Variant 2 of 2 failed'));
  assert.match(said ?? '', /^Variant 2 of 2 failed: its session could not start: /);
  assert.ok(!said?.includes(SECRET), said);
  assert.ok(!t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'one variant is enough to go on');
});
