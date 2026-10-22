// "Never loses a commitment" as a property of the service (decision 4): 300
// random steps of commit, fulfil, event turn and refresh, and after each
// refresh every open commitment is in the new generation's briefing.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { UserMessage } from '../../src/session/contract.ts';
import { finishedEvent, flowEvent, leadSetup, puppetAdapter, until, type Puppet } from './support.ts';

// A small seeded generator (mulberry32), so a failure replays.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('after every refresh of 300 random steps, every open commitment is in the new briefing', async () => {
  const seed = Number(process.env.LEAD_PROPERTY_SEED ?? 20261022);
  const next = random(seed);
  const puppets: Puppet[] = [];
  // What the next turn does: rise above the handover point, and whether
  // the lead then writes its handover or leaves it to the machine.
  const plan = { rise: false, writes: true };
  let turns = 0;
  const respond = async (puppet: Puppet, message: UserMessage) => {
    const runId = `turn-${++turns}`;
    puppet.emit({ type: 'RUN_STARTED', threadId: puppet.id, runId });
    if (message.text.includes('handover')) {
      if (plan.writes) await puppet.callTool('handover', { summary: `Handover at ${runId}.` });
    } else if (plan.rise) {
      puppet.measure(45);
      plan.rise = false;
    } else puppet.measure(10 + Math.floor(next() * 20));
    puppet.emit(finishedEvent(runId));
  };
  const t = await leadSetup({ adapter: (log) => puppetAdapter(log, respond, puppets) });
  const live = () => puppets.at(-1) as Puppet;
  let refreshes = 0;
  let commits = 0;

  for (let step = 0; step < 300; step++) {
    const roll = next();
    const open = t.lead.memory().commitments.filter((c) => c.state === 'open');
    if (roll < 0.35 && open.length < 20) {
      await live().callTool('commit', { text: `Commitment number ${++commits} of step ${step}.`, ...(next() < 0.3 ? { due: new Date(t.clock.now + 3600_000).toISOString() } : {}) });
    } else if (roll < 0.55 && open.length > 0) {
      const target = open[Math.floor(next() * open.length)];
      await live().callTool('fulfil', { id: target?.id, note: `Done at step ${step}.` });
    } else if (roll < 0.85) {
      t.emitFlow(flowEvent({ type: 'ticket_started', ticket: `LOCAL-${step}` }));
      t.clock.now += 61_000;
      await t.lead.tick();
      await t.lead.settled();
    } else {
      // A refresh: the next turn's share crosses the handover point.
      const before = t.lead.state().generation;
      plan.rise = true;
      plan.writes = next() < 0.7;
      await t.lead.post(`Owner message at step ${step}`, 'u1');
      await until(() => t.lead.state().generation === before + 1 && t.lead.state().phase === 'idle', `the refresh at step ${step} (seed ${seed})`);
      await t.lead.settled();
      refreshes++;
      const briefing = t.briefings.at(-1) ?? '';
      for (const commitment of t.lead.memory().commitments.filter((c) => c.state === 'open')) {
        assert.ok(briefing.includes(commitment.id) && briefing.includes(commitment.text), `step ${step}, seed ${seed}: ${commitment.id} is missing from generation ${before + 1}'s briefing`);
      }
    }
  }
  assert.ok(refreshes >= 20, `only ${refreshes} refreshes`);
  assert.ok(commits >= 50, `only ${commits} commitments`);
  assert.equal(t.lead.messages().filter((m) => m.kind === 'refresh').length, refreshes);
});
