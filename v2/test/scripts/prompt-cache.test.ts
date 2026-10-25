// The prompt cache on the reference fake run (issue #335, P219): the model
// of scripts/prompt-cache.ts, then what the run shows of Cleared's prefixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, firstRequest, measure, measureReferenceRun, referenceRun, runnerSystemPrompt, table, TTL_MS, type Block } from '../../scripts/prompt-cache.ts';

const MINUTE = 60_000;
const block = (key: string, tokens: number, entry = false): Block => ({ key, tokens, ...(entry ? { entry } : {}) });

test('a request is served the longest prefix that ends at an entry an earlier request wrote', () => {
  const tools = block('tools', 100, true);
  const result = measure([
    { label: 'first', at: 0, blocks: [tools, block('system A', 50, true), block('turn 1', 10, true)] },
    { label: 'same system', at: MINUTE, blocks: [tools, block('system A', 50, true), block('turn 2', 10, true)] },
    { label: 'other system', at: 2 * MINUTE, blocks: [tools, block('system B', 50, true), block('turn 1', 10, true)] },
    { label: 'nothing shared', at: 3 * MINUTE, blocks: [block('other tools', 100, true), block('system A', 50, true)] },
  ]);
  assert.deepEqual(result.requests.map((r) => [r.label, r.input, r.cached]), [
    ['first', 160, 0], ['same system', 160, 150], ['other system', 160, 100], ['nothing shared', 150, 0],
  ]);
  assert.equal(result.input, 630);
  assert.equal(result.cached, 250);
  assert.equal(result.share, 250 / 630);
});

test('a prefix is served only at an end where an entry was written, and only within the TTL of its last use', () => {
  const blocks = [block('a', 10), block('b', 10, true)];
  // Same bytes up to "a", but no entry ends there.
  assert.equal(measure([{ label: '1', at: 0, blocks }, { label: '2', at: MINUTE, blocks: [block('a', 10), block('c', 10, true)] }]).cached, 0);
  // Read at 4 minutes, the entry lives until 9.
  const kept = measure([0, 4, 9].map((m) => ({ label: `${m}`, at: m * MINUTE, blocks })));
  assert.deepEqual(kept.requests.map((r) => r.cached), [0, 20, 20]);
  const lost = measure([0, 6].map((m) => ({ label: `${m}`, at: m * MINUTE, blocks })));
  assert.deepEqual(lost.requests.map((r) => r.cached), [0, 0]);
  assert.equal(TTL_MS, 5 * MINUTE);
});

test('tokens are estimated at one per 4 bytes of UTF-8', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('é'.repeat(4)), 2);
});

test('the system prompt is read from the runner, the briefing appended', async () => {
  const prompt = await runnerSystemPrompt('# Briefing\n');
  assert.equal(prompt.type, 'preset');
  assert.equal(prompt.preset, 'claude_code');
  assert.equal(prompt.append, '# Briefing\n');
});

test('the reference run measures every session\'s first request, with Cleared\'s texts counted and the SDK\'s not', async () => {
  const sessions = referenceRun();
  assert.equal(sessions.length, 11);
  const first = await firstRequest(sessions[1]!);
  const counted = first.blocks.filter((b) => b.tokens > 0).map((b) => b.key.split(' ')[0]);
  assert.deepEqual(counted, ['host', 'briefing', 'turn']);
  const result = await measureReferenceRun();
  assert.equal(result.requests.length, 11);
  assert.ok(result.cached <= result.input);
  assert.match(table(result), /\| \*\*The run\*\* \| \*\*\d+\*\* \| \*\*\d+\*\* \| \*\*[\d.]+ %\*\* \|/);
});

// The change itself: the preset's per-session sections out of the system
// prompt, so that two tickets of a plan started together, whose briefings
// are the same, share the tools, the preset and the briefing.
test('two tickets started together with the same briefing share it: the per-session sections no longer stand before it', async () => {
  const result = await measureReferenceRun();
  const sessions = referenceRun();
  const of = (label: string) => result.requests.find((r) => r.label === label)!;
  const thirteen = sessions.find((s) => s.label === 'author LOCAL-13')!;
  assert.equal(thirteen.briefing, sessions.find((s) => s.label === 'author LOCAL-12')!.briefing, 'the same briefing');
  const tools = estimateTokens(JSON.stringify(thirteen.tools));
  assert.equal(of('author LOCAL-13').cached, tools + estimateTokens(thirteen.briefing));
  assert.equal(of('reviewer LOCAL-13').cached, estimateTokens(sessions.find((s) => s.label === 'reviewer LOCAL-13')!.briefing));
  // A ticket with an approved decision of its own has a briefing of its own: its first variant shares the tools only.
  assert.equal(of('author LOCAL-14, variant 1 of 3').cached, tools);
});
