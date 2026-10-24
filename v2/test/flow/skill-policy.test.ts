// The flow's policyFor gives the skill ticket's author the one file the
// ticket asks for (O12): `skillFile` is set for a ticket the knowledge module
// made for a service (knowledge_skill_tickets), for no other ticket, and
// evaluate then allows that file under .claude/ and nothing else there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTables } from '../../src/store/db.ts';
import { KNOWLEDGE_TABLES } from '../../src/knowledge/store.ts';
import { skillPath } from '../../src/knowledge/skill.ts';
import { evaluate, type Policy } from '../../src/session/policy.ts';
import { finished, setup, started, text } from './support.ts';

const script = [started, ...text('a1', 'Done.'), finished(0.3)];
const write = (path: string) => ({ tool: 'Write', input: { file_path: path, content: 'x' } });

test('the author of a skill ticket may write its skill file, and only that file under .claude/', async () => {
  const t = await setup({ scripts: { author: script } });
  applyTables(t.store.db, KNOWLEDGE_TABLES);
  t.store.db.prepare('INSERT INTO knowledge_skill_tickets (ticket, service, day, asked_by, at) VALUES (?, ?, ?, NULL, ?)').run(t.ticket.id, 'guestbook', '2026-10-25', '2026-10-25T03:00:00.000Z');
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  const policy: Policy = t.engine.policyFor(author.input);
  assert.deepEqual(evaluate(write(`/workspace/${skillPath('guestbook')}`), policy), { decision: 'allow', rule: 'edit.skill' });
  for (const path of ['.claude/settings.json', skillPath('other'), '.claude/skills/cleared-guestbook/x.md'])
    assert.equal(evaluate(write(`/workspace/${path}`), policy).decision, 'ask', path);
  await t.engine.close();
});

test('an ordinary ticket, with or without the knowledge tables, has no skill file', async () => {
  const bare = await setup({ scripts: { author: script } });
  await bare.engine.start(bare.ticket.id, 'u1');
  assert.equal((bare.engine.policyFor(bare.startedSessions[0]!.input) as Policy & { skillFile?: string }).skillFile, undefined, 'no table');
  assert.equal(evaluate(write(`/workspace/${skillPath('guestbook')}`), bare.engine.policyFor(bare.startedSessions[0]!.input)).decision, 'ask');
  await bare.engine.close();

  const other = await setup({ scripts: { author: script } });
  applyTables(other.store.db, KNOWLEDGE_TABLES);
  await other.engine.start(other.ticket.id, 'u1');
  assert.equal(evaluate(write(`/workspace/${skillPath('guestbook')}`), other.engine.policyFor(other.startedSessions[0]!.input)).decision, 'ask', 'a table with no row for the ticket');
  await other.engine.close();
});
