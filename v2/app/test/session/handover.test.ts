// Hand over to Codex, and back (matrix B6.3, P153): the session screen offers
// the action on a live author's session when nobody has taken it over, to
// the other harness of the contract; Cursor's session, a reviewer's, an
// ended session and a taken over one get none. Both languages say it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handoverOf } from '../../web/screens/session/tabs.ts';

const free = { kind: 'free', can: true } as const;
const base = { takeover: free, role: 'author', harness: 'claude-code', ended: false } as const;

test('a live Claude author is offered Codex, and a live Codex author is offered Claude', () => {
  assert.deepEqual(handoverOf(base), { kind: 'offer', to: 'codex' });
  assert.deepEqual(handoverOf({ ...base, harness: 'codex' }), { kind: 'offer', to: 'claude-code' });
});

test('no offer for Cursor, a reviewer, the lead, an ended session, a taken over one, or a teammate\'s take over', () => {
  assert.deepEqual(handoverOf({ ...base, harness: 'cursor' }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, role: 'reviewer' }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, role: 'lead' }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, ended: true }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, takeover: { kind: 'mine', at: '2026-10-24T10:00:00.000Z' } }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, takeover: { kind: 'other', at: '2026-10-24T10:00:00.000Z' } }), { kind: 'none' });
  assert.deepEqual(handoverOf({ ...base, takeover: { kind: 'free', can: false } }), { kind: 'none' });
});

test('the words exist in English and in French, with the same keys', () => {
  const read = (language: string) => JSON.parse(readFileSync(new URL(`../../messages/session.${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;
  const en = read('en');
  const fr = read('fr');
  for (const key of ['handover_to_codex', 'handover_to_claude_code', 'handover_note', 'handover_failed', 'handover_done']) {
    assert.ok(en[key], `${key} in English`);
    assert.ok(fr[key], `${key} in French`);
  }
  assert.equal(en.handover_to_codex, 'Hand over to Codex');
  assert.equal(fr.handover_to_codex, 'Confier à Codex');
});
