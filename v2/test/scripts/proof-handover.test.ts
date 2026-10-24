// The simulated step of the milestone 3 proof (matrix B6.3p, P155): a stuck
// Claude session is handed over to Codex through the route the app calls, the
// Codex author finishes, Claude reviews it, and the ticket reaches the owner's
// release card. Fakes only: no Claude, no Codex, no account, no container.
// The real run is the owner's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverDecision, handoverReport } from '../../scripts/proof-handover.ts';
import { post, rig } from '../flow/handover-support.ts';
import { finished, permission, started, text, until } from '../flow/support.ts';

test('the decision hands over a stuck Claude author, waits for a working one, and refuses the rest', () => {
  const author = { id: 'a1', role: 'author', harness: 'claude-code', phase: 'waiting_human' } as const;
  assert.deepEqual(handoverDecision([author]), { kind: 'hand_over', session: 'a1', body: { harness: 'codex' } });
  assert.equal(handoverDecision([{ ...author, phase: 'working' }]).kind, 'wait');
  assert.equal(handoverDecision([{ ...author, takenOver: { by: 'u1', at: '2026-10-24T10:00:00.000Z' } }]).kind, 'refuse');
  assert.equal(handoverDecision([{ ...author, harness: 'codex' }]).kind, 'refuse');
  assert.equal(handoverDecision([{ ...author, harness: 'cursor' }]).kind, 'refuse');
  assert.equal(handoverDecision([{ ...author, phase: 'done' }]).kind, 'refuse');
  assert.equal(handoverDecision([{ ...author, role: 'reviewer' }]).kind, 'refuse');
  assert.equal(handoverDecision([]).kind, 'refuse');
});

test('the report fails what the sessions do not show', () => {
  const sessions = [
    { id: 'a1', role: 'author', harness: 'claude-code', phase: 'stopped' }, { id: 'a2', role: 'author', harness: 'codex', phase: 'done' },
    { id: 'r1', role: 'reviewer', harness: 'claude-code', phase: 'done' },
  ] as const;
  assert.equal(handoverReport(sessions).ok, true);
  assert.equal(handoverReport(sessions.slice(1)).ok, false);
  assert.match(handoverReport([sessions[0], sessions[1], { ...sessions[2], harness: 'codex' }]).lines.join('\n'), /FAILED: the reviewer ran on codex/);
  assert.match(handoverReport([{ ...sessions[0], phase: 'working' }, sessions[1], sessions[2]]).lines.join('\n'), /FAILED: the Claude author is working/);
});

test('a stuck Claude session is handed over from the app, Codex finishes the ticket, Claude reviews it, the release card waits for the owner', async () => {
  const r = await rig({ scripts: { author: [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)] } });
  try {
    r.codex.authors.push([started, ...text('c1', 'I read the checkout and finished the sort.'), finished(0.3)]);
    await r.engine.start(r.ticket.id, 'u1');
    await until(() => r.inbox.waitingFor(r.startedSessions[0]?.id ?? '') > 0, 'the stuck permission');
    await r.engine.settled();

    // The driver reads the sessions as the app does, decides, and posts what the decision says.
    const decision = handoverDecision(r.engine.sessions().filter((s) => s.ticket === r.ticket.id));
    assert.equal(decision.kind, 'hand_over');
    if (decision.kind !== 'hand_over') return;
    const answer = await post(r, `/api/sessions/${decision.session}/handover`, 'u1', decision.body);
    assert.equal(answer.status, 200);

    await until(() => r.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release card');
    await r.engine.settled();
    const report = handoverReport(r.engine.sessions().filter((s) => s.ticket === r.ticket.id));
    assert.deepEqual(report.lines.filter((l) => l.startsWith('FAILED')), []);
    assert.equal(report.ok, true);
    assert.equal(r.codex.started.length, 1, 'one Codex session, the author');
    assert.equal(r.startedSessions.filter((s) => s.input.role === 'reviewer').length, 1, 'one Claude review');
  } finally {
    await r.close();
  }
});
