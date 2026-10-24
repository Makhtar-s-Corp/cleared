// Issue #294, follow-up 3: the Cursor harness is not yet shown to fail closed
// (docs/adapters.md, "Needs a real Cursor trial by the owner"), so no engine
// may start a session on it. This pins the three places that choose a harness;
// the lane that makes the harness a per-project or per-ticket choice changes
// this test with the trial's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['src/flow/engine.ts', 'src/lead/engine.ts', 'src/reader/service.ts']) {
  test(`${file} starts every session on claude-code until the owner's Cursor trial`, () => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /^const HARNESS = 'claude-code' as const;$/m);
    assert.ok(!/harness:\s*'cursor'/.test(source));
  });
}

// B6.3 (P150): the flow may now start a Codex session, by a handover, but the
// targets it names are the contract's two and Cursor is not one.
test('the flow hands over to claude-code and codex only: Cursor is out of the targets', () => {
  const source = readFileSync(new URL('../../../src/session/handover.ts', import.meta.url), 'utf8');
  assert.match(source, /^export const HANDOVER_HARNESSES = \['claude-code', 'codex'\] as const;$/m);
  assert.ok(!/harness:\s*'cursor'/.test(source));
  const engine = readFileSync(new URL('../../../src/flow/engine.ts', import.meta.url), 'utf8');
  assert.match(engine, /refuseTarget\(live\.input\.harness, target\)/);
});
