// The check of the production page after a release landed (P218, issue
// #334): once the human approved the release, the lock merged it and the
// release watch read the deployed version healthy (the deploy is the
// human's or their CI's), the flow opens the address the project configures
// ([release] production_url), captures it, files the capture with the
// ticket, says it on the ticket and serves it to its card. Before the
// approval, while the watch runs, after a rollback, or when no health check
// says the deploy is done, nothing is opened. A fake capture stands for
// Playwright here (production-capture.test.ts tests the real one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, type ProductionCheck } from '../../src/api/types.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import type { ProductionCapture } from '../../src/flow/proof-capture.ts';
import { proofRoutes } from '../../src/flow/proof-routes.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { approved, ledgerRow, quickAuthor, releaseRow, setup, until, type Setup } from './support.ts';

const PRODUCTION = 'https://guestbook.example.invalid/?view=all';
const settings = (productionUrl: string | undefined) => async () => ({
  verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: [], ...(productionUrl ? { productionUrl } : {}),
});

type Captured = { url: string; dir: string };

async function landed(options: { productionUrl?: string | null; capture?: (input: Captured) => Promise<ProductionCapture>; proofTimeoutMs?: number; approve?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-production-flow-'));
  const captured: Captured[] = [];
  const effects: Partial<FlowEffects> = {
    settings: settings(options.productionUrl === null ? undefined : options.productionUrl ?? PRODUCTION),
    async mergeRelease() { return { outcome: 'merged', message: '' }; },
    async captureProduction(input) {
      captured.push(input);
      if (options.capture) return options.capture(input);
      mkdirSync(input.dir, { recursive: true });
      writeFileSync(join(input.dir, 'production.png'), 'png');
      return { file: 'production.png' };
    },
  };
  const t = await setup({ scripts: { author: quickAuthor }, config: { workdirRoot: root, ...(options.proofTimeoutMs ? { proofTimeoutMs: options.proofTimeoutMs } : {}) }, effects });
  if (options.approve === false) {
    await t.engine.start(t.ticket.id, 'u1');
    await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
    await t.engine.settled();
  } else {
    await approved(t);
  }
  return { t, root, captured, done: () => rmSync(root, { recursive: true, force: true }) };
}

async function tickAfter(t: Setup, ms: number): Promise<void> {
  t.clock.now += ms;
  await t.engine.tick();
  await t.engine.settled();
}

const iso = (ms: number) => new Date(ms).toISOString();
const comments = async (t: Setup) => (await t.tickets.comments(t.ticket.id)).map((c) => c.body);

// The watch's healthy end, as lib/release.ts writes it.
function healthy(t: Setup, at: number): void {
  t.store.db.prepare("UPDATE releases SET status = 'complete', last_health = 'HTTP 200', ended_at = ?").run(iso(at));
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket: t.ticket.id, pr: 7, at: iso(at), detail: 'HTTP 200' });
}

// Merged by the flow's call to the lock, the release watch running.
async function merged(t: Setup): Promise<number> {
  await tickAfter(t, 60_000);
  const mergedAt = t.clock.now;
  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'watching', mergedAt: iso(mergedAt) });
  await tickAfter(t, 60_000);
  assert.ok(t.flowEvents.some((e) => e.type === 'release_merged'));
  return mergedAt;
}

test('approved, merged, then healthy: the configured production page is opened once, filed with the ticket, said on it and served to its card', async () => {
  const { t, root, captured, done } = await landed();
  try {
    const mergedAt = await merged(t);
    assert.deepEqual(captured, [], 'nothing is opened while the release watch runs');
    healthy(t, mergedAt + 300_000);
    await tickAfter(t, 300_000);
    assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Done');
    assert.deepEqual(captured, [{ url: PRODUCTION, dir: join(root, '.proof', t.ticket.id, 'guestbook') }], 'the address as configured, once');

    const checks = await t.engine.productionChecks(t.ticket.id);
    assert.deepEqual(checks, [{ service: 'guestbook', pr: 7, url: 'https://guestbook.example.invalid/', at: iso(t.clock.now), file: 'production.png', missing: null }] satisfies ProductionCheck[]);
    assert.doesNotMatch(JSON.stringify(checks), /view=all/, 'the address is said without its query');
    const said = (await comments(t)).at(-1) ?? '';
    assert.match(said, /production page of guestbook \(https:\/\/guestbook\.example\.invalid\/\) was captured after pull request #7 landed healthy/);
    assert.match(said, /Cleared did not deploy it/);
    assert.doesNotMatch(said, /view=all/);

    // The capture asked nothing of the lock or the forge, and later ticks open nothing again.
    const calls = t.calls.length;
    await tickAfter(t, 600_000);
    await tickAfter(t, 600_000);
    assert.equal(captured.length, 1);
    assert.equal(t.calls.length, calls);
    assert.equal(t.flowEvents.filter((e) => e.type === 'release_landed').length, 1);
  } finally {
    done();
  }
});

test('nothing is opened before the human approved, before the merge, or after a rollback', async () => {
  const waiting = await landed({ approve: false });
  try {
    for (let i = 0; i < 5; i += 1) await tickAfter(waiting.t, 60_000);
    assert.equal((await waiting.t.tickets.get(waiting.t.ticket.id))?.status, 'Needs Approval');
    assert.deepEqual(waiting.captured, [], 'not approved: no merge, no page');
    assert.deepEqual(await waiting.t.engine.productionChecks(waiting.t.ticket.id), []);
  } finally {
    waiting.done();
  }

  const { t, captured, done } = await landed();
  try {
    const mergedAt = await merged(t);
    ledgerRow(t.store, { kind: 'release_health_failing', ticket: t.ticket.id, pr: 7, at: iso(mergedAt + 120_000), detail: 'HTTP 500' });
    ledgerRow(t.store, { kind: 'rollback_pushed', ticket: t.ticket.id, pr: 7, at: iso(mergedAt + 150_000), detail: 'HTTP 500 twice' });
    await tickAfter(t, 300_000);
    assert.ok(t.flowEvents.some((e) => e.type === 'rolled_back'));
    assert.deepEqual(captured, [], 'rolled back: the change is not live');
    assert.deepEqual(await t.engine.productionChecks(t.ticket.id), []);
  } finally {
    done();
  }
});

test('a project with no health check: nothing tells Cleared the deploy is done, so no page is opened, and the card and the ticket say why', async () => {
  const { t, captured, done } = await landed();
  try {
    const mergedAt = await merged(t);
    t.store.db.prepare("UPDATE releases SET status = 'complete', ended_at = ?").run(iso(mergedAt + 1000));
    ledgerRow(t.store, { kind: 'release_health_unconfigured', ticket: t.ticket.id, pr: 7, at: iso(mergedAt + 1000), detail: 'No [release] health_url or health_command' });
    await tickAfter(t, 60_000);
    assert.ok(t.flowEvents.some((e) => e.type === 'release_landed' && e.health === 'unwatched'));
    assert.deepEqual(captured, []);
    assert.deepEqual((await t.engine.productionChecks(t.ticket.id))?.map((c) => [c.service, c.file, c.missing]), [['guestbook', null, 'unwatched']]);
    assert.match((await comments(t)).at(-1) ?? '', /no health check.*cannot tell when the deploy is done/);
  } finally {
    done();
  }
});

test('no production_url configured: no browser, nothing filed, nothing said', async () => {
  const { t, captured, done } = await landed({ productionUrl: null });
  try {
    const mergedAt = await merged(t);
    const before = (await comments(t)).length;
    healthy(t, mergedAt + 300_000);
    await tickAfter(t, 300_000);
    assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Done');
    assert.deepEqual(captured, []);
    assert.deepEqual(await t.engine.productionChecks(t.ticket.id), []);
    assert.equal((await comments(t)).length, before);
  } finally {
    done();
  }
});

test('a capture that throws, or hangs past the cap, is filed as failed: the ticket stays Done', async () => {
  const thrown = await landed({ capture: async () => { throw new Error('browser crashed at https://guestbook.example.invalid/?token=abc'); } });
  try {
    const mergedAt = await merged(thrown.t);
    healthy(thrown.t, mergedAt + 300_000);
    await tickAfter(thrown.t, 300_000);
    const checks = await thrown.t.engine.productionChecks(thrown.t.ticket.id);
    assert.deepEqual(checks?.map((c) => [c.file, c.missing]), [[null, 'failed']]);
    assert.doesNotMatch(JSON.stringify(checks) + (await comments(thrown.t)).join('\n'), /token|crashed/);
    assert.equal((await thrown.t.tickets.get(thrown.t.ticket.id))?.status, 'Done');
  } finally {
    thrown.done();
  }

  const hung = await landed({ capture: () => new Promise(() => {}), proofTimeoutMs: 20 });
  try {
    const mergedAt = await merged(hung.t);
    healthy(hung.t, mergedAt + 300_000);
    await tickAfter(hung.t, 300_000);
    assert.deepEqual((await hung.t.engine.productionChecks(hung.t.ticket.id))?.map((c) => c.missing), ['failed']);
  } finally {
    hung.done();
  }
});

test('the capture is served to the app as the receipt\'s are, behind the app\'s proof; the checks of a ticket too', async () => {
  const { t, root, done } = await landed();
  const PROOF = 'b'.repeat(64);
  const app: App = { registry: t.engine.registry, tables: [], routes: proofRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
  const get = (path: string, proof = PROOF) => fetch(`${base}/${path}`, { headers: { [SERVICE_PROOF_HEADER]: proof } });
  try {
    const mergedAt = await merged(t);
    assert.deepEqual(await (await get(`${t.ticket.id}/production`)).json(), [], 'nothing before the landing');
    healthy(t, mergedAt + 300_000);
    await tickAfter(t, 300_000);
    assert.ok(existsSync(join(root, '.proof', t.ticket.id, 'guestbook', 'production.png')));
    const png = await get(`${t.ticket.id}/proof/guestbook/production.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(await png.text(), 'png');
    const checks = await get(`${t.ticket.id}/production`);
    assert.equal(checks.status, 200);
    assert.deepEqual((await checks.json() as ProductionCheck[]).map((c) => [c.service, c.file]), [['guestbook', 'production.png']]);
    assert.equal((await get('NOPE-1/production')).status, 404);
    assert.equal((await get(`${t.ticket.id}/production`, 'c'.repeat(64))).status, 401);
    assert.equal((await get(`${t.ticket.id}/proof/guestbook/production.png`, 'c'.repeat(64))).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    done();
  }
});
