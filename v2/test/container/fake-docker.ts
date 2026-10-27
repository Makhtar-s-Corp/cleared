// A fake `docker` CLI for the container tests: it keeps containers, networks,
// volumes and images in memory, honours `--filter label=...` the way the CLI does,
// and records every argument list it receives. No test here needs Docker.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DockerResult, DockerRunner, DockerSpawner, RunOptions } from '../../src/container/docker.ts';

export type FakeObject = {
  readonly id: string;
  readonly name: string;
  readonly labels: Record<string, string>;
  state?: string;
  readonly args?: readonly string[];
  readonly subnet?: string;                 // a network's IPAM subnet, when the test gives one
  readonly created?: string;                // an image's build time: the order of the builds
};

export type Call = { readonly args: readonly string[]; readonly options: RunOptions; readonly result: DockerResult };

// Flags of `docker create` that take a value, as docker.ts writes them.
const CREATE_VALUE_FLAGS = new Set([
  '--name', '--label', '--network', '--user', '--tmpfs', '--mount', '--env', '--memory', '--memory-swap',
  '--cpus', '--pids-limit', '--workdir', '--cap-drop', '--security-opt', '--entrypoint',
]);

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr });

function labelsOf(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== '--label') return;
    const pair = args[index + 1] ?? '';
    const at = pair.indexOf('=');
    labels[at < 0 ? pair : pair.slice(0, at)] = at < 0 ? '' : pair.slice(at + 1);
  });
  return labels;
}

function matches(object: FakeObject, args: readonly string[]): boolean {
  return args.every((arg, index) => {
    if (arg !== '--filter') return true;
    const filter = args[index + 1] ?? '';
    if (filter.startsWith('reference=')) return object.name === filter.slice('reference='.length);
    if (!filter.startsWith('label=')) throw new Error(`fake docker: unsupported filter ${filter}`);
    const pair = filter.slice('label='.length);
    const at = pair.indexOf('=');
    const key = at < 0 ? pair : pair.slice(0, at);
    return at < 0 ? key in object.labels : object.labels[key] === pair.slice(at + 1);
  });
}

const labelText = (labels: Record<string, string>): string => Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');

// The positional arguments after `--`.
function targets(args: readonly string[]): string[] {
  const at = args.indexOf('--');
  return at < 0 ? [] : args.slice(at + 1);
}

export class FakeDocker {
  readonly containers: FakeObject[] = [];
  readonly networks: FakeObject[] = [];
  readonly volumes: FakeObject[] = [];
  readonly images: FakeObject[] = [];
  readonly calls: Call[] = [];
  // The working folder and the VOLUME paths `image inspect` reports, by tag.
  workdirOf: (tag: string) => string = () => '/app';
  volumesOf: (tag: string) => readonly string[] = () => [];
  // Return a result to replace the normal answer, for failure injection.
  intercept: (args: readonly string[]) => DockerResult | undefined = () => undefined;
  // Answer of `exec`, by command.
  execAnswer: (command: readonly string[]) => DockerResult = () => ok();
  // When false, the fake ignores label filters on lists, as a broken CLI would.
  honourFilters = true;
  private next = 1;

  readonly runner: DockerRunner = async (args, options) => {
    const result = this.intercept(args) ?? this.answer(args);
    this.calls.push({ args: [...args], options, result });
    return result;
  };

  // `docker start --attach --interactive` is recorded and answered by a
  // process stand-in that never emits anything.
  readonly spawner: DockerSpawner = (args) => {
    const result = this.answer(args);
    this.calls.push({ args: [...args], options: {}, result });
    return new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  };

  private id(): string {
    return (this.next++).toString(16).padStart(64, '0');
  }

  all(): FakeObject[] {
    return [...this.containers, ...this.networks, ...this.volumes, ...this.images];
  }

  withLabel(key: string, value: string): FakeObject[] {
    return this.all().filter((object) => object.labels[key] === value);
  }

  private list(objects: FakeObject[], args: readonly string[], row: (object: FakeObject) => object): DockerResult {
    const kept = this.honourFilters ? objects.filter((object) => matches(object, args)) : objects;
    return ok(kept.map((object) => JSON.stringify(row(object)) + '\n').join(''));
  }

  // A container or a network is named by its id or its name, as the CLI takes either.
  private remove(objects: FakeObject[], ids: readonly string[], key: 'id' | 'name', byName = false): DockerResult {
    for (const ref of ids) {
      const at = objects.findIndex((object) => object[key] === ref || (byName && object.name === ref));
      if (at < 0) return fail(`Error: No such object: ${ref}`);
      objects.splice(at, 1);
    }
    return ok(ids.join('\n') + '\n');
  }

  private answer(args: readonly string[]): DockerResult {
    const [first, second] = args;
    const verb = first === 'network' || first === 'volume' || first === 'image' ? `${first} ${second}` : first;
    switch (verb) {
      case 'version':
        return ok('{"Client":{"Version":"29.8.1"},"Server":{"Version":"29.8.1"}}\n');
      case 'build': {
        // The tag names the image; a second build of a tag replaces it.
        const tag = args[args.indexOf('--tag') + 1] ?? '';
        const at = this.images.findIndex((image) => image.name === tag);
        if (at >= 0) this.images.splice(at, 1);
        const id = this.id();
        this.images.push({ id: `sha256:${id}`, name: tag, labels: labelsOf(args), args: [...args], created: new Date(Date.UTC(2026, 9, 25) + parseInt(id, 16) * 1000).toISOString() });
        return ok('');
      }
      case 'image ls':
        return this.list(this.images, args, (image) => ({ ID: image.id, Repository: image.name.split(':')[0], Tag: image.name.split(':')[1] ?? 'latest' }));
      case 'image inspect': {
        const found = targets(args).map((id) => this.images.find((image) => image.id === id));
        if (found.some((image) => !image)) return fail('Error: No such image');
        return ok(JSON.stringify(found.map((image) => {
          const volumes = this.volumesOf(image?.name ?? '');
          return {
            Id: image?.id, RepoTags: [image?.name], Created: image?.created ?? '',
            Config: { Labels: Object.keys(image?.labels ?? {}).length ? image?.labels : null, WorkingDir: this.workdirOf(image?.name ?? ''), Volumes: volumes.length ? Object.fromEntries(volumes.map((path) => [path, {}])) : null },
          };
        })));
      }
      case 'image rm':
        return this.remove(this.images, targets(args), 'id');
      case 'network create': {
        const name = args[args.length - 1] ?? '';
        if (this.networks.some((n) => n.name === name)) return fail(`Error: network with name ${name} already exists`);
        const network: FakeObject = { id: this.id(), name, labels: labelsOf(args), args: [...args] };
        this.networks.push(network);
        return ok(network.id + '\n');
      }
      case 'volume create': {
        const name = args[args.length - 1] ?? '';
        this.volumes.push({ id: name, name, labels: labelsOf(args), args: [...args] });
        return ok(name + '\n');
      }
      case 'create': {
        let at = 1;
        let name = '';
        while (at < args.length && (args[at] ?? '').startsWith('-')) {
          const flag = args[at] ?? '';
          if (CREATE_VALUE_FLAGS.has(flag)) {
            if (flag === '--name') name = args[at + 1] ?? '';
            at += 2;
          } else at += 1;
        }
        if (this.containers.some((c) => c.name === name)) return fail(`Error: Conflict. The container name "/${name}" is already in use`);
        const container: FakeObject = { id: this.id(), name, labels: labelsOf(args), state: 'created', args: [...args] };
        this.containers.push(container);
        return ok(container.id + '\n');
      }
      case 'ps':
        return this.list(this.containers, args, (c) => ({ ID: c.id, Names: c.name, State: c.state, Labels: labelText(c.labels) }));
      case 'network ls':
        return this.list(this.networks, args, (n) => ({ ID: n.id, Name: n.name, Labels: labelText(n.labels) }));
      case 'volume ls':
        return this.list(this.volumes, args, (v) => ({ Name: v.name, Labels: labelText(v.labels) }));
      case 'start':
      case 'stop':
        for (const id of targets(args)) {
          const container = this.containers.find((c) => c.id === id);
          if (!container) return fail(`Error: No such container: ${id}`);
          container.state = verb === 'start' ? 'running' : 'exited';
        }
        return ok(targets(args).join('\n') + '\n');
      case 'rm':
        return this.remove(this.containers, targets(args), 'id', true);
      case 'network rm':
        return this.remove(this.networks, targets(args), 'id', true);
      case 'volume rm':
        return this.remove(this.volumes, targets(args), 'name');
      case 'exec':
        return this.execAnswer(targets(args).slice(1));
      case 'inspect': {
        const container = this.containers.find((c) => c.id === targets(args)[0]);
        if (!container) return fail('Error: No such object');
        // Each network of its create line, with an address made from its position.
        const at = this.containers.indexOf(container);
        const networks = (container.args ?? []).flatMap((arg, i, all) => (all[i - 1] === '--network' ? [arg.split(',')[0]?.replace(/^name=/, '') ?? ''] : []));
        return ok(JSON.stringify([{
          Id: container.id, Name: `/${container.name}`, Config: { Labels: container.labels }, State: { Running: container.state === 'running' },
          NetworkSettings: { Networks: Object.fromEntries(networks.map((name) => [name, { IPAddress: `172.30.0.${at + 2}` }])) },
        }]));
      }
      case 'network inspect': {
        const found = targets(args).map((id) => this.networks.find((n) => n.id === id));
        if (found.length === 0 || found.some((n) => !n)) return fail('Error: No such network');
        return ok(JSON.stringify(found.map((n) => ({ Id: n?.id, Name: n?.name, IPAM: { Config: [{ Gateway: '172.30.0.1', ...(n?.subnet ? { Subnet: n.subnet } : {}) }] } }))));
      }
      case 'logs':
        return ok('{"at":"2026-10-21T00:00:00.000Z","listening":"172.30.0.2:3128"}\n');
      default:
        return fail(`fake docker: unknown command ${args.join(' ')}`, 125);
    }
  }
}
