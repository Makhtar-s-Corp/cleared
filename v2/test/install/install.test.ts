// The one command's Node part, src/cli/install.ts (docs/v2/milestone-5-plan.md
// section 4, issue #406), against a fake `docker` that keeps the project's
// containers and images in memory and records every call: Docker and the
// ports are checked before anything is written, a second run changes
// nothing that runs, the address and the service's setup line are said in
// French and in English, and every list carries the cleared.dev=v2 filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { Listener } from '../../../lib/ports.ts';
import { INSTALL_MESSAGES_DIR, install, readInstallSettings, setupLine, type DockerResult, type InstallHost } from '../../src/cli/install.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cleared-v2-install-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const freshState = () => join(scratch, `state-${++counter}`);

const PROJECT = 'cleared-v2-try';
const PORTS = { CLEARED_V2_PORT: '18791', CLEARED_V2_APP_PORT: '18792', CLEARED_V2_PREVIEW_PORT: '18794' };
const SETUP = 'cleared-v2: open http://127.0.0.1:18792/setup and type the code 4821-7730 (valid 24 h)';

type Call = { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };

class FakeDocker {
  readonly calls: Call[] = [];
  readonly running = new Set<string>();
  readonly images = new Set<string>();
  answering = true;
  daemon = true;
  log = `cleared-v2: listening on http://127.0.0.1:18791 (health: /health)\n${SETUP}\n`;
  upCode = 0;

  run = async (args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<DockerResult> => {
    this.calls.push({ args, env });
    const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'version') return this.daemon ? ok('29.8.1\n') : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' };
    if (args[0] === 'compose' && args[1] === 'version') return ok('5.5.1\n');
    if (args[0] === 'ps') return ok([...this.running].map((service) => `id-${service} ${service}\n`).join(''));
    if (args[0] === 'image' && args[1] === 'ls') {
      const reference = args.find((arg) => arg.startsWith('reference='))?.slice('reference='.length) ?? '';
      return ok(this.images.has(reference) ? `sha-${reference}\n` : '');
    }
    if (args[0] === 'logs') return { code: 0, stdout: '', stderr: this.log };
    if (args[0] === 'compose') {
      const verb = args.find((arg) => arg === 'up' || arg === 'build');
      const named = args.slice(args.indexOf(verb ?? '') + 1).filter((arg) => !arg.startsWith('-'));
      if (verb === 'build') { for (const service of named) this.images.add(service === 'session' ? 'cleared-v2-session:2.1.306' : 'cleared-v2-egress:1'); return ok(); }
      if (verb === 'up') {
        if (this.upCode !== 0) return { code: this.upCode, stdout: '', stderr: 'Error response from daemon: something failed' };
        this.images.add('cleared-v2:local');
        for (const service of named) this.running.add(service);
        return ok();
      }
    }
    return { code: 125, stdout: '', stderr: `fake docker: unexpected ${args.join(' ')}` };
  };

  verbs(): string[] {
    return this.calls.map(({ args }) => (args[0] === 'compose' ? `compose ${args.find((arg) => ['up', 'build', 'version'].includes(arg)) ?? '?'}` : args.slice(0, 2).join(' ')));
  }
}

type Run = { readonly code: number; readonly out: string; readonly docker: FakeDocker; readonly state: string };

async function run(options: { env?: Record<string, string>; docker?: FakeDocker; held?: readonly string[]; listeners?: Listener[] | null; owner?: { uid: number; gid: number } | null; state?: string } = {}): Promise<Run> {
  const docker = options.docker ?? new FakeDocker();
  const state = options.state ?? freshState();
  const lines: string[] = [];
  let clock = 1_000_000;
  const host: InstallHost = {
    docker: docker.run,
    listeners: () => (options.listeners !== undefined ? options.listeners : (options.held ?? []).map((port) => ({ address: '127.0.0.1', port, pid: '-', uid: '-', inode: '-', name: '-' }))),
    answers: async () => docker.answering && docker.running.has('app'),
    owner: () => (options.owner !== undefined ? options.owner : { uid: process.getuid!(), gid: process.getgid!() }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    say: (line) => { lines.push(line); },
  };
  const env = { CLEARED_V2_COMPOSE_PROJECT: PROJECT, CLEARED_V2_STATE_DIR: state, CLEARED_V2_CLONE: '/opt/cleared/clone', ...PORTS, ...options.env };
  const code = await install(env, host);
  return { code, out: lines.join('\n'), docker, state };
}

const WRITES = ['compose build', 'compose up'];

test('a first run checks Docker and the ports, makes the state folder, builds what is missing, starts the project and says where it answers', async () => {
  const { code, out, docker, state } = await run({ env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(code, 0, out);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(state), []);
  const verbs = docker.verbs();
  assert.ok(verbs.indexOf('compose build') > verbs.indexOf('ps --filter'), 'the project is looked for first');
  assert.equal(verbs.filter((verb) => verb === 'compose up').length, 1);
  const build = docker.calls.find(({ args }) => args.includes('build'))!;
  assert.deepEqual(build.args.slice(build.args.indexOf('build') + 1), ['session', 'egress']);
  const up = docker.calls.find(({ args }) => args.includes('up'))!;
  assert.deepEqual(up.args.slice(up.args.indexOf('up') + 1), ['-d', 'service', 'app', 'broker']);
  assert.deepEqual(up.args.slice(1, 7), ['--project-name', PROJECT, '--project-directory', '/opt/cleared/clone/v2', '--file', '/opt/cleared/clone/v2/compose.yaml']);
  assert.equal(up.env.CLEARED_V2_STATE_DIR, state);
  assert.equal(up.env.CLEARED_V2_APP_PORT, '18792');
  assert.equal(up.env.CLEARED_V2_PORT, '18791');
  assert.equal(up.env.CLEARED_V2_PREVIEW_PORT, '18794');
  assert.match(out, /http:\/\/127\.0\.0\.1:18792\//);
  assert.ok(out.includes(SETUP), 'the service\'s setup line is shown as it is');
  assert.match(out, /answered in \d+ s/);
  assert.doesNotMatch(out, /\d ?ms\b|millisecond/);
});

test('the same run in French, the default', async () => {
  const { code, out } = await run();
  assert.equal(code, 0, out);
  assert.match(out, /Cleared répond sur http:\/\/127\.0\.0\.1:18792\//);
  assert.match(out, /en \d+ s/);
});

test('the session images already built are not built again', async () => {
  const docker = new FakeDocker();
  docker.images.add('cleared-v2-session:2.1.306');
  docker.images.add('cleared-v2-egress:1');
  const { code, out } = await run({ docker });
  assert.equal(code, 0, out);
  assert.deepEqual(docker.verbs().filter((verb) => verb === 'compose build'), []);
});

test('a port something else holds is refused before anything is written or started', async () => {
  for (const port of ['18792', '18791', '18794']) {
    const { code, out, docker, state } = await run({ held: [port], env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
    assert.equal(code, 1, port);
    assert.equal(existsSync(state), false, `${port}: no state folder`);
    assert.deepEqual(docker.verbs().filter((verb) => WRITES.includes(verb)), [], `${port}: nothing built or started`);
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${port}`), port);
    assert.match(out, /Nothing was written/);
  }
});

test('a reserved port, a port named twice or a word is refused before Docker is even asked', async () => {
  for (const [name, value] of [['CLEARED_V2_APP_PORT', '8788'], ['CLEARED_V2_APP_PORT', '443'], ['CLEARED_V2_PORT', '80'], ['CLEARED_V2_PREVIEW_PORT', '8790'], ['CLEARED_V2_APP_PORT', 'eighty'], ['CLEARED_V2_PREVIEW_PORT', '18792']] as const) {
    const { code, out, docker, state } = await run({ env: { [name]: value, CLEARED_V2_APP_LANGUAGE: 'en' } });
    assert.equal(code, 64, `${name}=${value}`);
    assert.deepEqual(docker.calls, [], `${name}=${value}`);
    assert.equal(existsSync(state), false);
    assert.match(out, new RegExp(name), `${name}=${value}: the variable is named`);
  }
});

test('the settings: the defaults, and a state folder or a project name Compose would misread', () => {
  const settings = readInstallSettings({});
  assert.deepEqual({ ...settings }, {
    project: 'cleared-v2', stateDir: '/var/lib/cleared-v2', clone: '/opt/cleared/clone', composeFile: '/opt/cleared/clone/v2/compose.yaml',
    servicePort: 8791, appPort: 8792, previewPort: 8794, language: 'fr',
  });
  for (const env of [{ CLEARED_V2_STATE_DIR: 'relative/state' }, { CLEARED_V2_STATE_DIR: '/var/lib/a:b' }, { CLEARED_V2_STATE_DIR: '/' }, { CLEARED_V2_COMPOSE_PROJECT: 'Has Space' }]) {
    assert.throws(() => readInstallSettings(env), { name: 'InstallError' }, JSON.stringify(env));
  }
});

test('Docker that does not answer stops the command with nothing written', async () => {
  const docker = new FakeDocker();
  docker.daemon = false;
  const { code, out, state } = await run({ docker, env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(code, 69);
  assert.equal(existsSync(state), false);
  assert.match(out, /Docker does not answer/);
  assert.match(out, /Nothing was written/);
});

test('listening ports that cannot be read prove no port free: refused', async () => {
  const { code, state, docker } = await run({ listeners: null });
  assert.equal(code, 1);
  assert.equal(existsSync(state), false);
  assert.deepEqual(docker.verbs().filter((verb) => WRITES.includes(verb)), []);
});

test('a second run changes nothing that runs, though its own ports are held, and says the address again', async () => {
  const first = await run();
  assert.equal(first.code, 0, first.out);
  const before = statSync(first.state);
  const docker = first.docker;
  docker.calls.length = 0;
  const second = await run({ docker, state: first.state, held: ['18791', '18792', '18794'], env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(docker.verbs().filter((verb) => WRITES.includes(verb)), []);
  assert.equal(statSync(first.state).mtimeMs, before.mtimeMs);
  assert.match(second.out, /already runs/);
  assert.match(second.out, /http:\/\/127\.0\.0\.1:18792\//);
});

test('with the service up and the app stopped, only the app\'s ports are checked, and compose starts what is missing', async () => {
  const docker = new FakeDocker();
  docker.running.add('service');
  docker.running.add('broker');
  const held = await run({ docker, held: ['18791'] });
  assert.equal(held.code, 0, held.out);
  assert.equal(docker.verbs().filter((verb) => verb === 'compose up').length, 1);
  const again = new FakeDocker();
  again.running.add('service');
  const refused = await run({ docker: again, held: ['18794'] });
  assert.equal(refused.code, 1);
});

test('a state folder of another account, or one others may write, is refused before anything starts', async () => {
  const open = freshState();
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o777);
  const loose = await run({ state: open, env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(loose.code, 1);
  assert.match(loose.out, /others/);
  assert.deepEqual(loose.docker.verbs().filter((verb) => WRITES.includes(verb)), []);
  const owned = freshState();
  mkdirSync(owned, { mode: 0o700 });
  const other = await run({ state: owned, owner: { uid: process.getuid!() + 1, gid: process.getgid!() } });
  assert.equal(other.code, 1);
  assert.deepEqual(other.docker.verbs().filter((verb) => WRITES.includes(verb)), []);
});

test('a clone that belongs to root is refused: sessions never run as root', async () => {
  const { code, state, out } = await run({ owner: { uid: 0, gid: 0 }, env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(code, 1);
  assert.equal(existsSync(state), false);
  assert.match(out, /root/);
});

test('an app that never answers ends the command after a few minutes, with where to look', async () => {
  const docker = new FakeDocker();
  docker.answering = false;
  const { code, out } = await run({ docker, env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(code, 1);
  assert.match(out, /3 min/);
  assert.match(out, new RegExp(`docker compose --project-name ${PROJECT} .*logs app`));
});

test('a failed start says what Docker said', async () => {
  const docker = new FakeDocker();
  docker.upCode = 1;
  const { code, out } = await run({ docker, env: { CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(code, 1);
  assert.match(out, /something failed/);
});

test('the setup line: the service\'s last line that names /setup, or none', () => {
  assert.equal(setupLine(`a\n${SETUP}\nb\n`), SETUP);
  assert.equal(setupLine('cleared-v2: open /setup with 1111\ncleared-v2: open /setup with 2222\n'), 'cleared-v2: open /setup with 2222');
  assert.equal(setupLine('cleared-v2: listening on http://127.0.0.1:8791 (health: /health)\n/setupx\n'), undefined);
});

test('no setup line in the log: the address alone', async () => {
  const docker = new FakeDocker();
  docker.log = 'cleared-v2: listening on http://127.0.0.1:18791 (health: /health)\n';
  const { code, out } = await run({ docker });
  assert.equal(code, 0);
  assert.doesNotMatch(out, /\/setup/);
});

test('every docker call is a version, a labelled list, the project\'s compose or the service\'s log', async () => {
  const { docker } = await run();
  for (const { args } of docker.calls) {
    const [verb, sub] = args;
    if (verb === 'version' || (verb === 'compose' && sub === 'version')) continue;
    if (verb === 'ps' || (verb === 'image' && sub === 'ls')) {
      assert.ok(args.includes('label=cleared.dev=v2'), args.join(' '));
      if (verb === 'ps') assert.ok(args.includes(`label=com.docker.compose.project=${PROJECT}`), args.join(' '));
      continue;
    }
    if (verb === 'compose') { assert.equal(args[2], PROJECT); continue; }
    if (verb === 'logs') { assert.deepEqual(args.slice(1), ['--tail', '200', '--', 'id-service']); continue; }
    assert.fail(`unexpected docker ${args.join(' ')}`);
  }
});

const read = (name: string) => JSON.parse(readFileSync(join(INSTALL_MESSAGES_DIR, name), 'utf8')) as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the catalogs of the command line: French and English, the same keys and placeholders, every key said', () => {
  for (const [name, sources] of [['install', ['install.ts']], ['cleared', ['cleared.ts', '../../images/cleared/entrypoint.ts']]] as const) {
    const en = read(`${name}.en.json`);
    const fr = read(`${name}.fr.json`);
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), name);
    for (const [key, value] of Object.entries(en)) {
      assert.ok(value.trim() && fr[key]!.trim(), `${name} ${key} is empty`);
      assert.notEqual(fr[key], value, `${name} ${key}: the French is the English`);
      assert.deepEqual(placeholders(fr[key]!), placeholders(value), `${name} ${key}: placeholders differ`);
      assert.doesNotMatch(key, /token|secret|key|pass/, key);
      assert.doesNotMatch(fr[key]!, / [?!;:%»]/, `${name} ${key}: French typography`);
    }
    const text = sources.map((file) => readFileSync(join(INSTALL_MESSAGES_DIR, '..', file), 'utf8')).join('\n');
    const said = new Set([...text.matchAll(/\bt\('([a-z0-9_]+)'/g)].map(([, key]) => key as string));
    for (const key of said) assert.ok(Object.hasOwn(en, key), `${name}: ${key} is said and not in the catalog`);
    for (const key of Object.keys(en)) assert.ok(said.has(key), `${name}: ${key} is never said`);
  }
});
