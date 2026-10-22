// Knowledge proposed, approved in the inbox, then landed in the skill
// (docs/v2/milestone-2-plan.md, decision 27, lane 24): a handover's lessons
// and decisions become `knowledge` inbox items; Approve writes the entry into
// lib/memory at its level at once and queues it for the skill of each
// service it concerns; Reject writes nothing; once a day, or on "Update the
// skill now", a Quick ticket per service asks for the skill file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeItem } from '../../src/api/types.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import approvalModule from '../../src/modules/approval.ts';
import { createKnowledgeModule } from '../../src/modules/knowledge.ts';
import ticketsModule from '../../src/modules/tickets.ts';
import usersModule from '../../src/modules/users.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { KNOWLEDGE_TABLES } from '../../src/knowledge/store.ts';
import { Knowledge, KnowledgeError, SKILL_HOUR, type KnowledgeDeps, type MemoryWrite } from '../../src/knowledge/service.ts';
import { checkSkill, skillOfTicket } from '../../src/knowledge/skill.ts';
import { cleanText } from '../../src/session/clean.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import { levelContext, runMemory, type MemoryContext } from '../../src/workspace/briefing.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { LESSON_HEADINGS, captureHandover, setHandoverSink } from '../../src/workspace/handover.ts';
import { AGENTS_CONF, plantedKey, remote, tempDir } from '../workspace/git.ts';

const SESSION = '7a1d3c5e-2b4f-4e6a-8c0d-1e2f3a4b5c6d';
const LATER = '0b2e4d6f-8a1c-4e3b-9d5f-7a9c1e3b5d7f';
const OWNER = { id: 'u1', name: 'owner' };
const OTHER = { id: 'u2', name: 'someone' };
const HANDOVER = ['## Done', 'The severity answer.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'The page.',
  '## Where the artifacts are (screenshots, logs, branches)', 'cleared/DEMO-8', '## Open questions', 'None.', ''].join('\n');

const service = (name: string, dir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example/${name}`, url: `file://${dir}`, base: 'main', path: null, healthUrl: null, sensitivity: 'normal',
  consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, dir, ...extra,
});

// The guestbook (the workspace's checkout, its first service), which
// consumes the filter API, which provides the contract; a clock at 10:00
// local time unless a test moves it.
async function two(options: { now?: () => Date; write?: MemoryWrite; ownerId?: string | undefined } = {}) {
  const root = tempDir('knowledge');
  const guestbook = await projectCheckout({ url: remote({ '.cleared/agents.conf': AGENTS_CONF }), dir: join(root, 'guestbook'), base: 'main' });
  const filter = await projectCheckout({
    url: remote({ '.cleared/agents.conf': AGENTS_CONF, 'contract/openapi.yaml': 'openapi: 3.0.3\n' }),
    dir: join(root, 'filter-api'), base: 'main',
  });
  const state = join(root, 'state');
  const env = { CLEARED_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db') };
  const workspace: WorkspaceConfig = {
    id: 'guestbook', name: 'Guestbook', file: '/srv/workspace.conf',
    services: [
      service('guestbook', guestbook.dir, { consumes: ['filter-api'] }),
      service('filter-api', filter.dir, { contract: { format: 'openapi', path: 'contract/openapi.yaml' } }),
    ],
  };
  const db = new DatabaseSync(':memory:');
  db.exec(INBOX_TABLE);
  for (const table of KNOWLEDGE_TABLES) db.exec(table);
  let clock = new Date(2026, 9, 22, 10, 0, 0);
  const now = options.now ?? (() => clock);
  const tickets = new MemoryTicketStore();
  const memory: MemoryContext = { project: guestbook.dir, env };
  const deps: KnowledgeDeps = {
    db, inbox: new InboxStore(db, now), tickets, workspace, memory, ownerId: 'ownerId' in options ? options.ownerId : OWNER.name,
    clean: (text) => cleanText(text, {}), now, serviceOf: () => undefined, ...(options.write ? { write: options.write } : {}),
  };
  const knowledge = new Knowledge(deps);
  const levels = {
    filter: levelContext(memory, { kind: 'service', name: 'filter-api', project: filter.dir }),
    contract: levelContext(memory, { kind: 'contract', name: 'filter-api', project: filter.dir, contract: 'contract/openapi.yaml' }),
  };
  return {
    root, state, env, guestbook: guestbook.dir, filter: filter.dir, db, tickets, knowledge, memory, levels, deps,
    at: (date: Date) => { clock = date; },
  };
}

type Two = Awaited<ReturnType<typeof two>>;

// A handover written in a ticket checkout of the filter API, then captured
// as the flow captures it, with the knowledge module listening.
async function handover(t: Two, sections: string): Promise<KnowledgeItem[]> {
  const dir = join(t.root, `w-${Math.random().toString(36).slice(2)}`);
  await ticketCheckout({ project: t.filter, workdir: dir, base: 'main', branch: 'cleared/DEMO-8' });
  writeFileSync(join(dir, 'HANDOVER.md'), `${HANDOVER}${sections}`);
  setHandoverSink((captured) => { t.knowledge.propose(captured); });
  try {
    const id = await captureHandover({ ...t.memory, workdir: dir, role: 'author', model: 'claude-opus-5-5', ticket: 'DEMO-8', sessionId: SESSION, service: t.levels.filter, contract: t.levels.contract });
    assert.equal(typeof id, 'string');
  } finally {
    setHandoverSink(undefined);
  }
  return t.deps.inbox.knowledge();
}

// lib/memory's rows of a ledger, as written.
const rows = (file: string) => {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT type, scope, content, source_who, source_where, status FROM memory_entries WHERE source_who != 'script:file-index' ORDER BY rowid").all().map((row) => ({ ...row })); }
  finally { db.close(); }
};
const ledgers = (t: Two) => ({
  workspace: join(t.state, 'ledger.db'),
  service: join(t.state, 'services', 'filter-api', 'memory', 'ledger.db'),
  contract: join(t.state, 'contracts', 'filter-api', 'memory', 'ledger.db'),
});

const THREE = `${LESSON_HEADINGS.workspace}\nRun every service's tests before a release.\n${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n## Decisions for the contract\nPOST /check answers a severity with every refusal.\n`;

test('a handover with two lessons and one decision produces three knowledge items, each at its level', async () => {
  const t = await two();
  const items = await handover(t, THREE);
  assert.deepEqual(items.map((i) => [i.level, i.service, i.text]), [
    ['workspace', null, "Run every service's tests before a release."],
    ['service', 'filter-api', 'Keep words.txt sorted.'],
    ['contract', 'filter-api', 'POST /check answers a severity with every refusal.'],
  ]);
  for (const item of items) {
    assert.deepEqual([item.kind, item.ticket, item.project, item.sessionId, item.state, item.outcome], ['knowledge', 'DEMO-8', 'guestbook', SESSION, 'waiting', null]);
  }
});

test('a proposal\'s text goes through the cleaner before the inbox shows it', async () => {
  const t = await two();
  const [item] = await handover(t, `${LESSON_HEADINGS.service}\nThe key ${plantedKey} opened the filter's admin page.\n`);
  assert.ok(item);
  assert.doesNotMatch(item.text, new RegExp(plantedKey));
  assert.match(item.text, /\[removed: API key\]/);
});

test('a session on the workspace\'s own service proposes its service lessons for that service, and a contract it consumes', async () => {
  const t = await two();
  const items = t.knowledge.propose({ ticket: 'DEMO-9', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nThe guestbook renders on the server.\n## Decisions for the contract\nThe guestbook sends the text whole.\n`, service: 'guestbook' });
  assert.deepEqual(items.map((i) => [i.level, i.service]), [['service', 'guestbook'], ['contract', 'filter-api']]);
  // A service with no contract of its own or consumed: its contract entries are the workspace's.
  const lone = await two();
  const deps = { ...lone.deps, workspace: { ...lone.deps.workspace, services: [service('guestbook', lone.guestbook)] } };
  const alone = new Knowledge(deps).propose({ ticket: 'DEMO-9', sessionId: SESSION, content: `${HANDOVER}## Decisions for the contract\nNo contract here.\n` });
  assert.deepEqual(alone.map((i) => [i.level, i.service]), [['workspace', null]]);
});

test('Approve writes the entry at its level at once, so the next briefing has it, and queues it for the skill', async () => {
  const t = await two();
  const items = await handover(t, THREE);
  const [workspace, filterLesson, contract] = items as [KnowledgeItem, KnowledgeItem, KnowledgeItem];
  const before = { workspace: rows(ledgers(t).workspace).length, service: rows(ledgers(t).service).length, contract: rows(ledgers(t).contract).length };
  await t.knowledge.approve(filterLesson.id, OWNER);
  // Written once, approved by the owner, in the service's own ledger only.
  const written = rows(ledgers(t).service).slice(before.service);
  assert.deepEqual(written, [{
    type: 'decision', scope: 'project:filter-api', content: 'Lesson: Keep words.txt sorted.', source_who: 'human:owner', source_where: filterLesson.id, status: 'approved',
  }]);
  assert.equal(rows(ledgers(t).workspace).length, before.workspace);
  // The next briefing of a ticket that names the words carries it.
  const briefed = await runMemory(t.levels.filter, { command: 'briefing', role: 'author', ticket: { id: 'DEMO-10', title: 'Sort the words', body: 'words.txt grows.' } }) as { entries: { type: string; content: string }[] };
  assert.ok(briefed.entries.some((e) => e.type === 'decision' && e.content === 'Lesson: Keep words.txt sorted.'));
  // The item is handled, by the owner.
  const handled = t.deps.inbox.item(filterLesson.id) as KnowledgeItem;
  assert.equal(handled.state, 'handled');
  assert.equal(handled.outcome?.decision, 'approve');
  assert.equal(handled.outcome?.by, OWNER.id);
  // Queued for the filter API's skill only.
  assert.deepEqual(t.knowledge.queued('filter-api').map((e) => e.text), ['Keep words.txt sorted.']);
  assert.deepEqual(t.knowledge.queued('guestbook'), []);

  // The workspace's decision goes to the workspace's ledger and every service's skill;
  // the contract's to its own ledger, the provider's skill and its consumers'.
  await t.knowledge.approve(workspace.id, OWNER);
  await t.knowledge.approve(contract.id, OWNER);
  assert.deepEqual(rows(ledgers(t).workspace).slice(before.workspace).map((r) => [r.type, r.content, r.status]), [['decision', "Lesson: Run every service's tests before a release.", 'approved']]);
  assert.deepEqual(rows(ledgers(t).contract).slice(before.contract).map((r) => [r.type, r.content, r.status]), [['decision', 'POST /check answers a severity with every refusal.', 'approved']]);
  assert.deepEqual(t.knowledge.queued('filter-api').map((e) => e.level), ['service', 'workspace', 'contract']);
  assert.deepEqual(t.knowledge.queued('guestbook').map((e) => e.level), ['workspace', 'contract']);
});

test('Approve of a service lesson on the workspace\'s own service writes it in the workspace\'s memory', async () => {
  const t = await two();
  const [item] = t.knowledge.propose({ ticket: 'DEMO-9', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nThe guestbook renders on the server.\n`, service: 'guestbook' });
  assert.ok(item);
  await t.knowledge.approve(item.id, OWNER);
  assert.deepEqual(rows(ledgers(t).workspace).map((r) => r.content), ['Lesson: The guestbook renders on the server.']);
  assert.equal(existsSync(join(t.state, 'services', 'guestbook')), false);
});

test('Reject writes nothing', async () => {
  const t = await two();
  const items = await handover(t, THREE);
  const before = { workspace: rows(ledgers(t).workspace), service: rows(ledgers(t).service), contract: rows(ledgers(t).contract) };
  for (const item of items) await t.knowledge.reject(item.id, OWNER);
  assert.deepEqual({ workspace: rows(ledgers(t).workspace), service: rows(ledgers(t).service), contract: rows(ledgers(t).contract) }, before);
  assert.deepEqual([t.knowledge.queued('filter-api'), t.knowledge.queued('guestbook')], [[], []]);
  assert.deepEqual(t.deps.inbox.knowledge({ state: 'handled' }).map((i) => [i.state, i.outcome?.decision, i.outcome?.by]), [
    ['handled', 'reject', OWNER.id], ['handled', 'reject', OWNER.id], ['handled', 'reject', OWNER.id],
  ]);
});

test('only the owner answers; an item is answered once, and a double click writes once', async () => {
  const writes: string[] = [];
  const t = await two({ write: async (_context, entry) => { writes.push(entry.content); await new Promise((resolve) => setTimeout(resolve, 20)); return 'm1'; } });
  const [item] = t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n`, service: 'filter-api' });
  assert.ok(item);
  await assert.rejects(t.knowledge.approve(item.id, OTHER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'forbidden' && /owner/.test(e.message));
  await assert.rejects(t.knowledge.reject(item.id, OTHER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'forbidden');
  await assert.rejects(t.knowledge.approve('knowledge:none:1', OWNER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'not_found');
  const both = await Promise.allSettled([t.knowledge.approve(item.id, OWNER), t.knowledge.approve(item.id, OWNER)]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.ok(both[1]?.status === 'rejected' && both[1].reason instanceof KnowledgeError && both[1].reason.kind === 'conflict');
  assert.deepEqual(writes, ['Lesson: Keep words.txt sorted.']);
  await assert.rejects(t.knowledge.reject(item.id, OWNER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'conflict');
  assert.equal(t.knowledge.queued('filter-api').length, 1);

  // With no [tracker] owner_id, nobody approves: the service is not set up.
  const unset = await two({ ownerId: undefined, write: async () => 'm1' });
  const [other] = unset.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.workspace}\nA.\n` });
  assert.ok(other);
  await assert.rejects(unset.knowledge.approve(other.id, OWNER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'unavailable' && /owner_id/.test(e.message));
});

test('a memory that cannot be written leaves the item waiting, with nothing queued', async () => {
  const t = await two({ write: async () => { throw new Error('memory: the ledger is locked'); } });
  const [item] = t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n`, service: 'filter-api' });
  assert.ok(item);
  await assert.rejects(t.knowledge.approve(item.id, OWNER), /ledger is locked/);
  assert.equal(t.deps.inbox.item(item.id)?.state, 'waiting');
  assert.deepEqual(t.knowledge.queued('filter-api'), []);
});

test('once a day, from the skill hour, one Quick ticket per service with queued entries, the whole file in its body', async () => {
  const t = await two({ write: async () => 'm1' });
  const approve = async (content: string, sessionService = 'filter-api') => {
    for (const item of t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${content}`, service: sessionService })) await t.knowledge.approve(item.id, OWNER);
  };
  await approve(`${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n`);
  // Before the skill hour, nothing.
  t.at(new Date(2026, 9, 23, SKILL_HOUR - 1, 59));
  assert.deepEqual(await t.knowledge.tick(), []);
  t.at(new Date(2026, 9, 23, SKILL_HOUR, 0));
  const first = await t.knowledge.tick();
  assert.equal(first.length, 1);
  const ticket = await t.tickets.get(first[0] as string);
  assert.ok(ticket);
  assert.deepEqual([ticket.labels, ticket.project, ticket.status, ticket.services?.map((s) => s.name)], [['Quick'], 'guestbook', t.tickets.states.todo, ['filter-api']]);
  assert.match(ticket.title, /cleared-filter-api/);
  assert.match(ticket.body, /- Keep words\.txt sorted\./);
  assert.deepEqual(checkSkill(skillOfTicket(ticket.body) ?? '', 'filter-api'), []);
  // The queue is empty now; a second tick the same day creates nothing, even with a new entry.
  assert.deepEqual(t.knowledge.queued('filter-api'), []);
  await approve(`${LESSON_HEADINGS.service}\nThe list is read once at start.\n`);
  t.at(new Date(2026, 9, 23, 22, 0));
  assert.deepEqual(await t.knowledge.tick(), []);
  // The next day: a new ticket, with every approved entry of the service, the old one included.
  t.at(new Date(2026, 9, 24, SKILL_HOUR, 5));
  const second = await t.knowledge.tick();
  assert.equal(second.length, 1);
  const body = (await t.tickets.get(second[0] as string))?.body ?? '';
  assert.match(body, /- Keep words\.txt sorted\.\n- The list is read once at start\./);
  assert.match((await t.tickets.get(second[0] as string))?.title ?? '', /\(1 new approved entry\)/);
  // An empty queue makes no ticket.
  t.at(new Date(2026, 9, 25, SKILL_HOUR, 5));
  assert.deepEqual(await t.knowledge.tick(), []);
  assert.equal((await t.tickets.list()).length, 2);
});

test('a workspace entry makes a ticket for every service; a one-service workspace\'s ticket names no service', async () => {
  const t = await two({ write: async () => 'm1' });
  for (const item of t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.workspace}\nEvery service answers /health.\n` })) await t.knowledge.approve(item.id, OWNER);
  t.at(new Date(2026, 9, 23, SKILL_HOUR, 0));
  const made = await t.knowledge.tick();
  const titles = await Promise.all(made.map(async (id) => (await t.tickets.get(id))?.title));
  assert.deepEqual(titles, ['Update the skill cleared-guestbook (1 new approved entry)', 'Update the skill cleared-filter-api (1 new approved entry)']);

  const lone = await two({ write: async () => 'm1' });
  const deps = { ...lone.deps, workspace: { ...lone.deps.workspace, file: null, services: [service('guestbook', lone.guestbook)] } };
  const k = new Knowledge(deps);
  for (const item of k.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.workspace}\nA lesson.\n` })) await k.approve(item.id, OWNER);
  lone.at(new Date(2026, 9, 23, SKILL_HOUR, 0));
  const [id] = await k.tick();
  assert.equal((await lone.tickets.get(id as string))?.services, undefined);
});

test('"Update the skill now" makes the ticket at once, even after the daily one; nothing queued makes none', async () => {
  const t = await two({ write: async () => 'm1' });
  assert.equal(await t.knowledge.updateSkill('filter-api', OWNER), null);
  await assert.rejects(t.knowledge.updateSkill('payments', OWNER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'not_found');
  await assert.rejects(t.knowledge.updateSkill('filter-api', OTHER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'forbidden');
  for (const item of t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n`, service: 'filter-api' })) await t.knowledge.approve(item.id, OWNER);
  t.at(new Date(2026, 9, 23, SKILL_HOUR, 0));
  assert.equal((await t.knowledge.tick()).length, 1);
  for (const item of t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content: `${HANDOVER}${LESSON_HEADINGS.service}\nThe list is read once at start.\n`, service: 'filter-api' })) await t.knowledge.approve(item.id, OWNER);
  const now = await t.knowledge.updateSkill('filter-api', OWNER);
  assert.ok(now);
  const ticket = await t.tickets.get(now);
  assert.match(ticket?.body ?? '', /The list is read once at start\./);
  const comments = await t.tickets.comments(now);
  assert.match(comments.map((c) => c.body).join('\n'), /Asked by owner \("Update the skill now"\)/);
  assert.deepEqual(t.knowledge.queued('filter-api'), []);
});

test('a ticket\'s later handover does not propose again what an earlier one proposed, waiting or answered', async () => {
  const t = await two({ write: async () => 'm1' });
  const content = `${HANDOVER}${LESSON_HEADINGS.service}\n- Keep words.txt sorted.\n- The list is read once at start.\n`;
  const first = t.knowledge.propose({ ticket: 'DEMO-8', sessionId: SESSION, content, service: 'filter-api' });
  assert.equal(first.length, 2);
  await t.knowledge.approve((first[0] as KnowledgeItem).id, OWNER);
  // The author reopened after a review writes its handover again, with one lesson more.
  const again = t.knowledge.propose({ ticket: 'DEMO-8', sessionId: LATER, content: `${content}- Words are matched whole.\n`, service: 'filter-api' });
  assert.deepEqual(again.map((i) => i.text), ['Words are matched whole.']);
  // The same lesson at another level, or from another ticket, is proposed.
  assert.equal(t.knowledge.propose({ ticket: 'DEMO-8', sessionId: LATER, content: `${HANDOVER}${LESSON_HEADINGS.workspace}\nKeep words.txt sorted.\n` }).length, 1);
  assert.equal(t.knowledge.propose({ ticket: 'DEMO-9', sessionId: LATER, content, service: 'filter-api' }).length, 2);
});

test('the configured module listens to the stored handovers and lets the owner of the settings approve', async () => {
  const t = await two();
  const conf = join(t.root, 'agents.conf');
  writeFileSync(conf, `${AGENTS_CONF}[tracker]\nowner_id = owner\n`);
  const env: NodeJS.ProcessEnv = {
    HOME: join(t.root, 'home'), CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: t.guestbook,
    CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git', CLEARED_V2_REPO: 'example-org/cleared-example-guestbook',
    CLEARED_V2_STATE_DIR: join(t.root, 'v2-state'), CLEARED_CONF: conf, CLEARED_STATE_DIR: t.state, ORCH_LEDGER: join(t.state, 'ledger.db'),
  };
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...KNOWLEDGE_TABLES, ...usersModule.tables, ...ticketsModule.tables, ...approvalModule.tables]);
  const module = createKnowledgeModule({ env, intervalMs: 3_600_000 });
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => { logged.push(line); };
  try { assert.deepEqual(module.provide({ store }), {}); }
  finally { console.error = error; }
  const knowledge = module.knowledge();
  assert.ok(knowledge);
  try {
    const dir = join(t.root, 'w-guestbook');
    await ticketCheckout({ project: t.guestbook, workdir: dir, base: 'main', branch: 'cleared/DEMO-8' });
    writeFileSync(join(dir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.workspace}\nRun every service's tests before a release.\n`);
    await captureHandover({ project: t.guestbook, env, workdir: dir, role: 'author', model: 'claude-opus-5-5', ticket: 'DEMO-8', sessionId: SESSION });
    const [item, ...more] = new InboxStore(store.db).knowledge();
    assert.ok(item);
    assert.deepEqual(more, []);
    assert.deepEqual([item.project, item.ticket, item.level, item.text], ['guestbook', 'DEMO-8', 'workspace', "Run every service's tests before a release."]);
    await assert.rejects(knowledge.approve(item.id, OTHER), (e: unknown) => e instanceof KnowledgeError && e.kind === 'forbidden');
    await knowledge.approve(item.id, OWNER);
    assert.deepEqual(rows(ledgers(t).workspace).filter((r) => r.type === 'decision').map((r) => [r.content, r.status, r.source_who]),
      [["Lesson: Run every service's tests before a release.", 'approved', 'human:owner']]);
  } finally {
    setHandoverSink(undefined);
    knowledge.stop();
  }
});
