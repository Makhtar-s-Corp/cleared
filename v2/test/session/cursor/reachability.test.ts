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
