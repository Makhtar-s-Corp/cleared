// The flow's side of the proof receipt (issue #326, P210): the captures are
// taken when the author is done, while its session and its trial
// environment still run, and journaled on it; the publish is handed the
// receipt's facts, read from the ledger (the reviewers' test runs, every
// session's tokens and cost, the time since the first session started),
// never from what a report says. A capture that fails loses the captures,
// never the pull request. The files are served to the app only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER } from '../../src/api/types.ts';
import { proofRoutes } from '../../src/flow/proof-routes.ts';
import type { ProofCapture } from '../../src/flow/proof-capture.ts';
import type { ReceiptData } from '../../src/flow/receipt.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { toolArgs, toolResult, type CustomValue } from '../../src/session/events.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { REPORT_FIX, REPORT_PASS, finished, quickAuthor, setup, started, text, until, type Setup } from './support.ts';

const call = (id: string, command: string, output: string, isError: boolean): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Bash' } },
  { emit: toolArgs(id, { kind: 'execute', command }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, { kind: 'execute', output, cut: 0, isError }) },
];
const reviewer = (report: string, run: readonly FakeStep[], cost: number | null = 0.1): readonly FakeStep[] => [started, ...run, ...text('r1', report), finished(cost)];
const settings = async () => ({ verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: ['test'], testCommand: ['npm', 'test'] });

const TAKEN: ProofCapture = { before: 'before.png', after: 'after.png', video: 'flow.webm', videoMs: 20_100, missing: [] };

type Seen = { input: { ticket: string; session: string; dir: string; service?: { name: string } }; status: string | undefined };

async function run(options: { capture?: (input: Seen['input']) => Promise<ProofCapture>; reviewers?: readonly (readonly FakeStep[])[]; rounds?: number; proofTimeoutMs?: number } = {}) {
  const receipts: (ReceiptData | undefined)[] = [];
  const seen: Seen[] = [];
  let t: Setup | undefined;
  t = await setup({
    scripts: { author: quickAuthor, reviewers: options.reviewers ?? [reviewer(REPORT_PASS, call('t1', 'npm test', '# pass 1', false))] },
    config: { linkBase: 'https://cleared.example.invalid', maxReviewRounds: options.rounds ?? 2, ...(options.proofTimeoutMs ? { proofTimeoutMs: options.proofTimeoutMs } : {}) },
    effects: {
      settings,
      async publish(input) { receipts.push(input.receipt); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; },
      ...(options.capture ? {
        async captureProof(input) {
          seen.push({ input, status: t?.store.sessions.get(input.session)?.status });
          return options.capture!(input);
        },
      } : {}),
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t!.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  return { t, receipts, seen };
}

test('the author\'s captures are taken before its session closes, and the publish gets the receipt\'s facts', async () => {
  const { t, receipts, seen } = await run({ capture: async () => TAKEN });
  const author = t.startedSessions.find((s) => s.input.role === 'author')!;
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.input.session, author.id);
  assert.equal(seen[0]?.input.service?.name, 'guestbook');
  assert.equal(seen[0]?.input.dir, `/work/.proof/${t.ticket.id}/guestbook`);
  assert.notEqual(seen[0]?.status, 'done', 'the session still runs, so its trial environment does');
  // Journaled on the author's session.
  const journaled = t.store.events.after(author.id).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.proof_captured' ? [e.event.value as CustomValue['cleared.proof_captured']] : []));
  assert.deepEqual(journaled, [{ service: 'guestbook', ...TAKEN }]);

  const [receipt] = receipts;
  assert.ok(receipt, 'the publish is handed a receipt');
  assert.equal(receipt.ticket, t.ticket.id);
  assert.deepEqual(receipt.tests, [{ round: 1, command: 'npm test', outcome: 'passed' }]);
  assert.equal(receipt.testsDeclared, true);
  // The fake's turns: 100 in and 10 out each, one for the author, one for the reviewer.
  assert.equal(receipt.tokens, 220);
  // The author's 0.30 and the reviewer's 0.10, each its session's last total.
  assert.equal(receipt.costUsd, 0.4);
  assert.ok(receipt.elapsedMs >= 0);
  assert.deepEqual(receipt.captures, [{ service: 'guestbook', ...TAKEN }]);
  assert.equal(receipt.linkBase, 'https://cleared.example.invalid');
  // Nothing of a test's output reaches the receipt.
  assert.doesNotMatch(JSON.stringify(receipt), /# pass 1/);
});

test('every review round\'s test run is listed; a reviewer that never reports a cost leaves the dollars out', async () => {
  // The second round resumes the first reviewer's session: it is one session whose turns report no total.
  const { receipts } = await run({
    reviewers: [reviewer(REPORT_FIX, call('t1', 'npm test', 'not ok 1', true), null), reviewer(REPORT_PASS, call('t2', 'npm test', 'ok 1', false), null)],
    rounds: 3,
  });
  const receipt = receipts.at(-1)!;
  assert.deepEqual(receipt.tests, [{ round: 1, command: 'npm test', outcome: 'failed' }, { round: 2, command: 'npm test', outcome: 'passed' }]);
  assert.equal(receipt.costUsd, null);
  assert.ok((receipt.tokens ?? 0) > 0);
});

test('a capture that throws is journaled as failed, by its code only, and the pull request still opens', async () => {
  const { t, receipts } = await run({ capture: async () => { throw new Error('browser crashed at http://127.0.0.1:9/?token=abc'); } });
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]?.captures, [{ service: 'guestbook', missing: [{ part: 'before', reason: 'failed' }, { part: 'after', reason: 'failed' }, { part: 'video', reason: 'failed' }] }]);
  assert.ok(t.inbox.list().some((i) => i.kind === 'release'));
  assert.doesNotMatch(JSON.stringify(receipts[0]), /token=|crashed|127\.0\.0\.1/);
});

test('a capture that never ends is given up at the cap, and the ticket goes on', async () => {
  const { receipts } = await run({ capture: () => new Promise<ProofCapture>(() => {}), proofTimeoutMs: 50 });
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]?.captures.map((c) => c.missing.map((m) => m.reason)), [['failed', 'failed', 'failed']]);
});

test('a flow with no capture effect publishes a receipt with no captures', async () => {
  const { receipts } = await run();
  assert.deepEqual(receipts[0]?.captures, []);
  assert.equal(receipts[0]?.tests.length, 1);
});

test('the files are served to the app: only the three names, only a known service, with their type; nothing without the proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-proof-route-'));
  const PROOF = 'b'.repeat(64);
  const t = await setup({ config: { workdirRoot: root } });
  const dir = join(root, '.proof', t.ticket.id, 'guestbook');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'before.png'), 'png-bytes');
  writeFileSync(join(dir, 'flow.webm'), 'webm-bytes');
  writeFileSync(join(dir, 'notes.txt'), 'not served');
  const app: App = { registry: t.engine.registry, tables: [], routes: proofRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
  const get = (path: string, proof = PROOF) => fetch(`${base}/${path}`, { headers: { [SERVICE_PROOF_HEADER]: proof } });
  try {
    const png = await get(`${t.ticket.id}/proof/guestbook/before.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(await png.text(), 'png-bytes');
    const webm = await get(`${t.ticket.id}/proof/guestbook/flow.webm`);
    assert.equal(webm.headers.get('content-type'), 'video/webm');
    for (const path of [`${t.ticket.id}/proof/guestbook/notes.txt`, `${t.ticket.id}/proof/guestbook/after.png`, `${t.ticket.id}/proof/nope/before.png`, `NOPE-1/proof/guestbook/before.png`, `${t.ticket.id}/proof/..%2F..%2Fguestbook/before.png`])
      assert.equal((await get(path)).status, 404, path);
    assert.equal((await get(`${t.ticket.id}/proof/guestbook/before.png`, 'c'.repeat(64))).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
