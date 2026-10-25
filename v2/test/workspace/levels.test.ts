// The three memory levels (docs/v2/milestone-2-plan.md, decision 25, lane
// 19): lib/memory run once for the workspace, once for the session's
// service, once for each contract its ticket touches, each in its own state
// folder, in one byte budget; a handover's lessons filed in the level the
// author names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REFERENCE_LINE, levelContext, levelDirectory, readLeveledBriefing, renderBriefing } from '../../src/workspace/briefing.ts';
import { DECISION_HEADINGS } from '../../src/knowledge/proposals.ts';
import { LESSON_HEADINGS, captureHandover, lessonsOf } from '../../src/workspace/handover.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import { AGENTS_CONF, remote, tempDir } from './git.ts';

const TICKET = { id: 'DEMO-8', title: 'Flag an Entry for review', body: 'The filter answers a severity.' };
const SESSION = '7a1d3c5e-2b4f-4e6a-8c0d-1e2f3a4b5c6d';

const HANDOVER = ['## Done', 'The severity answer.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'The page.',
  '## Where the artifacts are (screenshots, logs, branches)', 'cleared/DEMO-8', '## Open questions', 'None.', ''].join('\n');

// The workspace's checkout (its first service, the guestbook), the filter
// API's checkout, which provides the contract, and their state folder.
async function three(options: { budget?: number; contractPage?: string } = {}) {
  const root = tempDir('levels');
  const workspace = await projectCheckout({
    url: remote({
      '.cleared/agents.conf': `${AGENTS_CONF}[memory]\nbudget = ${options.budget ?? 12000}\n`,
      'docs/project.md': '# Guestbook\nThe workspace: a guestbook and the filter it calls.\n',
      '.cleared/prompts/author/lessons.md': 'Workspace lesson: run every service\'s tests.\n',
    }),
    dir: join(root, 'guestbook'), base: 'main',
  });
  const service = await projectCheckout({
    url: remote({
      // A budget of its own, which the shared budget overrides.
      '.cleared/agents.conf': `${AGENTS_CONF}[memory]\nbudget = 100000\n`,
      'docs/project.md': '# Filter API\nThe service: it checks an entry\'s words.\n',
      '.cleared/prompts/author/lessons.md': 'Service lesson: keep words.txt sorted.\n',
      'contract/openapi.yaml': 'openapi: 3.0.3\n',
      'contract/openapi.md': options.contractPage ?? '# The check contract\nPOST /check answers allowed, and a severity.\n',
    }),
    dir: join(root, 'filter-api'), base: 'main',
  });
  // The state folder is named both ways, as the brokers' ledger is named by
  // ORCH_LEDGER (decision 21): neither may pull a level into another's file.
  const state = join(root, 'state');
  const env = { CLEARED_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db') };
  const base = { project: workspace.dir, env };
  const levels = [
    levelContext(base, { kind: 'service', name: 'filter-api', project: service.dir }),
    levelContext(base, { kind: 'contract', name: 'filter-api', project: service.dir, contract: 'contract/openapi.yaml' }),
  ];
  return { root, state, env, workspace: workspace.dir, service: service.dir, base, levels };
}

const rows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT type, scope, content, source_who, source_where, status FROM memory_entries ORDER BY type, content').all().map((row) => ({ ...row })); }
  finally { db.close(); }
};

test('each level has its own state folder under the workspace\'s, named by the service', () => {
  const env = { CLEARED_STATE_DIR: '/state' };
  assert.equal(levelDirectory(env, 'service', 'filter-api'), '/state/services/filter-api/memory');
  assert.equal(levelDirectory(env, 'contract', 'filter-api'), '/state/contracts/filter-api/memory');
  // Derived from the ledger's folder when only ORCH_LEDGER names it.
  assert.equal(levelDirectory({ ORCH_LEDGER: '/srv/v1/ledger.db' }, 'service', 'guestbook'), '/srv/v1/services/guestbook/memory');
  assert.throws(() => levelDirectory(env, 'service', '../up'), /not a service name/);
  const level = levelContext({ project: '/p', env: { ...env, ORCH_LEDGER: '/state/ledger.db', CLEARED_LEDGER: '/state/ledger.db' } }, { kind: 'service', name: 'guestbook', project: '/g' });
  assert.equal(level.project, '/g');
  assert.equal(level.env?.CLEARED_STATE_DIR, '/state/services/guestbook/memory');
  assert.equal(level.env?.ORCH_STATE_DIR, '/state/services/guestbook/memory');
  assert.equal(level.env?.ORCH_LEDGER, '/state/services/guestbook/memory/ledger.db');
  assert.equal(level.env?.CLEARED_LEDGER, '/state/services/guestbook/memory/ledger.db');
});

test('the briefing reads the workspace, then the service, then the contract, with the reference-data line once', async () => {
  const t = await three();
  const read = await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: t.levels });
  assert.deepEqual(read.levels.map((l) => [l.kind, l.name]), [['service', 'filter-api'], ['contract', 'filter-api']]);
  assert.match(read.workspace.projectPage, /The workspace: a guestbook/);
  assert.match(read.levels[0]?.briefing?.projectPage ?? '', /The service: it checks/);
  assert.deepEqual(read.levels[0]?.briefing?.lessons, ['Service lesson: keep words.txt sorted.\n']);
  assert.match(read.levels[1]?.briefing?.projectPage ?? '', /POST \/check answers allowed/);

  const text = renderBriefing(read.workspace, { levels: read.levels });
  assert.equal(text.split(REFERENCE_LINE).length, 2, 'the reference-data line once');
  const at = ['The workspace: a guestbook', 'Workspace lesson', '## Memory of the service filter-api', 'The service: it checks', 'Service lesson',
    '## Memory of the contract of filter-api', 'POST /check answers allowed'].map((piece) => text.indexOf(piece));
  assert.ok(at.every((n) => n > text.indexOf(REFERENCE_LINE)), 'every level after the reference-data line');
  assert.ok(at.every((n, i) => i === 0 || n > (at[i - 1] as number)), `the levels in order: ${at.join(', ')}`);
  // The contract level reads the page beside the contract, not its provider's page.
  const contract = text.slice(text.indexOf('## Memory of the contract of filter-api'));
  assert.ok(!contract.includes('The service: it checks'));
  assert.ok(!contract.includes('Service lesson'));
  // Every piece of memory stays quoted inside its boundary.
  for (const line of text.slice(text.indexOf(REFERENCE_LINE)).split('\n')) assert.ok(!/^## (Done|Rules)$/.test(line));
});

test('the three levels share one byte budget: what the workspace and the service use is not given to the contract', async () => {
  const page = `# The check contract\n${'A long contract page. '.repeat(25)}\n`;
  // Alone, the contract page fits the budget; after the other two levels it does not.
  const alone = await three({ budget: 1600, contractPage: page });
  const only = await readLeveledBriefing({ ...alone.base, role: 'author', ticket: TICKET, levels: [alone.levels[1] as never] });
  assert.match(only.levels[0]?.briefing?.projectPage ?? '', /A long contract page/);

  const t = await three({ budget: 1600, contractPage: page });
  const read = await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: t.levels });
  assert.equal(read.budget, 1600, 'the workspace service\'s budget, not the provider\'s 100000');
  assert.ok(read.bytes <= read.budget, `${read.bytes} bytes of lib/memory's text within ${read.budget}`);
  assert.match(read.levels[0]?.briefing?.projectPage ?? '', /The service: it checks/);
  assert.equal(read.levels[1]?.briefing?.projectPage, '', 'the contract page went over what was left');
  assert.equal(read.levels[1]?.omitted, 1);
  const text = renderBriefing(read.workspace, { levels: read.levels });
  assert.match(text, /## Memory of the contract of filter-api\nNone\.\nLeft out by the memory's byte budget: 1 entry\.\n/);
});

test('a level the budget has no room for says so; the workspace stays as it was', async () => {
  const t = await three({ budget: 400 });
  const read = await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: t.levels });
  assert.ok(read.bytes <= 400);
  const text = renderBriefing(read.workspace, { levels: read.levels });
  assert.match(text, /## Memory of the contract of filter-api\n(Not briefed: the memory's byte budget is used up\.|None\.\nLeft out by the memory's byte budget: 1 entry\.)\n/);
});

test('each level writes only its own ledger, even with ORCH_LEDGER set for the workspace', async () => {
  const t = await three();
  await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: t.levels });
  const workspace = rows(join(t.state, 'ledger.db'));
  const service = rows(join(t.state, 'services', 'filter-api', 'memory', 'ledger.db'));
  const contract = rows(join(t.state, 'contracts', 'filter-api', 'memory', 'ledger.db'));
  assert.deepEqual(workspace.map((r) => r.content), ['Workspace lesson: run every service\'s tests.\n', '# Guestbook\nThe workspace: a guestbook and the filter it calls.\n']);
  assert.deepEqual(service.map((r) => r.content), ['Service lesson: keep words.txt sorted.\n', '# Filter API\nThe service: it checks an entry\'s words.\n']);
  assert.deepEqual(contract.map((r) => r.content), ['# The check contract\nPOST /check answers allowed, and a severity.\n']);
});

test('a service or contract whose checkout is not on this server is left out with a note, and the session is still briefed', async () => {
  const t = await three();
  const gone = levelContext(t.base, { kind: 'contract', name: 'billing', project: join(t.root, 'billing'), contract: 'openapi.yaml' });
  const read = await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: [...t.levels, gone] });
  assert.equal(read.levels[2]?.briefing, null);
  const text = renderBriefing(read.workspace, { levels: read.levels });
  assert.match(text, /## Memory of the contract of billing\nNot briefed: this memory could not be read for this session\.\n/);
  assert.ok(!text.includes(t.root), 'no path of this server is written for the session');
  assert.match(text, /POST \/check answers allowed/);
  assert.equal(existsSync(join(t.root, 'billing')), false);
});

test('the lessons headings are read at the start of a line, outside a code block, each section up to the next heading', () => {
  const text = [HANDOVER.trimEnd(), LESSON_HEADINGS.workspace, 'Run the tests of every service.', LESSON_HEADINGS.service, 'Keep words.txt sorted.',
    '```', '## Lessons for the contract', '```', LESSON_HEADINGS.contract, 'The severity is one of low, high.', '## Notes', 'Not a lesson.', ''].join('\n');
  assert.deepEqual(lessonsOf(text), {
    workspace: ['Run the tests of every service.'],
    service: ['Keep words.txt sorted.\n```\n## Lessons for the contract\n```'],
    contract: ['The severity is one of low, high.'],
  });
  assert.deepEqual(lessonsOf(`${HANDOVER}Quoted: ${LESSON_HEADINGS.service}\n`), { workspace: [], service: [], contract: [] });
  assert.deepEqual(lessonsOf(`${HANDOVER}${LESSON_HEADINGS.service}\n\n`), { workspace: [], service: [], contract: [] }, 'an empty section files nothing');
});

test('a handover with the three lessons sections files each in its level, as proposals', async () => {
  const t = await three();
  const dir = join(t.root, 'w');
  await ticketCheckout({ project: t.service, workdir: dir, base: 'main', branch: 'cleared/DEMO-8' });
  writeFileSync(join(dir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.workspace}\nRun the tests of every service.\n${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n${LESSON_HEADINGS.contract}\nThe severity is one of low, high.\n`);
  const id = await captureHandover({
    ...t.base, workdir: dir, role: 'author', model: 'claude-opus-5-5', ticket: 'DEMO-8', sessionId: SESSION,
    service: t.levels[0], contract: t.levels[1],
  });
  assert.equal(typeof id, 'string');
  const source = { scope: 'role:author', source_who: 'agent:author/claude-opus-5-5', source_where: `session:${SESSION}`, status: 'proposed' };
  const lesson = (level: string) => rows(level).filter((r) => r.type === 'lesson' && r.source_who !== 'script:file-index');
  assert.deepEqual(lesson(join(t.state, 'ledger.db')), [{ type: 'lesson', content: 'Run the tests of every service.', ...source }]);
  assert.deepEqual(lesson(join(t.state, 'services', 'filter-api', 'memory', 'ledger.db')), [{ type: 'lesson', content: 'Keep words.txt sorted.', ...source }]);
  assert.deepEqual(lesson(join(t.state, 'contracts', 'filter-api', 'memory', 'ledger.db')), [{ type: 'lesson', content: 'The severity is one of low, high.', ...source }]);
  // The handover itself stays the ticket's, in the workspace level.
  assert.equal(rows(join(t.state, 'ledger.db')).filter((r) => r.type === 'handover').length, 1);
  // A filed lesson is a proposal: the next briefing does not carry it as a
  // lesson (the ticket's own handover, which holds it, is briefed in full).
  const read = await readLeveledBriefing({ ...t.base, role: 'author', ticket: TICKET, levels: t.levels });
  assert.deepEqual(read.workspace.lessons, ['Workspace lesson: run every service\'s tests.\n']);
  assert.deepEqual(read.levels.map((l) => l.briefing?.lessons), [['Service lesson: keep words.txt sorted.\n'], []]);
  assert.match(read.workspace.lastHandover ?? '', /## Lessons for the service\nKeep words\.txt sorted\./);
});

test('a lesson that cannot be filed is logged; the handover and the other lessons are stored all the same', async () => {
  const t = await three();
  const dir = join(t.root, 'w');
  await ticketCheckout({ project: t.service, workdir: dir, base: 'main', branch: 'cleared/DEMO-8' });
  // A file where the contracts' folder would be: that level cannot be made.
  mkdirSync(t.state, { recursive: true });
  writeFileSync(join(t.state, 'contracts'), 'not a folder\n');
  writeFileSync(join(dir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n${LESSON_HEADINGS.contract}\nThe severity is one of low, high.\n`);
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => { logged.push(line); };
  let id;
  try { id = await captureHandover({ ...t.base, workdir: dir, role: 'author', model: 'claude-opus-5-5', ticket: 'DEMO-8', sessionId: SESSION, service: t.levels[0], contract: t.levels[1] }); }
  finally { console.error = error; }
  assert.equal(typeof id, 'string');
  assert.deepEqual(logged, ['cleared-v2: a lesson of DEMO-8 could not be filed in the memory of the contract filter-api (Error)']);
  assert.deepEqual(rows(join(t.state, 'services', 'filter-api', 'memory', 'ledger.db')).map((r) => r.content), ['Keep words.txt sorted.']);
});

test('lessons for a level the session has not are filed in the workspace\'s', async () => {
  const t = await three();
  const dir = join(t.root, 'w');
  await ticketCheckout({ project: t.workspace, workdir: dir, base: 'main', branch: 'cleared/DEMO-8' });
  writeFileSync(join(dir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.service}\nThe guestbook renders on the server.\n${LESSON_HEADINGS.contract}\nNo contract here.\n`);
  await captureHandover({ ...t.base, workdir: dir, role: 'author', model: 'claude-opus-5-5', ticket: 'DEMO-8', sessionId: SESSION });
  const filed = rows(join(t.state, 'ledger.db')).filter((r) => r.type === 'lesson' && r.source_who !== 'script:file-index').map((r) => r.content);
  assert.deepEqual(filed.sort(), ['No contract here.', 'The guestbook renders on the server.']);
  assert.equal(existsSync(levelDirectory(t.env, 'service', 'filter-api')), false);
});

test('the briefing of several services tells the author where each lessons heading is filed', () => {
  const text = renderBriefing({ projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null }, { lessons: { service: 'filter-api', contract: 'filter-api' } });
  for (const heading of Object.values(LESSON_HEADINGS)) assert.ok(text.includes(`\`${heading}\``), heading);
  assert.match(text, /memory of the service filter-api/);
  assert.match(text, /memory of the contract of filter-api/);
  const none = renderBriefing({ projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null }, { lessons: { service: 'guestbook', contract: null } });
  assert.ok(!none.includes(`\`${LESSON_HEADINGS.contract}\``), 'no contract heading when no contract would take it');
});

test('the briefing of several services names the decisions headings as it names the lessons headings (C2)', () => {
  const empty = { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null };
  const text = renderBriefing(empty, { lessons: { service: 'filter-api', contract: 'filter-api' } });
  for (const heading of Object.values(DECISION_HEADINGS)) assert.ok(text.includes(`\`${heading}\``), heading);
  assert.match(text, /`## Decisions for the service`[^\n]*memory of the service filter-api/);
  assert.match(text, /`## Decisions for the contract`[^\n]*memory of the contract of filter-api/);
  const own = renderBriefing(empty, { lessons: { service: null, contract: null } });
  assert.match(own, /`## Decisions for the service`[^\n]*the workspace's memory, which is this service's/);
  assert.ok(!own.includes(`\`${DECISION_HEADINGS.contract}\``), 'no contract heading when no contract would take it');
  assert.equal(renderBriefing(empty), renderBriefing(empty, {}), 'a workspace of one service is briefed as milestone 1 did');
  assert.ok(!renderBriefing(empty).includes('Decisions for'), 'and names no decisions heading');
});
