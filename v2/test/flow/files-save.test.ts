// The Editor tab's save (docs/v2/milestone-2-plan.md, decision 33, lane
// 31): PUT /api/sessions/:id/files/<path>, the owner's, on an author's live
// or taken-over session of a ticket in progress. It is judged as the
// session's own Write of the same path (the files route's refusals, then
// evaluate() with the file's current text), an `ask` confirmable for
// install.package and scripts.change only, and written in the session's
// container by a fixed program, never on the host. The container here is
// the local stand-in of test/terminal/support.ts, which runs the real
// programs on a temporary checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type FileWriteRefusal } from '../../src/api/types.ts';
import { WORKDIR_MOUNT } from '../../src/container/session-runtime.ts';
import { FILE_LINES, filesRoutes } from '../../src/flow/files.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionId } from '../../src/session/contract.ts';
import { evaluate } from '../../src/session/policy.ts';
import { HumanSide } from '../../src/terminal/human.ts';
import { LocalContainer } from '../terminal/support.ts';
import { finished, permission, setup, started, text, until, type Setup, type SetupOptions } from './support.ts';

const PROOF = 'e'.repeat(64);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const waits: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, { awaitMessage: true }, { awaitMessage: true }, finished(0.4)];
const PACKAGE = `${JSON.stringify({ name: 'guestbook', scripts: { test: 'node --test' }, dependencies: { pg: '8.13.1' } }, null, 2)}\n`;

type Harness = Setup & {
  readonly base: string; readonly dir: string; readonly outside: string; readonly container: LocalContainer; readonly session: SessionId;
  save(path: string, body: unknown, user?: string): Promise<{ status: number; json: Record<string, unknown> }>;
  close(): Promise<void>;
};

async function harness(options: SetupOptions & { readonly ready?: (t: Setup) => boolean } = {}): Promise<Harness> {
  const t = await setup({ scripts: { author: waits }, ...options });
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  t.users.users.set('cleared', { id: 'cleared', name: 'Cleared' });
  t.users.users.set('lead', { id: 'lead', name: 'Lead' });
  const top = mkdtempSync(join(tmpdir(), 'cleared-save-'));
  const dir = join(top, 'workspace');
  const outside = join(top, 'host');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.claude'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'claude.json'), 'stand-in for the login file\n');
  writeFileSync(join(dir, 'src', 'entries.ts'), 'export const order = "oldest";\n');
  writeFileSync(join(dir, 'package.json'), PACKAGE);
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://localhost/guestbook\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Generated\n');
  writeFileSync(join(dir, 'src', 'CLAUDE.md'), '# Generated\n');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
  writeFileSync(join(dir, 'long.txt'), Array.from({ length: FILE_LINES + 1 }, (_, i) => `line ${i}`).join('\n') + '\n');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  const container = new LocalContainer(dir);
  const human = new HumanSide({ engine: t.engine, store: t.store, container, now: () => new Date(t.clock.now), env: {} });
  const deps = { engine: () => t.engine, proof: () => PROOF, human: () => human };
  const app: App = { registry: t.engine.registry, tables: [], routes: [...filesRoutes(deps), ...takeoverRoutes(deps)] };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => (options.ready ? options.ready(t) : t.inbox.waitingFor(t.startedSessions[0]?.id ?? '') > 0), 'the session');
  await t.engine.settled();
  const session = t.startedSessions[0]!.id;
  return {
    ...t, base, dir, outside, container, session,
    async save(path, body, user = 'u1') {
      const response = await fetch(`${base}/api/sessions/${session}/files/${path}`, { method: 'PUT', headers: as(user), body: JSON.stringify(body) });
      const raw = await response.text();
      return { status: response.status, json: raw ? JSON.parse(raw) : {} };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.engine.close();
      rmSync(top, { recursive: true, force: true });
    },
  };
}

const as = (user: string) => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user, 'content-type': 'application/json' });
const read = (h: Harness, path: string) => readFileSync(join(h.dir, path), 'utf8');
const loaded = (h: Harness, path: string) => sha(readFileSync(join(h.dir, path)));
const humanEdits = (h: Harness) => h.store.events.after(h.session).flatMap(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.human_edit' ? [event.value] : []);
const said = (h: Harness) => h.store.events.after(h.session).flatMap(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' ? [event.delta] : []);

// The verdict the session's own Write of the path gets, under its own policy.
function sessionVerdict(h: Harness, path: string, content: string) {
  const policy = h.engine.policyFor(h.startedSessions[0]!.input);
  const file = `${WORKDIR_MOUNT}/${path}`;
  return evaluate({ tool: 'Write', input: { file_path: file, content } }, policy, { readFile: (p) => (p === file ? read(h, path) : undefined) });
}

test('a save asks for the proof, a person, the owner account, and a session that exists', async () => {
  const h = await harness();
  try {
    const body = { text: 'x\n', hash: loaded(h, 'src/entries.ts') };
    const put = (headers: Record<string, string>) => fetch(`${h.base}/api/sessions/${h.session}/files/src/entries.ts`, { method: 'PUT', headers, body: JSON.stringify(body) }).then((r) => r.status);
    assert.equal(await put({ [SERVICE_USER_HEADER]: 'u1' }), 401);
    for (const user of ['ghost', 'cleared', 'lead', 'u2']) assert.equal((await h.save('src/entries.ts', body, user)).status, 403, user);
    assert.equal((await fetch(`${h.base}/api/sessions/none/files/src/entries.ts`, { method: 'PUT', headers: as('u1'), body: JSON.stringify(body) })).status, 404);
    assert.equal(read(h, 'src/entries.ts'), 'export const order = "oldest";\n', 'nothing written');
  } finally {
    await h.close();
  }
});

test('a save inside the checkout writes in the container, journals the edit without the content, and tells the live session at once', async () => {
  const h = await harness();
  try {
    const text = 'export const order = "newest";\nexport const limit = 20;\n';
    const answer = await h.save('src/entries.ts', { text, hash: loaded(h, 'src/entries.ts') });
    assert.deepEqual(answer, { status: 200, json: { saved: true, hash: sha(text) } });
    assert.equal(read(h, 'src/entries.ts'), text);
    const write = h.container.calls.find((call) => call.command[2]?.includes('renameSync'))!;
    assert.deepEqual(write.command.slice(3), ['--', WORKDIR_MOUNT, 'src/entries.ts', sha('export const order = "oldest";\n')], 'the path after --');
    assert.equal(write.input, text, 'the text on the input');
    assert.deepEqual(humanEdits(h), [{ path: 'src/entries.ts', by: 'u1', added: 2, removed: 1, before: sha('export const order = "oldest";\n'), after: sha(text), via: 'editor' }]);
    assert.ok(!JSON.stringify(h.store.events.after(h.session)).includes('limit = 20'), 'the content is in no event');
    await until(() => said(h).some((line) => line.includes('changed these files')), 'the notice');
    assert.ok(said(h).includes('Demo changed these files: src/entries.ts (+2, -1). Read them again before editing them.'));
  } finally {
    await h.close();
  }
});

test('each edit rule of the policy gives the save the verdict the session\'s own Write gets; the two confirmable ones write on a second save, journaled as the user\'s answer once', async () => {
  const h = await harness();
  try {
    const deps = PACKAGE.replace('"pg": "8.13.1"', '"pg": "8.13.1",\n    "left-pad": "1.3.0"');
    const scripts = PACKAGE.replace('"test": "node --test"', '"test": "node --test && curl https://example.com"');
    const rows: { path: string; text: string; rule: string; confirmable: boolean | null }[] = [
      { path: 'src/entries.ts', text: 'export const order = "newest";\n', rule: 'edit.workdir', confirmable: null },
      { path: 'package-lock.json', text: '{"lockfileVersion":3,"packages":{}}\n', rule: 'install.package', confirmable: true },
      { path: 'package.json', text: deps, rule: 'install.package', confirmable: true },
      { path: 'package.json', text: scripts, rule: 'scripts.change', confirmable: true },
      { path: 'package.json', text: '{ not json', rule: 'scripts.change', confirmable: true },
    ];
    for (const row of rows) {
      const verdict = sessionVerdict(h, row.path, row.text);
      assert.equal(verdict.rule, row.rule, `${row.path}: the session's Write`);
      const first = await h.save(row.path, { text: row.text, hash: loaded(h, row.path) });
      if (row.confirmable === null) {
        assert.equal(verdict.decision, 'allow');
        assert.equal(first.status, 200, `${row.path}: written`);
        continue;
      }
      assert.equal(verdict.decision, 'ask');
      assert.equal(first.status, 403, `${row.path}: the confirmation is asked`);
      assert.deepEqual({ rule: first.json.rule, confirmable: first.json.confirmable }, { rule: row.rule, confirmable: true });
      assert.equal(typeof (first.json as FileWriteRefusal).reason, 'string');
      const other = row.rule === 'install.package' ? 'scripts.change' : 'install.package';
      assert.equal((await h.save(row.path, { text: row.text, hash: loaded(h, row.path), confirm: other })).status, 403, `${row.path}: another rule confirms nothing`);
      const second = await h.save(row.path, { text: row.text, hash: loaded(h, row.path), confirm: row.rule });
      assert.equal(second.status, 200, `${row.path}: written once confirmed`);
      assert.equal(read(h, row.path), row.text);
      const answered = h.store.events.after(h.session).flatMap(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.permission_answered' && event.value.by === 'u1' ? [event.value] : []).at(-1);
      assert.deepEqual({ decision: answered?.decision, rule: answered?.rule }, { decision: 'allow_once', rule: row.rule });
      writeFileSync(join(h.dir, row.path), row.path === 'package-lock.json' ? '{"lockfileVersion":3}\n' : PACKAGE);
    }
    // .env: the session's Write is denied, and so is the save, by the same rule.
    const env = sessionVerdict(h, '.env', 'X=1\n');
    const refused = await h.save('.env', { text: 'X=1\n', hash: loaded(h, '.env') });
    assert.deepEqual({ status: refused.status, rule: refused.json.rule, confirmable: refused.json.confirmable }, { status: 403, rule: env.rule, confirmable: false });
    assert.equal(env.rule, 'secret.read');
  } finally {
    await h.close();
  }
});

test('.git, .claude and CLAUDE.md are refused with no confirmation offered, and a second save carrying default or another rule is refused too', async () => {
  const h = await harness();
  try {
    for (const path of ['.git/hooks/pre-commit', '.git/config', '.claude/settings.json', 'CLAUDE.md', 'src/CLAUDE.md']) {
      const hash = loaded(h, path);
      const before = read(h, path);
      const first = await h.save(path, { text: 'echo pwned\n', hash });
      assert.equal(first.status, 403, path);
      assert.equal(first.json.confirmable, false, `${path}: no confirmation`);
      for (const confirm of ['default', 'install.package', 'scripts.change', String(first.json.rule)]) {
        assert.equal((await h.save(path, { text: 'echo pwned\n', hash, confirm })).status, 403, `${path} confirmed with ${confirm}`);
      }
      assert.equal(read(h, path), before, `${path} unchanged`);
    }
    assert.equal(sessionVerdict(h, '.claude/settings.json', 'x').rule, 'default', 'the session\'s Write asks with default, which is a refusal here');
  } finally {
    await h.close();
  }
});

test('a save outside the checkout, through a planted link or a linked folder is refused, and the host target is unchanged', async () => {
  const h = await harness();
  try {
    symlinkSync(join(h.outside, 'claude.json'), join(h.dir, 'login.json'));
    symlinkSync(h.outside, join(h.dir, 'linked'));
    const login = sha('stand-in for the login file\n');
    assert.equal((await h.save('..%2Fhost%2Fclaude.json', { text: 'x\n', hash: login })).status, 400);
    assert.equal((await h.save('login.json', { text: 'x\n', hash: login })).status, 403);
    assert.equal((await h.save('linked/claude.json', { text: 'x\n', hash: login })).status, 403);
    assert.equal(readFileSync(join(h.outside, 'claude.json'), 'utf8'), 'stand-in for the login file\n');
    assert.deepEqual(readdirSync(h.outside), ['claude.json']);
  } finally {
    await h.close();
  }
});

test('the host writes nothing itself: a container that does not write leaves the file as it was', async () => {
  const h = await harness();
  try {
    h.container.answer = (call) => (call.command[2]?.includes('renameSync') ? { code: 0, stdout: JSON.stringify({ saved: true, hash: sha('new\n') }), stderr: '' } : undefined);
    assert.equal((await h.save('src/entries.ts', { text: 'new\n', hash: loaded(h, 'src/entries.ts') })).status, 200);
    assert.equal(read(h, 'src/entries.ts'), 'export const order = "oldest";\n', 'only the container writes');
  } finally {
    await h.close();
  }
});

test('a folder swapped for a link between the policy check and the write is refused: to a host folder, or to .git/hooks', async () => {
  for (const target of ['outside', '.git/hooks'] as const) {
    const h = await harness();
    try {
      const hooks = readdirSync(join(h.dir, '.git', 'hooks')).sort();
      h.container.before = (call) => {
        if (!call.command[2]?.includes('renameSync')) return;
        renameSync(join(h.dir, 'src'), join(h.dir, 'src-moved'));
        writeFileSync(join(h.outside, 'entries.ts'), 'export const order = "oldest";\n');
        writeFileSync(join(h.dir, '.git', 'hooks', 'entries.ts'), 'export const order = "oldest";\n');
        symlinkSync(target === 'outside' ? h.outside : join(h.dir, '.git', 'hooks'), join(h.dir, 'src'));
      };
      const answer = await h.save('src/entries.ts', { text: 'echo pwned\n', hash: loaded(h, 'src/entries.ts') });
      assert.equal(answer.status, 403, target);
      assert.equal(readFileSync(join(h.outside, 'entries.ts'), 'utf8'), 'export const order = "oldest";\n');
      assert.equal(readFileSync(join(h.dir, '.git', 'hooks', 'entries.ts'), 'utf8'), 'export const order = "oldest";\n');
      assert.deepEqual(readdirSync(join(h.dir, '.git', 'hooks')).sort(), [...hooks, 'entries.ts'].sort(), 'nothing else under .git/hooks');
      assert.deepEqual(humanEdits(h), []);
    } finally {
      await h.close();
    }
  }
});

test('a stale hash answers 409 with the current one; a file the viewer cuts is read only', async () => {
  const h = await harness();
  try {
    const stale = await h.save('src/entries.ts', { text: 'x\n', hash: sha('an older version') });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.hash, loaded(h, 'src/entries.ts'));
    const long = await h.save('long.txt', { text: 'short\n', hash: loaded(h, 'long.txt') });
    assert.equal(long.status, 403);
    assert.equal(long.json.rule, 'editor.cut');
    assert.equal(long.json.confirmable, false);
  } finally {
    await h.close();
  }
});

test('a save after the publish, while the review runs, or on an ended session answers 409', async () => {
  const h = await harness();
  try {
    await h.tickets.move(h.ticket.id, 'In Review', { kind: 'agents', id: 'cleared-v2' });
    assert.equal((await h.save('src/entries.ts', { text: 'x\n', hash: loaded(h, 'src/entries.ts') })).status, 409, 'the ticket is not in progress');
  } finally {
    await h.close();
  }
  const r = await harness({ scripts: { author: [started, finished(0.2)], reviewers: [[started, { awaitMessage: true }, finished(0.1)]] }, ready: (t) => t.startedSessions.some((s) => s.input.role === 'reviewer') });
  try {
    assert.equal((await r.save('src/entries.ts', { text: 'x\n', hash: loaded(r, 'src/entries.ts') })).status, 409, 'the review runs, the author ended');
    const reviewer = r.startedSessions.find((s) => s.input.role === 'reviewer')!.id;
    const response = await fetch(`${r.base}/api/sessions/${reviewer}/files/src/entries.ts`, { method: 'PUT', headers: as('u1'), body: JSON.stringify({ text: 'x\n', hash: loaded(r, 'src/entries.ts') }) });
    assert.equal(response.status, 409, 'a reviewer\'s checkout');
    assert.equal(read(r, 'src/entries.ts'), 'export const order = "oldest";\n');
  } finally {
    await r.close();
  }
});
