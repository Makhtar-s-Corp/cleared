import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher, LABELS, parseArgs, type Run } from '../deploy/watch.ts';

// A fake host: a git remote whose head the test moves, and a docker that
// keeps containers, networks, volumes and images in memory. Every call is
// recorded with its argument list.
type Call = { readonly command: string; readonly args: readonly string[]; readonly input?: Buffer; output?: string };
type Thing = { id: string; name: string; labels: Record<string, string>; state: string };

const sha = (digit: string): string => digit.repeat(40);

class FakeHost {
  head = sha('a');
  failBuild = false;
  failRun = false;
  calls: Call[] = [];
  containers: Thing[] = [];
  networks: Thing[] = [];
  volumes: Thing[] = [];
  images: Thing[] = [];
  private next = 0;

  run: Run = async (command, args, input) => {
    const call: Call = input === undefined ? { command, args } : { command, args, input };
    this.calls.push(call);
    const output = await this.answer(command, args);
    call.output = output.toString();
    return output;
  };

  private async answer(command: string, args: readonly string[]): Promise<Buffer> {
    const out = (text: string): Buffer => Buffer.from(text);
    if (command === 'git') {
      const verb = args[2];
      if (verb === 'fetch') return out('');
      if (verb === 'rev-parse') return out(`${this.head}\n`);
      if (verb === 'archive') return out(`tar of ${args.at(-1)}`);
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
    const [verb, sub] = args;
    const labels = (list: readonly string[]): Record<string, string> => {
      const found: Record<string, string> = {};
      list.forEach((word, at) => {
        if (word === '--label') {
          const [key, value] = (list[at + 1] ?? '').split('=');
          if (key) found[key] = value ?? '';
        }
      });
      return found;
    };
    const matches = (thing: Thing): boolean =>
      args.every((word, at) => {
        if (args[at - 1] !== '--filter' || !word.startsWith('label=')) return true;
        const [key, value] = word.slice('label='.length).split('=');
        return key !== undefined && thing.labels[key] === value;
      });
    const id = (): string => `id${++this.next}`;
    const nameOf = (): string => args[args.indexOf('--name') + 1] ?? '';
    if (verb === 'ps') {
      return out(this.containers.filter(matches).map((c) => `${c.id} ${c.state} ${c.labels['cleared.commit'] ?? ''}\n`).join(''));
    }
    if (verb === 'network' && sub === 'ls') return out(this.networks.filter(matches).map((n) => `${n.name}\n`).join(''));
    if (verb === 'network' && sub === 'create') {
      this.networks.push({ id: id(), name: args.at(-1) ?? '', labels: labels(args), state: '' });
      return out('');
    }
    if (verb === 'volume' && sub === 'ls') return out(this.volumes.filter(matches).map((v) => `${v.name}\n`).join(''));
    if (verb === 'volume' && sub === 'create') {
      this.volumes.push({ id: id(), name: args.at(-1) ?? '', labels: labels(args), state: '' });
      return out('');
    }
    if (verb === 'image' && sub === 'ls') return out(this.images.filter(matches).map((i) => `${i.id} ${i.name}\n`).join(''));
    if (verb === 'image' && sub === 'rm') {
      this.images = this.images.filter((i) => i.id !== args.at(-1));
      return out('');
    }
    if (verb === 'build') {
      if (this.failBuild) throw new Error('build failed');
      this.images.push({ id: id(), name: args[args.indexOf('--tag') + 1] ?? '', labels: labels(args), state: '' });
      return out('');
    }
    if (verb === 'run') {
      if (this.failRun && labels(args)['cleared.role'] === 'app') throw new Error('run failed');
      this.containers.push({ id: id(), name: nameOf(), labels: labels(args), state: 'running' });
      return out('');
    }
    if (verb === 'start') {
      for (const c of this.containers) if (c.id === args.at(-1)) c.state = 'running';
      return out('');
    }
    if (verb === 'rm') {
      this.containers = this.containers.filter((c) => c.id !== args.at(-1));
      return out('');
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  }

  docker(): Call[] {
    return this.calls.filter((call) => call.command === 'docker');
  }

  app(): Thing[] {
    return this.containers.filter((c) => c.labels['cleared.role'] === 'app');
  }
}

function watcher(host: FakeHost, portFree = true) {
  return createWatcher({
    repo: '/srv/guestbook',
    remote: 'origin',
    branch: 'main',
    port: 8793,
    run: host.run,
    portFree: async () => portFree,
  });
}

const flag = (args: readonly string[], name: string): string[] =>
  args.flatMap((word, at) => (args[at - 1] === name ? [word] : []));

test('the first tick builds the head from git archive and starts the app, its database, network and volume', async () => {
  const host = new FakeHost();
  const outcome = await watcher(host).tick();
  assert.deepEqual(outcome, { kind: 'deployed', commit: sha('a') });

  const git = host.calls.filter((call) => call.command === 'git').map((call) => call.args.join(' '));
  assert.deepEqual(git, [
    '-C /srv/guestbook fetch --quiet origin main',
    `-C /srv/guestbook rev-parse --verify refs/remotes/origin/main^{commit}`,
    `-C /srv/guestbook archive --format=tar ${sha('a')}`,
  ]);
  const build = host.docker().find((call) => call.args[0] === 'build');
  assert.ok(build);
  assert.equal(build.args.at(-1), '-', 'the build context is the archive on stdin, not a working tree');
  assert.equal(build.input?.toString(), `tar of ${sha('a')}`);

  assert.equal(host.networks.length, 1);
  assert.equal(host.volumes.length, 1);
  const db = host.containers.find((c) => c.labels['cleared.role'] === 'db');
  assert.ok(db);
  const app = host.app();
  assert.equal(app.length, 1);
  assert.equal(app[0]?.labels['cleared.commit'], sha('a'));

  const runApp = host.docker().find((call) => call.args[0] === 'run' && call.args.includes('cleared.role=app'));
  assert.ok(runApp);
  assert.deepEqual(flag(runApp.args, '-p'), ['127.0.0.1:8793:8793']);
  const env = flag(runApp.args, '-e');
  assert.ok(env.includes('HOST=0.0.0.0'));
  assert.ok(env.includes('PORT=8793'));
  assert.ok(env.some((value) => value.startsWith('DATABASE_URL=postgres://')));

  const runDb = host.docker().find((call) => call.args[0] === 'run' && call.args.includes('cleared.role=db'));
  assert.ok(runDb);
  assert.deepEqual(flag(runDb.args, '-p'), [], 'the database publishes no host port');
  assert.ok(runDb.args.includes('postgres:16'));
});

test('a tick with the same head and the app running does nothing', async () => {
  const host = new FakeHost();
  const watch = watcher(host);
  await watch.tick();
  const before = host.docker().length;
  assert.deepEqual(await watch.tick(), { kind: 'unchanged', commit: sha('a') });
  const after = host.docker().slice(before).map((call) => call.args[0]);
  assert.deepEqual(after, ['ps'], 'only the labelled listing');
});

test('when the head moves (a merge, or a revert), the new commit replaces the app; the database stays', async () => {
  const host = new FakeHost();
  const watch = watcher(host);
  await watch.tick();
  const db = host.containers.find((c) => c.labels['cleared.role'] === 'db');
  const old = host.app()[0];
  for (const head of [sha('b'), sha('c')]) {
    host.head = head;
    assert.deepEqual(await watch.tick(), { kind: 'deployed', commit: head });
    assert.deepEqual(host.app().map((c) => c.labels['cleared.commit']), [head]);
  }
  assert.ok(!host.containers.includes(old!), 'the old app container is removed');
  assert.ok(host.containers.includes(db!), 'the database container is kept');
  assert.equal(host.networks.length, 1);
  assert.equal(host.volumes.length, 1);
  assert.deepEqual(host.images.map((i) => i.name), [`cleared-guestbook:${sha('c').slice(0, 12)}`], 'older images are removed');
});

test('a stopped database container is started again, not recreated', async () => {
  const host = new FakeHost();
  const watch = watcher(host);
  await watch.tick();
  const db = host.containers.find((c) => c.labels['cleared.role'] === 'db')!;
  db.state = 'exited';
  host.head = sha('b');
  await watch.tick();
  assert.equal(db.state, 'running');
  assert.equal(host.containers.filter((c) => c.labels['cleared.role'] === 'db').length, 1);
});

test('a build that fails leaves the running app untouched and is not retried until the head moves', async () => {
  const host = new FakeHost();
  const watch = watcher(host);
  await watch.tick();
  const running = host.app()[0];
  host.head = sha('b');
  host.failBuild = true;
  assert.deepEqual(await watch.tick(), { kind: 'build-failed', commit: sha('b') });
  assert.deepEqual(host.app(), [running]);
  const builds = (): number => host.docker().filter((call) => call.args[0] === 'build').length;
  const count = builds();
  assert.deepEqual(await watch.tick(), { kind: 'skipped-failed', commit: sha('b') });
  assert.equal(builds(), count);
  host.failBuild = false;
  host.head = sha('c');
  assert.deepEqual(await watch.tick(), { kind: 'deployed', commit: sha('c') });
});

test('a run that fails is reported and not retried until the head moves', async () => {
  const host = new FakeHost();
  host.failRun = true;
  const watch = watcher(host);
  assert.deepEqual(await watch.tick(), { kind: 'run-failed', commit: sha('a') });
  assert.deepEqual(await watch.tick(), { kind: 'skipped-failed', commit: sha('a') });
});

test('the app port taken by something else, with no app of ours, deploys nothing', async () => {
  const host = new FakeHost();
  assert.deepEqual(await watcher(host, false).tick(), { kind: 'port-busy', commit: sha('a') });
  assert.equal(host.docker().filter((call) => ['build', 'run'].includes(call.args[0] ?? '')).length, 0);
});

test('a head that is not a full commit id stops the tick before docker runs', async () => {
  const host = new FakeHost();
  host.head = 'main';
  await assert.rejects(watcher(host).tick(), /not a commit id/);
  assert.equal(host.docker().length, 0);
});

test('every docker call carries the labels: on create, as filters on list, and on ids from a labelled list only', async () => {
  const host = new FakeHost();
  const watch = watcher(host);
  await watch.tick();
  host.containers.find((c) => c.labels['cleared.role'] === 'db')!.state = 'exited';
  host.head = sha('b');
  await watch.tick();
  host.head = sha('c');
  host.failRun = true;
  await watch.tick();

  const listed = new Set<string>();
  for (const call of host.docker()) {
    const [verb, sub] = call.args;
    const words = call.args.join(' ');
    if (verb === 'build' || verb === 'run' || sub === 'create') {
      for (const label of LABELS) assert.ok(flag(call.args, '--label').includes(label), `${label} on: ${words}`);
    } else if (verb === 'ps' || sub === 'ls') {
      for (const label of LABELS) assert.ok(flag(call.args, '--filter').includes(`label=${label}`), `${label} filter on: ${words}`);
      for (const line of (call.output ?? '').split('\n')) if (line) listed.add(line.split(' ')[0] ?? '');
    } else if (verb === 'rm' || verb === 'start' || sub === 'rm') {
      assert.ok(listed.has(call.args.at(-1) ?? ''), `an id from a labelled list: ${words}`);
    } else {
      assert.fail(`unexpected docker call: ${words}`);
    }
  }
});

test('the labels name Cleared v2 and the example, so the watcher never touches another lane objects', () => {
  assert.deepEqual(LABELS, ['cleared.dev=v2', 'cleared.example=guestbook']);
});

test('parseArgs: --repo is required; the rest has defaults', () => {
  assert.deepEqual(parseArgs(['--repo', '/srv/guestbook']), {
    repo: '/srv/guestbook',
    remote: 'origin',
    branch: 'main',
    intervalSeconds: 30,
    once: false,
  });
  assert.deepEqual(parseArgs(['--repo', 'r', '--remote', 'up', '--branch', 'trunk', '--interval', '5', '--once']), {
    repo: 'r',
    remote: 'up',
    branch: 'trunk',
    intervalSeconds: 5,
    once: true,
  });
  assert.throws(() => parseArgs([]), /--repo/);
  assert.throws(() => parseArgs(['--repo', 'r', '--interval', '0']), /--interval/);
  assert.throws(() => parseArgs(['--repo', 'r', '--branch', '-x']), /--branch/);
  assert.throws(() => parseArgs(['--repo', 'r', '--what']), /unknown/);
});
