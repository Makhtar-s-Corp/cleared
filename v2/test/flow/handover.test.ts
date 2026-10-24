// Hand over to Codex, and back (matrix B6.3, P150 to P155): POST
// /api/sessions/:id/handover moves a live author's work to the other
// harness of the contract, claude-code or codex, in the same checkout. The
// source session is interrupted and stopped (not a finished work: no review,
// no put back), the target starts as a new author session whose first
// message carries a note of the work so far, both are journaled, and the
// review of a ticket that changed harness is done by the other harness than
// the author's. Cursor stays out of every flow (P87). Codex is a fake here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type SessionDetail } from '../../src/api/types.ts';
import { CODEX_MODEL } from '../../src/flow/engine.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionId } from '../../src/session/contract.ts';
import { PROOF, post, rig, type Rig } from './handover-support.ts';
import { finished, permission, quickAuthor, REPORT_FIX, REPORT_PASS, reviewerScript, started, text, until } from './support.ts';

// The Claude author is stuck on a permission nobody answers.
const stuck: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)];
const proposal: FakeStep = { hostCall: { toolCallId: 'plan-1', name: 'propose_session_plan', input: { steps: ['Sort the list'], files: ['src/entries.ts'], confidence: 'high', reason: 'One function.' } } };
const edits: readonly FakeStep[] = [
  started, ...text('a1', 'The sort is half done.'),
  { emit: { type: 'TOOL_CALL_START', toolCallId: 'e1', toolCallName: 'Edit' } },
  { emit: { type: 'TOOL_CALL_ARGS', toolCallId: 'e1', delta: JSON.stringify({ kind: 'edit', path: '/workspace/src/entries.ts', locations: [] }) } },
  { emit: { type: 'TOOL_CALL_RESULT', messageId: 'e1-r', toolCallId: 'e1', content: JSON.stringify({ kind: 'edit', ok: true }), role: 'tool' } },
  permission, { awaitMessage: true }, finished(0.4),
];

const handOver = (r: Rig, id: SessionId, body: unknown, user = 'u1') => post(r, `/api/sessions/${id}/handover`, user, body);
const detail = (r: Rig, id: SessionId) => r.engine.sessionDetail(id) as SessionDetail;
const journal = (r: Rig, id: SessionId) => r.store.events.after(id).map((e) => e.event);
const handedOverEvents = (r: Rig, id: SessionId) => journal(r, id).filter((e) => e.type === 'CUSTOM' && e.name === 'cleared.handed_over');

// Starts the Claude author and waits for it to be stuck on its permission.
async function stuckAuthor(r: Rig): Promise<SessionId> {
  await r.engine.start(r.ticket.id, 'u1');
  await until(() => r.inbox.waitingFor(r.startedSessions[0]?.id ?? '') > 0, 'the permission');
  await r.engine.settled();
  return r.startedSessions[0]!.id;
}

test('a stuck Claude author is handed over to Codex: a new author in the same checkout, told what was done, the source stopped without a review', async () => {
  const r = await rig({ scripts: { author: edits } });
  try {
    r.codex.authors.push([started, ...text('c1', 'I carry on.'), { awaitMessage: true }, finished(0.2)]);
    const id = await stuckAuthor(r);
    const checkout = r.startedSessions[0]!.input.workdir;
    const response = await handOver(r, id, { harness: 'codex' });
    assert.equal(response.status, 200);
    await r.engine.settled();

    assert.equal(r.codex.started.length, 1, 'Codex started one session');
    const target = r.codex.started[0]!;
    assert.equal(response.json.session, target.id);
    assert.deepEqual({ accepted: response.json.accepted, harness: response.json.harness, model: response.json.model }, { accepted: true, harness: 'codex', model: CODEX_MODEL });
    assert.equal(target.input.harness, 'codex');
    assert.equal(target.input.role, 'author');
    assert.equal(target.input.model, CODEX_MODEL);
    assert.equal(target.input.workdir, checkout, 'the same checkout: the uncommitted work is kept');
    assert.equal(target.input.ticket, r.ticket.id);
    assert.equal(target.input.policy.role, 'author');
    assert.match(target.input.prompt, /handed over/i);
    assert.match(target.input.prompt, /claude-code/);
    assert.match(target.input.prompt, /The sort is half done\./, 'the last thing the Claude session said');
    assert.match(target.input.prompt, /src\/entries\.ts/, 'a file it edited');

    assert.equal(detail(r, id).phase, 'stopped', 'the source is stopped');
    assert.equal(detail(r, target.id).harness, 'codex');
    assert.equal(detail(r, target.id).role, 'author');
    assert.equal(detail(r, target.id).phase, 'working');
    assert.equal(r.inbox.waitingFor(id), 0, 'what the Claude session waited for is settled');
    assert.ok(!r.startedSessions.some((s) => s.input.role === 'reviewer'), 'the interrupted turn is not a finished work: no review starts');
    assert.ok(!r.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket is not put back');

    const marks = [...handedOverEvents(r, id), ...handedOverEvents(r, target.id)];
    assert.equal(marks.length, 2, 'both sessions say it');
    for (const mark of marks) {
      assert.ok(mark.type === 'CUSTOM' && mark.name === 'cleared.handed_over');
      if (mark.type === 'CUSTOM' && mark.name === 'cleared.handed_over')
        assert.deepEqual({ from: mark.value.from, to: mark.value.to, by: mark.value.by }, {
          from: { session: id, harness: 'claude-code', model: 'claude-opus-5-5' }, to: { session: target.id, harness: 'codex', model: CODEX_MODEL }, by: 'u1',
        });
    }
  } finally {
    await r.close();
  }
});

test('the work done by Codex is reviewed by Claude; Codex\'s change never reviewed by Codex', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    assert.equal((await handOver(r, id, { harness: 'codex' })).status, 200);
    await until(() => r.startedSessions.some((s) => s.input.role === 'reviewer'), 'the review');
    await r.engine.settled();
    const reviewer = r.startedSessions.find((s) => s.input.role === 'reviewer')!;
    assert.equal(reviewer.input.harness, 'claude-code', 'the author is Codex: the reviewer is Claude');
    assert.equal(reviewer.input.model, 'claude-sonnet-5-5');
    assert.ok(!r.codex.started.some((s) => s.input.role === 'reviewer'));
  } finally {
    await r.close();
  }
});

test('handed over and back: the Claude author that returns is reviewed by Codex, read only', async () => {
  const r = await rig({ scripts: { authors: [stuck, quickAuthor] } });
  try {
    r.codex.authors.push([started, ...text('c1', 'I carry on.'), permission, { awaitMessage: true }, finished(0.2)]);
    const first = await stuckAuthor(r);
    const out = await handOver(r, first, { harness: 'codex' });
    assert.equal(out.status, 200);
    const codexId = out.json.session as SessionId;
    await until(() => r.inbox.waitingFor(codexId) > 0, 'the Codex session stuck in its turn');
    const back = await handOver(r, codexId, { harness: 'claude-code' });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    await until(() => r.codex.started.some((s) => s.input.role === 'reviewer'), 'the review');
    await r.engine.settled();

    const returned = r.startedSessions.filter((s) => s.input.role === 'author');
    assert.equal(returned.length, 2, 'a second Claude author session, not the first one reopened');
    assert.equal(returned[1]!.input.harness, 'claude-code');
    assert.equal(returned[1]!.id, back.json.session);
    assert.match(returned[1]!.input.prompt, /codex/);
    assert.match(returned[1]!.input.prompt, /I carry on\./);
    assert.equal(returned[1]!.input.workdir, returned[0]!.input.workdir);
    assert.equal(detail(r, codexId).phase, 'stopped');
    assert.equal(r.claudeResumed.length, 0, 'nothing was resumed: the return is a new session');

    const reviewer = r.codex.started.find((s) => s.input.role === 'reviewer');
    assert.ok(reviewer, 'the author is Claude again: the reviewer is Codex');
    assert.equal(reviewer.input.policy.role, 'reviewer');
    assert.equal(reviewer.input.model, CODEX_MODEL);
    assert.ok(!r.startedSessions.some((s) => s.input.role === 'reviewer'), 'no Claude reviewer for Claude\'s return');
  } finally {
    await r.close();
  }
});

test('a ticket that never changed harness keeps its Claude reviewer', async () => {
  const r = await rig({ scripts: { author: quickAuthor } });
  try {
    await r.engine.start(r.ticket.id, 'u1');
    await until(() => r.startedSessions.some((s) => s.input.role === 'reviewer'), 'the review');
    await r.engine.settled();
    assert.equal(r.startedSessions.find((s) => s.input.role === 'reviewer')!.input.harness, 'claude-code');
    assert.equal(r.codex.started.length, 0);
  } finally {
    await r.close();
  }
});

test('a Codex session given back after a take over is resumed by the Codex adapter', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    r.codex.authors.push([started, ...text('c1', 'Working.'), permission, { awaitMessage: true }, finished(0.2)]);
    const id = await stuckAuthor(r);
    const codexId = (await handOver(r, id, { harness: 'codex' })).json.session as SessionId;
    await until(() => r.inbox.waitingFor(codexId) > 0, 'the Codex session');

    assert.equal((await post(r, `/api/sessions/${codexId}/takeover`)).status, 200);
    assert.equal((await post(r, `/api/sessions/${codexId}/giveback`)).status, 200);
    assert.deepEqual(r.codex.resumed, [codexId], 'resumed through the Codex adapter');
    assert.deepEqual(r.claudeResumed, [], 'never through the Claude adapter');
  } finally {
    await r.close();
  }
});

test('the fix a Claude reviewer asks of a Codex author reopens the Codex session', async () => {
  const r = await rig({ scripts: { author: stuck, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] } });
  try {
    r.codex.authors.push(quickAuthor);
    const id = await stuckAuthor(r);
    const codexId = (await handOver(r, id, { harness: 'codex' })).json.session as SessionId;
    await until(() => r.codex.resumed.includes(codexId), 'the Codex author reopened for the fix');
    assert.ok(!r.claudeResumed.includes(codexId), 'the Codex author is not resumed through the Claude adapter (its Claude reviewer is)');
  } finally {
    await r.close();
  }
});

test('a stuck session the watchdog stopped is handed over: nothing to interrupt, its note from the journal, what it waited for settled', async () => {
  const r = await rig({ scripts: { author: edits } });
  try {
    r.codex.authors.push([started, ...text('c1', 'I carry on.'), { awaitMessage: true }, finished(0.2)]);
    const id = await stuckAuthor(r);
    assert.equal(await r.engine.idleStop(id), 'stopped', 'the watchdog parks the session that waits for a person');
    assert.equal(detail(r, id).dormant, true);
    assert.equal(detail(r, id).phase, 'stopped');
    assert.equal(r.inbox.waitingFor(id), 1, 'its permission still waits for an answer');

    const response = await handOver(r, id, { harness: 'codex' });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const target = r.codex.started[0]!;
    assert.match(target.input.prompt, /The sort is half done\./);
    assert.match(target.input.prompt, /src\/entries\.ts/);
    assert.equal(target.input.workdir, r.startedSessions[0]!.input.workdir);
    assert.equal(r.inbox.waitingFor(id), 0, 'what it waited for is settled');
    assert.equal(detail(r, id).phase, 'stopped');
    assert.equal(detail(r, id).dormant ?? false, false, 'no longer one the answer resumes');
    assert.equal(handedOverEvents(r, id).length, 1);
    assert.equal(handedOverEvents(r, target.id).length, 1);
    assert.equal(detail(r, target.id).phase, 'working');
    assert.deepEqual(r.claudeResumed, [], 'the Claude session was not resumed to be handed over');
    assert.ok(!r.flowEvents.some((e) => e.type === 'ticket_put_back'));
  } finally {
    await r.close();
  }
});

test('a dormant session whose target cannot start stays dormant, the answer still resumes it', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    await r.engine.idleStop(id);
    r.codex.failStart = true;
    assert.equal((await handOver(r, id, { harness: 'codex' })).status, 503);
    assert.equal(detail(r, id).dormant, true);
    assert.equal(r.inbox.waitingFor(id), 1);
    assert.equal(handedOverEvents(r, id).length, 0);
  } finally {
    await r.close();
  }
});

test('with the author tools on: a session whose plan had its Go is handed over, Codex finishes without a gate, Claude reviews', async () => {
  const r = await rig({
    scripts: { author: [started, proposal, finished(0.1), { awaitMessage: true }, started, ...text('a2', 'Working on it.'), { awaitMessage: true }, finished(0.2)] },
    config: { authorTools: true },
  });
  try {
    await r.engine.start(r.ticket.id, 'u1');
    await until(() => r.startedSessions.length > 0 && detail(r, r.startedSessions[0]!.id).state.plan !== undefined, 'the plan');
    await r.engine.settled();
    const id = r.startedSessions[0]!.id;
    await until(() => r.inbox.sessionPlan(id) !== undefined, 'the plan waiting for its Go');
    await r.engine.planGo(id, 'u1');
    await until(() => detail(r, id).state.plan?.go != null, 'the Go');
    const response = await handOver(r, id, { harness: 'codex' });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(r.codex.started[0]!.input.tools, undefined, 'a Codex author is given no host tools');
    await until(() => r.startedSessions.some((s) => s.input.role === 'reviewer'), 'the Claude review');
    assert.equal(r.startedSessions.find((s) => s.input.role === 'reviewer')!.input.harness, 'claude-code');
  } finally {
    await r.close();
  }
});

test('Cursor is out of the flows; so are the same harness, an unknown one and a missing body; nothing is touched by a refusal', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    const before = r.store.events.after(id).length;
    for (const body of [{ harness: 'cursor' }, { harness: 'claude-code' }, { harness: 'gemini' }, {}, undefined, { harness: 'codex', model: '' }, { harness: 'codex', model: 42 }, { harness: 'codex', model: 'gpt-6 --dangerously-bypass' }, { harness: 'codex', model: '-x' }, { harness: 'codex', model: 'm'.repeat(101) }]) {
      const refused = await handOver(r, id, body);
      assert.equal(refused.status, 400, `${JSON.stringify(body)} is refused`);
    }
    const cursor = await handOver(r, id, { harness: 'cursor' });
    assert.match(String(cursor.json.error), /cursor/i);
    assert.equal(r.store.events.after(id).length, before, 'nothing was journaled');
    assert.equal(r.inbox.waitingFor(id), 1, 'the permission still waits');
    assert.equal(detail(r, id).takenOver ?? null, null);
    assert.equal(r.codex.started.length, 0);
  } finally {
    await r.close();
  }
});

test('the route asks for the proof, a known user and the owner; an unknown session is 404; a stopped one is 409', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    const raw = (headers: Record<string, string>) => fetch(`${r.base}/api/sessions/${id}/handover`, { method: 'POST', headers, body: '{"harness":"codex"}' }).then((x) => x.status);
    assert.equal(await raw({ [SERVICE_USER_HEADER]: 'u1' }), 401);
    assert.equal(await raw({ [SERVICE_PROOF_HEADER]: PROOF }), 403);
    assert.equal(await raw({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'ghost' }), 403);
    assert.equal((await handOver(r, id, { harness: 'codex' }, 'u2')).status, 403, 'a second account');
    assert.equal((await handOver(r, 'missing', { harness: 'codex' })).status, 404);
    assert.equal(r.codex.started.length, 0);
    assert.equal((await handOver(r, id, { harness: 'codex' })).status, 200);
    assert.equal((await handOver(r, id, { harness: 'codex' })).status, 409, 'the source is stopped: it is not handed over twice');
    assert.equal(r.codex.started.length, 1);
  } finally {
    await r.close();
  }
});

test('a session whose plan waits for its Go is not handed over', async () => {
  const r = await rig({ scripts: { author: [started, proposal, finished(0.1), { awaitMessage: true }, started, finished(0.3)] }, config: { authorTools: true } });
  try {
    await r.engine.start(r.ticket.id, 'u1');
    await until(() => r.startedSessions.length > 0 && detail(r, r.startedSessions[0]!.id).state.plan !== undefined, 'the plan');
    await r.engine.settled();
    const id = r.startedSessions[0]!.id;
    const waiting = await handOver(r, id, { harness: 'codex' });
    assert.equal(waiting.status, 409);
    assert.match(String(waiting.json.error), /plan/i);
    assert.equal(r.codex.started.length, 0);
  } finally {
    await r.close();
  }
});

test('a taken over session is given back first', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    assert.equal((await post(r, `/api/sessions/${id}/takeover`)).status, 200);
    const refused = await handOver(r, id, { harness: 'codex' });
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), /taken over/);
    assert.equal(r.codex.started.length, 0);
  } finally {
    await r.close();
  }
});

test('without a Codex adapter the answer is 503 and the Claude session is left as it was', async () => {
  const r = await rig({ scripts: { author: stuck }, codex: false });
  try {
    const id = await stuckAuthor(r);
    const refused = await handOver(r, id, { harness: 'codex' });
    assert.equal(refused.status, 503);
    assert.match(String(refused.json.error), /codex/i);
    assert.equal(r.inbox.waitingFor(id), 1, 'the permission still waits: the session was not interrupted');
    assert.equal(detail(r, id).takenOver ?? null, null);
  } finally {
    await r.close();
  }
});

test('a Codex session that cannot start gives the Claude session back: working, not paused, not stopped', async () => {
  const r = await rig({ scripts: { author: stuck } });
  try {
    const id = await stuckAuthor(r);
    r.codex.failStart = true;
    const failed = await handOver(r, id, { harness: 'codex' });
    assert.equal(failed.status, 503);
    assert.match(String(failed.json.error), /could not be started/);
    await r.engine.settled();
    assert.equal(detail(r, id).takenOver ?? null, null, 'not left paused');
    assert.notEqual(detail(r, id).phase, 'stopped');
    assert.equal(handedOverEvents(r, id).length, 0, 'nothing says it was handed over');
    assert.ok(!r.flowEvents.some((e) => e.type === 'ticket_put_back'));
  } finally {
    await r.close();
  }
});

test('the note passes through the cleaner like everything the flow writes to a session', async () => {
  const r = await rig({ scripts: { author: stuck }, clean: (value) => value.replaceAll('sort the entries', '[cleaned]') });
  try {
    const id = await stuckAuthor(r);
    assert.equal((await handOver(r, id, { harness: 'codex' })).status, 200);
    const prompt = r.codex.started[0]!.input.prompt;
    assert.ok(!prompt.includes('sort the entries'));
    assert.match(prompt, /\[cleaned\]/);
  } finally {
    await r.close();
  }
});
