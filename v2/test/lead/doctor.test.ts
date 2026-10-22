// The doctor's `lead` section (scripts/doctor-lead.ts): its one check is a
// real generation on this server, run only when the section is named; here
// its shape, the thresholds it derives, the same run on the fake adapter, and
// stop() which it relies on to clean up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUIET_MARGIN_TOKENS, REFRESH_MARGIN_TOKENS, deriveThresholds, leadChecks, tomorrowAtEight } from '../../scripts/doctor-lead.ts';
import { call, handsOver, leadSetup, opening, say, tokens, turn, until } from './support.ts';

test('the lead section has its one real check', () => {
  assert.equal(leadChecks.length, 1);
  assert.match(leadChecks[0]?.name ?? '', /real lead generation/);
});

// The doctor's thresholds follow the window: the same opening of tokens is
// a different share of a 200 000 and a 1 000 000-token window.
test('deriveThresholds: the handover point a margin past the opening, the threshold one largest answer past it, as shares of the window', () => {
  const million = deriveThresholds({ totalTokens: 23_001, maxTokens: 1_000_000 }, REFRESH_MARGIN_TOKENS);
  assert.ok(Math.abs(million.handoverPercent - 2.3101) < 1e-9, `${million.handoverPercent}`);
  assert.ok(Math.abs(million.contextPercent - 2.7101) < 1e-9, `${million.contextPercent}`);
  const small = deriveThresholds({ totalTokens: 23_001, maxTokens: 200_000 }, REFRESH_MARGIN_TOKENS);
  assert.ok(Math.abs(small.handoverPercent - 11.5505) < 1e-9, `${small.handoverPercent}`);
  assert.ok(Math.abs(small.contextPercent - 13.5505) < 1e-9, `${small.contextPercent}`);
  for (const t of [million, small]) assert.ok(t.contextPercent > t.handoverPercent);
  // The service's 5 % of old, on this window, is never met by one turn.
  assert.ok(million.contextPercent < 5);
});

test('tomorrowAtEight: an ISO time with its offset, as the commit tool wants', () => {
  const due = tomorrowAtEight(new Date(2026, 9, 22, 5, 0, 0));
  assert.match(due, /^2026-10-23T08:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(due).getTime(), new Date(2026, 9, 23, 8, 0, 0).getTime());
});

// The doctor's run on the fake adapter, with the measures of a real one on
// a 1 000 000-token window: Claude Code reports 2 % for both 23 001 and
// 23 600 tokens, so only the share of tokens crosses the derived handover
// point. Before this fix, generation 1 was never refreshed.
test('on a 1 000 000-token window, the derived thresholds refresh generation 1 after its first owner turn, and generation 2 answers without a refresh', async () => {
  const million = 1_000_000;
  const t = await leadSetup({ lead: [
    [
      ...opening(tokens(23_001, million)),
      ...turn('t1', call('t1-commit', 'commit', { text: 'Remind the owner to check the texts of the page.' }), tokens(23_400, million), say('r1', 'I will remind you.'), tokens(23_600, million)),
      ...handsOver('t2', 'One reminder is open.'),
    ],
    [...opening(tokens(26_000, million)), ...turn('g2t1', say('g2r1', 'Open: c1, remind the owner to check the texts of the page.'), tokens(26_500, million))],
  ] });
  await t.lead.settled();
  const config = t.deps.config as { -readonly [K in keyof typeof t.deps.config]: (typeof t.deps.config)[K] };
  const derive = (margin: number) => {
    const opening = t.lead.state().context;
    assert.ok(opening);
    Object.assign(config, deriveThresholds(opening, margin));
  };
  derive(REFRESH_MARGIN_TOKENS);
  assert.equal(t.lead.state().context?.percent, 2);

  await t.lead.post('Promise me a reminder.', 'doctor');
  await until(() => t.generations.length === 2 && t.lead.state().phase === 'idle', 'the refresh after the first owner turn');
  assert.equal(t.lead.state().generation, 2);
  assert.equal(t.lead.state().refreshCount, 1);
  assert.ok(t.lead.messages().some((m) => m.text === 'I will remind you.'), 'the turn that crossed the handover point was not interrupted');
  assert.match(t.briefings[1] ?? '', /c1/);

  // Generation 2's opening is larger than generation 1's thresholds: it is
  // measured, and generation 2's own thresholds are derived from it.
  assert.equal(t.lead.state().context?.totalTokens, 26_000);
  derive(QUIET_MARGIN_TOKENS);
  await t.lead.post('Which commitment do you have open?', 'doctor');
  await until(() => t.lead.messages().some((m) => m.by === 'lead' && m.text.startsWith('Open: c1')), 'the answer of generation 2');
  await t.lead.settled();
  assert.equal(t.generations.length, 2, 'generation 2 was not refreshed');
  assert.equal(t.lead.state().generation, 2);
});

test('stop() stops the live generation\'s session and starts no other', async () => {
  const t = await leadSetup();
  await t.lead.settled();
  await t.lead.stop();
  await t.lead.tick();
  assert.equal(t.generations.length, 1);
  assert.equal(t.generations[0]?.stopped(), true);
  assert.equal(t.store.sessions.get(t.generations[0]?.id as string)?.status, 'stopped');
  assert.equal(t.lead.state().phase, 'down');
});
