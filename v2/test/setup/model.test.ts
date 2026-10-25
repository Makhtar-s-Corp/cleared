// The model step (docs/v2/milestone-5-plan.md, decision 7, lane
// v2-j5-assistant): the Claude Code login from `claude setup-token`, pasted
// into the step's field, written where the Claude Code adapter reads it,
// never answered back; and a terminal in a throwaway container to run the
// command in, here a fake container: nothing of it is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContainer, TerminalProcess } from '../../src/terminal/container.ts';
import { readSettings } from '../../src/setup/settings.ts';
import { looksLikeSetupToken } from '../../src/setup/steps/model.ts';
import { PASSWORD, startSetup, type SetupService } from './support.ts';

// Built here, so no line of the repository holds a value shaped like a login.
const LOGIN = ['sk', 'ant', 'oat01', 'x'.repeat(40)].join('-');

class FakeContainer implements SessionContainer {
  readonly opened: { command: readonly string[]; cols: number; rows: number }[] = [];
  readonly typed: string[] = [];
  ended = 0;
  #output: ((chunk: Buffer) => void)[] = [];
  #exit: (() => void)[] = [];
  async exec() { return { code: 0, stdout: '', stderr: '' }; }
  async terminal(_id: string, size: { cols: number; rows: number }, command: readonly string[]): Promise<TerminalProcess> {
    this.opened.push({ command, ...size });
    const self = this;
    return {
      write: (data) => { self.typed.push(data); for (const listener of self.#output) listener(Buffer.from(`echo:${data}`)); },
      async resize() {},
      onOutput: (listener) => { self.#output.push(listener); },
      onExit: (listener) => { self.#exit.push(listener); },
      async end() { self.ended += 1; for (const listener of self.#exit.splice(0)) listener(); },
    };
  }
}

async function withModel(run: (service: SetupService, owner: string, container: FakeContainer) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const container = new FakeContainer();
  const service = await startSetup({ env, container });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    await run(service, owner.id, container);
  } finally { await service.close(); }
}

test('what `claude setup-token` prints is told from a paste of something else', () => {
  assert.equal(looksLikeSetupToken(LOGIN), true);
  assert.equal(looksLikeSetupToken('hello'), false);
  assert.equal(looksLikeSetupToken(`${LOGIN} trailing words`), false);
  assert.equal(looksLikeSetupToken(['sk', 'ant', 'api03', 'x'.repeat(40)].join('-')), false, 'an API key is not a setup token: the adapter does not read one');
});

test('the login is written to <state>/claude.token, mode 600, named in the settings, and never answered back', async () => {
  await withModel(async (service, owner) => {
    assert.deepEqual((await service.call('/api/setup/model', { user: owner })).json.credential, { set: false });
    const saved = await service.call('/api/setup/model', { method: 'POST', user: owner, body: { value: `\n${LOGIN}\n` } });
    assert.equal(saved.status, 200, saved.text);
    assert.ok(!saved.text.includes(LOGIN));
    assert.equal(saved.json.credential.set, true);
    const file = join(service.dir, 'claude.token');
    assert.equal(readFileSync(file, 'utf8'), `${LOGIN}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readSettings(join(service.dir, 'settings.conf')).env.CLEARED_CLAUDE_CREDENTIALS, file);
    assert.equal(service.env.CLEARED_CLAUDE_CREDENTIALS, file);
    const again = await service.call('/api/setup/model', { user: owner });
    assert.ok(!again.text.includes(LOGIN));
    assert.equal(again.json.credential.source, 'assistant');
    const view = (await service.call('/api/setup', { user: owner })).json;
    assert.equal(view.steps.find((s: { id: string }) => s.id === 'model').state, 'done');
  });
});

test('a paste that is not a setup token is refused and nothing is written', async () => {
  await withModel(async (service, owner) => {
    const refused = await service.call('/api/setup/model', { method: 'POST', user: owner, body: { value: 'not what the command prints' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'invalid');
    assert.equal(existsSync(join(service.dir, 'claude.token')), false);
  });
});

test('a login file the environment names is shown as such and not replaced from the browser', async () => {
  await withModel(async (service, owner) => {
    assert.deepEqual((await service.call('/api/setup/model', { user: owner })).json.credential, { set: true, at: null, source: 'environment' });
    assert.equal((await service.call('/api/setup/model', { method: 'POST', user: owner, body: { value: LOGIN } })).status, 409);
  }, { CLEARED_CLAUDE_CREDENTIALS: '/elsewhere/credentials.json' });
});

test('the terminal: a shell in a throwaway container, one at a time, what is typed reaches it, its output streams, the close ends it', async () => {
  await withModel(async (service, owner, container) => {
    assert.equal((await service.call('/api/setup/model', { user: owner })).json.terminal, true);
    const opened = await service.call('/api/setup/model/terminal/open', { method: 'POST', user: owner, body: { cols: 100, rows: 30 } });
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.json.opened, true);
    assert.deepEqual(container.opened.map((o) => [o.cols, o.rows]), [[100, 30]]);
    assert.equal((await service.call('/api/setup/model/terminal/open', { method: 'POST', user: owner, body: { cols: 100, rows: 30 } })).status, 409, 'one at a time');
    assert.equal((await service.call('/api/setup/model/terminal/input', { method: 'POST', user: owner, body: { data: 'claude setup-token\r' } })).status, 200);
    assert.deepEqual(container.typed, ['claude setup-token\r']);
    const controller = new AbortController();
    const stream = await fetch(`${service.base}/api/setup/model/terminal/stream?after=0`, { headers: { 'x-cleared-proof': 'a'.repeat(64), 'x-cleared-user': owner }, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /echo:claude setup-token/);
    controller.abort();
    assert.equal((await service.call('/api/setup/model/terminal/close', { method: 'POST', user: owner })).status, 200);
    assert.equal(container.ended, 1);
    assert.equal((await service.call('/api/setup/model/terminal/input', { method: 'POST', user: owner, body: { data: 'x' } })).status, 409, 'closed: nothing to type into');
    const rows = service.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const { name } of rows) {
      const text = JSON.stringify(service.store.db.prepare(`SELECT * FROM "${name}"`).all());
      assert.ok(!text.includes('setup-token\\r') && !text.includes('echo:'), `nothing of the terminal in ${name}`);
    }
  });
});

test('the terminal is the owner\'s only, and a size out of range is refused', async () => {
  await withModel(async (service) => {
    await service.directory.add('alex', PASSWORD).catch(() => undefined);
    const sam = await service.directory.add('sam', PASSWORD);
    assert.equal((await service.call('/api/setup/model/terminal/open', { method: 'POST', user: sam.id, body: { cols: 80, rows: 24 } })).status, 403);
  });
  await withModel(async (service, owner) => {
    assert.equal((await service.call('/api/setup/model/terminal/open', { method: 'POST', user: owner, body: { cols: 1, rows: 24 } })).status, 400);
  });
});
