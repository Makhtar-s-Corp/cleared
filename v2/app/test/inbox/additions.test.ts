// The inbox's part of decisions 26 and 27 (lane 27), without markup: the
// contract item's Approve and Send back, the knowledge item's Approve and
// Reject, what each sends and where, how their refusals read, what a handled
// one says, and through the app that an approved contract leaves what waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractItem, KnowledgeItem, NextInboxItem } from '../../../src/api/types.ts';
import { MAX_SEND_BACK } from '../../../src/flow/steps.ts';
import { contractItem, inboxFixture, inboxSource, knowledgeItem } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import { PLAN_PANEL_KEYS, PLAN_SERVICE_KEYS } from '../../web/plan-panel/model.ts';
import {
  SEND_BACK_MAX, approveContract, approveKnowledge, decidedLine, failure, known, ordered, outcomeLine, rejectKnowledge, sendBackContract, sendBackMessage, type InboxView,
} from '../../web/screens/inbox/model.ts';
import { signedIn, startApp } from '../support.ts';

const en = translator(loadCatalog('inbox', 'en'));
const fr = translator(loadCatalog('inbox', 'fr'));
const ME = 'user-demo';

function viewOf(items: readonly NextInboxItem[]): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return { items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false, me: { id: ME, name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop' };
}

type Sent = { path: string; method: string | undefined; body: unknown };
function fakeApi() {
  const sent: Sent[] = [];
  const api = async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
    sent.push({ path, method: init.method, body: init.body });
    return { accepted: true } as T;
  };
  return { api: api as ScreenContext['api'], sent };
}

test('a Send back says what to change: some text, at most the route\'s length', () => {
  assert.equal(SEND_BACK_MAX, MAX_SEND_BACK);
  assert.deepEqual(sendBackMessage('  Keep the verdict field as it is.  '), { message: 'Keep the verdict field as it is.' });
  assert.deepEqual(sendBackMessage('  '), { error: 'contract_send_back_empty' });
  assert.deepEqual(sendBackMessage('x'.repeat(SEND_BACK_MAX + 1)), { error: 'contract_send_back_long' });
});

test('Approve and Send back of a contract call its routes, named by the inbox id', async () => {
  const item = contractItem(FIXTURE_NOW);
  const { api, sent } = fakeApi();
  assert.deepEqual(await approveContract(api, item, FIXTURE_NOW), { kind: 'decided', decision: 'approve', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(await sendBackContract(api, item, ' Name it level, not severity. ', FIXTURE_NOW), { kind: 'decided', decision: 'send_back', at: FIXTURE_NOW.toISOString() });
  await assert.rejects(sendBackContract(api, item, ' ', FIXTURE_NOW), /contract_send_back_empty/);
  const id = encodeURIComponent(item.id);
  assert.deepEqual(sent, [
    { path: `/contracts/${id}/approve`, method: 'POST', body: null },
    { path: `/contracts/${id}/sendback`, method: 'POST', body: { message: 'Name it level, not severity.' } },
  ]);
  assert.match(id, /%3A/, 'the inbox id carries colons, encoded');
});

test('Approve and Reject of a knowledge item call its routes', async () => {
  const item = knowledgeItem(FIXTURE_NOW);
  const { api, sent } = fakeApi();
  assert.deepEqual(await approveKnowledge(api, item, FIXTURE_NOW), { kind: 'decided', decision: 'approve', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(await rejectKnowledge(api, item, FIXTURE_NOW), { kind: 'decided', decision: 'reject', at: FIXTURE_NOW.toISOString() });
  const id = encodeURIComponent(item.id);
  assert.deepEqual(sent, [{ path: `/knowledge/${id}/approve`, method: 'POST', body: null }, { path: `/knowledge/${id}/reject`, method: 'POST', body: null }]);
});

test('a refusal reads as what it means: answered already, not the owner, the service off, a refused message', () => {
  const error = (status: number) => new ApiError(status, String(status));
  for (const gesture of ['contract_approve', 'contract_send_back', 'knowledge_approve', 'knowledge_reject'] as const) {
    assert.deepEqual(failure(error(409), gesture), { key: 'decided_settled', settled: true }, gesture);
    assert.deepEqual(failure(error(404), gesture), { key: 'decided_settled', settled: true }, gesture);
    assert.deepEqual(failure(error(503), gesture), { key: 'decided_off', settled: false }, gesture);
    assert.deepEqual(failure(error(500), gesture), { key: `${gesture}_failed`, settled: false }, gesture);
  }
  assert.deepEqual(failure(error(403), 'contract_approve'), { key: 'decided_user', settled: false });
  assert.deepEqual(failure(error(403), 'knowledge_approve'), { key: 'knowledge_owner', settled: false }, 'only the tracker\'s owner answers knowledge');
  assert.deepEqual(failure(error(400), 'contract_send_back'), { key: 'contract_send_back_invalid', settled: false });
  for (const key of ['decided_settled', 'decided_off', 'decided_user', 'knowledge_owner', 'contract_send_back_invalid', 'contract_approve_failed', 'contract_send_back_failed', 'knowledge_approve_failed', 'knowledge_reject_failed', 'contract_send_back_empty', 'contract_send_back_long']) {
    assert.ok(en(key, { n: SEND_BACK_MAX }) && fr(key, { n: SEND_BACK_MAX }), key);
  }
});

test('a handled item says what the owner did, by whom and when, a Send back with its message', () => {
  const view = viewOf([]);
  const at = new Date(2026, 9, 21, 9, 12).toISOString();
  const contract = (outcome: ContractItem['outcome']): ContractItem => ({ ...contractItem(FIXTURE_NOW), state: 'handled', outcome });
  const knowledge = (outcome: KnowledgeItem['outcome']): KnowledgeItem => ({ ...knowledgeItem(FIXTURE_NOW), state: 'handled', outcome });
  assert.equal(outcomeLine(contract({ decision: 'approve', by: ME, at }), view, en), 'Validated by you at 09:12.');
  assert.equal(outcomeLine(contract({ decision: 'send_back', message: 'Name it level.', by: ME, at }), view, en), 'Sent back by you at 09:12: “Name it level.”');
  assert.equal(outcomeLine(contract({ decision: 'approve', by: 'user-other', at }), view, en), 'Validated by user-other at 09:12.');
  assert.equal(outcomeLine(knowledge({ decision: 'approve', by: ME, at }), view, en), 'Approved by you at 09:12: it is in the memory, and queued for the skill.');
  assert.equal(outcomeLine(knowledge({ decision: 'reject', by: ME, at }), view, en), 'Rejected by you at 09:12: nothing was written.');
  assert.equal(outcomeLine(contract({ decision: 'approve', by: ME, at }), view, fr), 'Validé par vous à 09:12.');
  assert.equal(outcomeLine(contract(null), view, en), en('handled_note'), 'a handled item the service gave no outcome');
  // What this page did, before the list catches up.
  assert.equal(decidedLine({ kind: 'decided', decision: 'approve', at }, contractItem(FIXTURE_NOW), en), 'Validated at 09:12. The next steps start.');
  assert.equal(decidedLine({ kind: 'decided', decision: 'send_back', at }, contractItem(FIXTURE_NOW), en), 'Sent back at 09:12. The contract step starts again with your message.');
  assert.equal(decidedLine({ kind: 'decided', decision: 'approve', at }, knowledgeItem(FIXTURE_NOW), en), 'Approved at 09:12.');
  assert.equal(decidedLine({ kind: 'decided', decision: 'reject', at }, knowledgeItem(FIXTURE_NOW), en), 'Rejected at 09:12.');
});

test('the inbox\'s catalog holds the plan panel\'s keys and its service chips\' (issue 210, item 5)', () => {
  const catalog = loadCatalog('inbox', 'en');
  for (const key of [...PLAN_PANEL_KEYS, ...PLAN_SERVICE_KEYS]) assert.ok(Object.hasOwn(catalog, key), key);
});

test('through the app, an approved contract leaves what waits, as the signed-in user; a second Approve finds it answered', async () => {
  const fixture = inboxFixture(FIXTURE_NOW, { reading: true });
  const source = inboxSource(fixture);
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const api: ScreenContext['api'] = async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
      const write = init.method === 'POST';
      const headers: Record<string, string> = { cookie, accept: 'application/json', origin: app.origin, 'sec-fetch-site': 'same-origin' };
      if (write) Object.assign(headers, { 'x-csrf-token': csrf, 'content-type': 'application/json' });
      const response = await fetch(`${app.base}/api/service${path}`, { method: init.method ?? 'GET', headers, body: write ? JSON.stringify(init.body ?? null) : null });
      if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status}`);
      return await response.json() as T;
    };
    const before = known(await api<unknown[]>('/inbox'));
    const contract = before.find((i): i is ContractItem => i.kind === 'contract');
    assert.ok(contract && contract.state === 'waiting');
    await approveContract(api, contract, FIXTURE_NOW);
    assert.deepEqual(source.calls.at(-1), { method: 'POST', path: `/api/contracts/${encodeURIComponent(contract.id)}/approve`, user: id, body: null });
    const after = known(await api<unknown[]>('/inbox'));
    assert.ok(!ordered(after).waiting.some((i) => i.id === contract.id), 'it left what waits');
    const handled = after.find((i): i is ContractItem => i.id === contract.id && i.kind === 'contract');
    assert.equal(handled?.outcome?.decision, 'approve');
    assert.equal(handled?.outcome?.by, id);
    await assert.rejects(approveContract(api, contract, FIXTURE_NOW), (error: unknown) => failure(error, 'contract_approve').key === 'decided_settled');

    const knowledge = before.find((i): i is KnowledgeItem => i.kind === 'knowledge');
    assert.ok(knowledge);
    await rejectKnowledge(api, knowledge, FIXTURE_NOW);
    const rejected = known(await api<unknown[]>('/inbox')).find((i): i is KnowledgeItem => i.id === knowledge.id && i.kind === 'knowledge');
    assert.equal(rejected?.outcome?.decision, 'reject');
    // A Send back the route refuses is refused by the stand-in too.
    const second: ContractItem = { ...contract, id: 'contract:LOCAL-170:2' };
    await assert.rejects(api(`/contracts/${encodeURIComponent(second.id)}/sendback`, { method: 'POST', body: { message: '' } }), (error: unknown) => error instanceof ApiError && (error.status === 400 || error.status === 404));
  } finally {
    await app.close();
  }
});
