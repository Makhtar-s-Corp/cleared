// The flow decides whether a ticket needs captures before and after (issue
// #368, matrix P226): when the author is done, before any browser starts, it
// reads the paths the ticket's branch changes and asks the rule
// (flow/capture-need.ts). A change no person sees takes none and says why;
// a visible one is captured as P210 does, its screens named. The human's
// choice on the ticket (GET and POST /api/tickets/:id/captures, kept in the
// ledger) wins over the rule. Without a reader of the diff the flow
// captures as before; a reader that fails captures too, and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type CaptureChoice } from '../../src/api/types.ts';
import { CaptureChoiceStore } from '../../src/flow/capture-choice.ts';
import { proofRoutes } from '../../src/flow/proof-routes.ts';
import type { ProofCapture } from '../../src/flow/proof-capture.ts';
import type { ReceiptData } from '../../src/flow/receipt.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { CustomValue } from '../../src/session/events.ts';
import { REPORT_PASS, finished, quickAuthor, setup, started, text, until, type Setup } from './support.ts';

const TAKEN: ProofCapture = { before: 'before.png', after: 'after.png', video: 'flow.webm', videoMs: 20_100, missing: [] };
const settings = async () => ({ verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: ['test'], testCommand: ['npm', 'test'] });

type Read = { ticket: string; service: string; workdir: string };

async function run(options: { paths?: (input: Read) => Promise<readonly string[]>; choice?: 'on' | 'off' | 'auto' } = {}) {
  const receipts: (ReceiptData | undefined)[] = [];
  const captured: string[] = [];
  const reads: Read[] = [];
  const t: Setup = await setup({
    scripts: { author: quickAuthor, reviewers: [[started, ...text('r1', REPORT_PASS), finished(0.1)]] },
    config: { linkBase: 'https://cleared.example.invalid' },
    effects: {
      settings,
      async publish(input) { receipts.push(input.receipt); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; },
      async captureProof(input) { captured.push(input.session); return TAKEN; },
      ...(options.paths ? {
        async changedPaths(input) {
          const read = { ticket: input.ticket, service: input.service.name, workdir: input.workdir };
          reads.push(read);
          return options.paths!(read);
        },
      } : {}),
    },
  });
  if (options.choice) await t.engine.chooseCaptures(t.ticket.id, options.choice, 'u1');
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  const author = t.startedSessions.find((s) => s.input.role === 'author')!;
  const journaled = t.store.events.after(author.id).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.proof_captured' ? [e.event.value as CustomValue['cleared.proof_captured']] : []));
  return { t, receipts, captured, reads, journaled, author };
}

test('a visible change is captured, its screens named on the journal and in the receipt', async () => {
  const { t, receipts, captured, reads, journaled, author } = await run({ paths: async () => ['src/page.ts', 'src/server.ts', 'test/page.test.ts'] });
  assert.deepEqual(reads, [{ ticket: t.ticket.id, service: 'guestbook', workdir: author.input.workdir }], 'the author\'s branch is read once, from its checkout');
  assert.deepEqual(captured, [author.id]);
  const need = { take: true, reason: 'screens', screens: ['page.ts'] };
  assert.deepEqual(journaled, [{ service: 'guestbook', ...TAKEN, need }]);
  assert.deepEqual(receipts[0]?.captures, [{ service: 'guestbook', ...TAKEN, need }]);
});

test('a change no person sees takes no capture: no browser starts, and the receipt says no screen changed', async () => {
  const { receipts, captured, journaled } = await run({ paths: async () => ['src/server.ts', 'test/server.test.ts', '.github/workflows/checks.yml', 'README.md'] });
  assert.deepEqual(captured, [], 'the capture effect is never called');
  const need = { take: false, reason: 'no_screen', screens: [] };
  assert.deepEqual(journaled, [{ service: 'guestbook', missing: [], need }]);
  assert.deepEqual(receipts[0]?.captures, [{ service: 'guestbook', missing: [], need }]);
});

test('captures turned on from the ticket win over a change no person sees', async () => {
  const { captured, journaled } = await run({ paths: async () => ['src/server.ts'], choice: 'on' });
  assert.equal(captured.length, 1);
  assert.deepEqual(journaled.map((j) => j.need), [{ take: true, reason: 'forced_on', screens: [] }]);
  assert.equal(journaled[0]?.after, 'after.png');
});

test('captures turned off from the ticket win over a visible change', async () => {
  const { captured, journaled, receipts } = await run({ paths: async () => ['src/page.ts'], choice: 'off' });
  assert.deepEqual(captured, []);
  assert.deepEqual(journaled, [{ service: 'guestbook', missing: [], need: { take: false, reason: 'forced_off', screens: ['page.ts'] } }]);
  assert.equal(receipts[0]?.captures[0]?.need?.reason, 'forced_off');
});

test('turned back to auto, the rule decides again', async () => {
  const { captured, journaled } = await run({ paths: async () => ['src/server.ts'], choice: 'auto' });
  assert.deepEqual(captured, []);
  assert.equal(journaled[0]?.need?.reason, 'no_screen');
});

test('a diff that cannot be read is captured, and says so; its error never reaches the journal', async () => {
  const { captured, journaled } = await run({ paths: async () => { throw new Error('git failed in /home/someone/.secret'); } });
  assert.equal(captured.length, 1);
  assert.deepEqual(journaled.map((j) => j.need), [{ take: true, reason: 'unread', screens: [] }]);
  assert.doesNotMatch(JSON.stringify(journaled), /secret|git failed/);
});

test('without a reader of the diff the flow captures as it did, with no reason', async () => {
  const { captured, journaled } = await run();
  assert.equal(captured.length, 1);
  assert.deepEqual(journaled, [{ service: 'guestbook', ...TAKEN }]);
});

test('the choice is kept in the ledger, by ticket, with who made it and when', async () => {
  const t = await setup();
  assert.deepEqual(await t.engine.captureChoice(t.ticket.id), { choice: 'auto', by: null, at: null });
  const chosen = await t.engine.chooseCaptures(t.ticket.id, 'off', 'u1');
  assert.deepEqual(chosen, { choice: 'off', by: 'u1', at: '2026-10-21T10:00:00.000Z' });
  // Another reader of the same ledger, as after a restart.
  assert.deepEqual(new CaptureChoiceStore(t.store.db).get(t.ticket.id), chosen);
  assert.equal(await t.engine.captureChoice('LOCAL-404'), undefined);
  await assert.rejects(t.engine.chooseCaptures('LOCAL-404', 'on', 'u1'), /unknown ticket/);
});

test('the routes: the proof, then a person the service knows, then a choice of the three; an unknown ticket is 404', async () => {
  const PROOF = 'c'.repeat(64);
  const t = await setup();
  const app: App = { registry: t.engine.registry, tables: [], routes: proofRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
  const signed = { [SERVICE_PROOF_HEADER]: PROOF, 'content-type': 'application/json' };
  const post = (ticket: string, body: unknown, headers: Record<string, string> = { ...signed, [SERVICE_USER_HEADER]: 'u1' }) =>
    fetch(`${base}/${ticket}/captures`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const first = await fetch(`${base}/${t.ticket.id}/captures`, { headers: signed });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { choice: 'auto', by: null, at: null });
    assert.equal((await fetch(`${base}/${t.ticket.id}/captures`)).status, 401);
    assert.equal((await post(t.ticket.id, { choice: 'on' }, signed)).status, 403, 'no user');
    assert.equal((await post(t.ticket.id, { choice: 'on' }, { ...signed, [SERVICE_USER_HEADER]: 'agent' })).status, 403, 'a user the service does not know');
    assert.equal((await post(t.ticket.id, { choice: 'always' })).status, 400);
    assert.equal((await post(t.ticket.id, {})).status, 400);
    assert.equal((await post('LOCAL-404', { choice: 'on' })).status, 404);
    assert.equal((await fetch(`${base}/LOCAL-404/captures`, { headers: signed })).status, 404);
    const set = await post(t.ticket.id, { choice: 'on' });
    assert.equal(set.status, 200);
    const answer = await set.json() as CaptureChoice;
    assert.deepEqual(answer, { choice: 'on', by: 'u1', at: '2026-10-21T10:00:00.000Z' });
    assert.deepEqual(await (await fetch(`${base}/${t.ticket.id}/captures`, { headers: signed })).json(), answer);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
