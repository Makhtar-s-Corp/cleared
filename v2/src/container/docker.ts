// The only way v2 talks to Docker: the `docker` CLI, spawned as a child
// process (milestone 1 plan, decision 3). The label rule lives here:
//   - every object it creates carries `--label cleared.dev=v2`, and every
//     network, volume and container also `cleared.session=<id>`, as does an
//     image built for one session (a sibling's ticket layer, milestone 2);
//   - every list carries `--filter label=cleared.dev=v2`, and a listed row
//     without that label is refused even if the CLI ignored the filter;
//   - `docker stop`, `rm`, `exec` and the other commands that act on an
//     object take no filter, so they only ever name ids that a labelled list
//     returned in the same call, after `--`.
// assertLabelRule checks each command line before it runs; nothing reaches
// the runner without passing it.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const LABEL = 'cleared.dev=v2';
export const SESSION_LABEL = 'cleared.session';
export const ROLE_LABEL = 'cleared.role';

const LABEL_FILTER = `label=${LABEL}`;
const [LABEL_KEY, LABEL_VALUE] = LABEL.split('=') as [string, string];

export type DockerResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
// env: variables added to the client's own environment, for `--env NAME`
// to read there (ContainerSpec.privateEnv), never put on its command line.
export type RunOptions = { readonly input?: string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> };
export type DockerRunner = (args: readonly string[], options: RunOptions) => Promise<DockerResult>;
// Starts a long-lived docker process whose standard streams the caller keeps.
export type DockerSpawner = (args: readonly string[]) => ChildProcessWithoutNullStreams;

export class DockerError extends Error {
  override name = 'DockerError';
  // The last lines a failed command wrote, uncleaned: a build's first line
  // only says which builder ran. Absent when the error is not a command's.
  readonly tail?: string;
  constructor(message: string, tail?: string) {
    super(message);
    if (tail !== undefined) this.tail = tail;
  }
}

export class LabelRuleError extends Error {
  override name = 'LabelRuleError';
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Runs a command (the real CLI: cliRunner). Output is kept in memory: the commands this module
// builds print ids, JSON rows or a probe's short output.
export const commandRunner = (command: string): DockerRunner => (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
    // Its own timer rather than spawn's `timeout`, which stayed armed after a
    // failed spawn and kept the process alive until it fired.
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8') + (signal ? `\nkilled by ${signal}` : ''),
      });
    });
    // A command that exits without reading its input (or never starts)
    // makes the write fail with EPIPE: its exit code or spawn error says what
    // happened, so the write error is not thrown on its own.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });

export const cliRunner: DockerRunner = commandRunner('docker');

export const cliSpawner: DockerSpawner = (args) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

// Starts util-linux's `script` with the given arguments: it gives the docker
// client of a web terminal (Docker.terminal) the terminal `--tty` needs.
// `script` runs its command with $SHELL, set here to sh.
export const cliScripter: DockerSpawner = (args) => spawn('script', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } });

const CREATES = new Set(['create', 'build', 'network create', 'volume create']);
const SESSION_CREATES = new Set(['create', 'network create', 'volume create']);
// `image ls` prints no labels: each listed image is inspected, and its
// labels checked, before anything acts on it.
const LISTS = new Set(['ps', 'network ls', 'volume ls', 'image ls']);
// Commands that act on objects, with how many of the words after `--` are
// targets: all of them, or only the first (exec: the rest is the command).
const TARGETED = new Map<string, 'all' | 'first'>([
  ['start', 'all'], ['stop', 'all'], ['kill', 'all'], ['rm', 'all'], ['inspect', 'all'], ['logs', 'all'], ['exec', 'first'],
  ['network rm', 'all'], ['network inspect', 'all'], ['volume rm', 'all'], ['image inspect', 'all'], ['image rm', 'all'],
]);
const META = new Set(['version']);

function verbOf(args: readonly string[]): string {
  const [first = '', second = ''] = args;
  return first === 'network' || first === 'volume' || first === 'image' ? `${first} ${second}` : first;
}

const hasPair = (args: readonly string[], flag: string, value: string): boolean =>
  args.some((arg, index) => arg === flag && args[index + 1] === value);

// Throws unless the command line follows the label rule. `owned` holds the
// ids the previous labelled list returned; a targeted command may name only those.
export function assertLabelRule(args: readonly string[], owned: ReadonlySet<string>): void {
  const verb = verbOf(args);
  const shown = args.join(' ');
  if (CREATES.has(verb)) {
    if (!hasPair(args, '--label', LABEL)) throw new LabelRuleError(`docker ${verb} without --label ${LABEL}: ${shown}`);
    if (SESSION_CREATES.has(verb) && !args.some((arg, i) => arg === '--label' && args[i + 1]?.startsWith(`${SESSION_LABEL}=`)))
      throw new LabelRuleError(`docker ${verb} without --label ${SESSION_LABEL}=<id>: ${shown}`);
    return;
  }
  if (LISTS.has(verb)) {
    if (!hasPair(args, '--filter', LABEL_FILTER)) throw new LabelRuleError(`docker ${verb} without --filter ${LABEL_FILTER}: ${shown}`);
    return;
  }
  const scope = TARGETED.get(verb);
  if (scope) {
    const at = args.indexOf('--');
    const after = at < 0 ? [] : args.slice(at + 1);
    const targets = scope === 'first' ? after.slice(0, 1) : after;
    if (targets.length === 0) throw new LabelRuleError(`docker ${verb} without a target after "--": ${shown}`);
    for (const target of targets) {
      if (!owned.has(target)) throw new LabelRuleError(`docker ${verb} on ${target}, which no labelled list returned: ${shown}`);
    }
    return;
  }
  if (META.has(verb)) return;
  throw new LabelRuleError(`docker ${verb || '(nothing)'} is not a command this wrapper runs: ${shown}`);
}

// A session id is what Cleared chose (a UUID): lowercase, so it can never be
// read as an option, a filter pattern or a path.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSessionId = (session: string): boolean => SESSION_ID.test(session);
export function assertSessionId(session: string): void {
  if (!SESSION_ID.test(session)) throw new DockerError(`not a session id: ${JSON.stringify(session)}`);
}

// Values that go into flags: never empty, never an option, never a separator
// of the comma-separated --mount and --network forms.
const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
const LIMIT = /^[0-9]+(\.[0-9]+)?[a-z]?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_KEY_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const LABEL_VALUE_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const USER = /^[0-9]+:[0-9]+$|^[a-z_][a-z0-9_-]*$/;
const ENTRYPOINT = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function check(ok: boolean, what: string, value: unknown): void {
  if (!ok) throw new DockerError(`invalid ${what}: ${JSON.stringify(value)}`);
}

const absolute = (path: string): boolean => isAbsolute(path) && !/[,\n\0]/.test(path);

export type Mount = {
  readonly type: 'bind' | 'volume';
  readonly source: string;
  readonly target: string;
  readonly readonly?: boolean;
};

export type NetworkAttachment = { readonly name: string; readonly aliases?: readonly string[] };

export type Limits = { readonly memory: string; readonly cpus: string; readonly pids: number };

export type ContainerSpec = {
  readonly name: string;
  readonly session: string;
  readonly role: string;
  readonly image: string;
  readonly networks: readonly NetworkAttachment[];
  // One program, instead of the image's ENTRYPOINT: a check's container
  // sleeps whatever the project's image starts (flow/env-setup.ts).
  readonly entrypoint?: string;
  readonly command?: readonly string[];
  readonly user?: string;
  readonly readOnly?: boolean;
  readonly tmpfs?: readonly string[];
  readonly dropAllCapabilities?: boolean;
  readonly noNewPrivileges?: boolean;
  readonly limits?: Limits;
  readonly mounts?: readonly Mount[];
  readonly env?: Readonly<Record<string, string>>;
  // Variables whose values no other account of the machine may read (the
  // test secrets, C16): named on the command line, `--env NAME`, their
  // values in the client's environment, where the CLI reads them; a
  // command line is public in the process list.
  readonly privateEnv?: Readonly<Record<string, string>>;
  readonly workdir?: string;
  readonly interactive?: boolean;
};

export type ContainerRow = { readonly id: string; readonly name: string; readonly state: string; readonly labels: Readonly<Record<string, string>> };
export type NetworkRow = { readonly id: string; readonly name: string; readonly labels: Readonly<Record<string, string>> };
export type VolumeRow = { readonly name: string; readonly labels: Readonly<Record<string, string>> };
// workdir and volumes: the image's working folder and its VOLUME paths.
// created: when it was built, as Docker writes it (RFC 3339).
export type ImageRow = { readonly id: string; readonly name: string; readonly labels: Readonly<Record<string, string>>; readonly workdir: string; readonly volumes: readonly string[]; readonly created: string };

// `docker ... --format '{{json .}}'` prints labels as "k=v,k=v".
function parseLabels(text: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (typeof text !== 'string') return labels;
  for (const pair of text.split(',')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    labels[at < 0 ? pair : pair.slice(0, at)] = at < 0 ? '' : pair.slice(at + 1);
  }
  return labels;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function labelled<T extends { readonly labels: Readonly<Record<string, string>> }>(rows: T[], what: string, describe: (row: T) => string): T[] {
  for (const row of rows) {
    if (row.labels[LABEL_KEY] !== LABEL_VALUE) throw new LabelRuleError(`docker listed ${what} ${describe(row)} without ${LABEL}: refused`);
  }
  return rows;
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
const TAIL_LINES = 40;                       // the lines of a failed command's output a DockerError keeps

// One word of a command line for sh, quoted: `script` takes its command as one string.
const shellWord = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

export class Docker {
  private readonly runner: DockerRunner;
  private readonly spawner: DockerSpawner;
  private readonly scripter: DockerSpawner;

  constructor(runner: DockerRunner = cliRunner, spawner: DockerSpawner = cliSpawner, scripter: DockerSpawner = cliScripter) {
    this.runner = runner;
    this.spawner = spawner;
    this.scripter = scripter;
  }

  // Every command goes through here.
  private async call(args: readonly string[], owned: ReadonlySet<string> = new Set(), options: RunOptions = {}): Promise<DockerResult> {
    assertLabelRule(args, owned);
    return this.runner(args, options);
  }

  private async must(args: readonly string[], owned?: ReadonlySet<string>, options?: RunOptions): Promise<string> {
    const result = await this.call(args, owned, options);
    if (result.code !== 0) throw new DockerError(`docker ${verbOf(args)} failed (${result.code}): ${firstLine(result.stderr)}`, result.stderr.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'));
    return result.stdout;
  }

  private filters(session?: string): string[] {
    if (session !== undefined) assertSessionId(session);
    return ['--filter', LABEL_FILTER, ...(session === undefined ? [] : ['--filter', `label=${SESSION_LABEL}=${session}`])];
  }

  async version(): Promise<string> {
    const out = await this.must(['version', '--format', '{{json .}}']);
    const parsed = JSON.parse(out) as { Server?: { Version?: string } };
    return parsed.Server?.Version ?? 'unknown';
  }

  // Builds an image from a context folder; the image carries the label,
  // and the session's when it is built for one session, and the `labels`
  // given (a prepared image's service and hash). With `network: 'none'`, no
  // step of the build reaches a network.
  async build(spec: {
    readonly context: string; readonly dockerfile?: string; readonly tag: string; readonly timeoutMs?: number;
    readonly network?: 'none'; readonly session?: string; readonly labels?: Readonly<Record<string, string>>;
  }): Promise<void> {
    check(absolute(spec.context), 'build context', spec.context);
    check(spec.dockerfile === undefined || absolute(spec.dockerfile), 'Dockerfile', spec.dockerfile);
    check(IMAGE.test(spec.tag), 'image tag', spec.tag);
    if (spec.session !== undefined) assertSessionId(spec.session);
    const file = spec.dockerfile === undefined ? [] : ['--file', spec.dockerfile];
    const session = spec.session === undefined ? [] : ['--label', `${SESSION_LABEL}=${spec.session}`];
    const network = spec.network === undefined ? [] : ['--network', spec.network];
    const labels = Object.entries(spec.labels ?? {}).flatMap(([key, value]) => {
      check(LABEL_KEY_NAME.test(key) && key !== LABEL_KEY && key !== SESSION_LABEL, 'label', key);
      check(LABEL_VALUE_TEXT.test(value), 'label value', value);
      return ['--label', `${key}=${value}`];
    });
    await this.must(['build', '--label', LABEL, ...session, ...labels, ...network, '--tag', spec.tag, ...file, '--', spec.context], undefined, { timeoutMs: spec.timeoutMs ?? 1_800_000 });
  }

  async createNetwork(spec: { readonly name: string; readonly session: string; readonly internal: boolean }): Promise<string> {
    assertSessionId(spec.session);
    check(NAME.test(spec.name), 'network name', spec.name);
    // An internal network still gives its bridge a gateway address on the
    // host, and every host service listening on 0.0.0.0 answers there. The
    // isolated gateway mode (checked with Docker 29.8.1) assigns it none.
    const internal = spec.internal ? ['--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'] : [];
    const out = await this.must(['network', 'create', '--driver', 'bridge', ...internal,
      '--label', LABEL, '--label', `${SESSION_LABEL}=${spec.session}`, spec.name]);
    return out.trim();
  }

  async createVolume(spec: { readonly name: string; readonly session: string }): Promise<string> {
    assertSessionId(spec.session);
    check(NAME.test(spec.name), 'volume name', spec.name);
    const out = await this.must(['volume', 'create', '--label', LABEL, '--label', `${SESSION_LABEL}=${spec.session}`, spec.name]);
    return out.trim();
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    assertSessionId(spec.session);
    check(NAME.test(spec.name), 'container name', spec.name);
    check(NAME.test(spec.role), 'role', spec.role);
    check(IMAGE.test(spec.image), 'image', spec.image);
    const args = ['create', '--name', spec.name, '--label', LABEL, '--label', `${SESSION_LABEL}=${spec.session}`, '--label', `${ROLE_LABEL}=${spec.role}`];
    for (const network of spec.networks) {
      check(NAME.test(network.name), 'network', network.name);
      for (const alias of network.aliases ?? []) check(NAME.test(alias), 'network alias', alias);
      args.push('--network', [`name=${network.name}`, ...(network.aliases ?? []).map((alias) => `alias=${alias}`)].join(','));
    }
    if (spec.user !== undefined) {
      check(USER.test(spec.user), 'user', spec.user);
      args.push('--user', spec.user);
    }
    if (spec.readOnly) args.push('--read-only');
    for (const path of spec.tmpfs ?? []) {
      check(absolute(path) && !path.includes(':'), 'tmpfs path', path);
      args.push('--tmpfs', path);
    }
    if (spec.dropAllCapabilities) args.push('--cap-drop', 'ALL');
    if (spec.noNewPrivileges) args.push('--security-opt', 'no-new-privileges');
    if (spec.limits) {
      check(LIMIT.test(spec.limits.memory), 'memory limit', spec.limits.memory);
      check(LIMIT.test(spec.limits.cpus), 'cpu limit', spec.limits.cpus);
      check(Number.isInteger(spec.limits.pids) && spec.limits.pids > 0, 'pids limit', spec.limits.pids);
      // Memory and swap equal: no swap on top of the limit.
      args.push('--memory', spec.limits.memory, '--memory-swap', spec.limits.memory, '--cpus', spec.limits.cpus, '--pids-limit', String(spec.limits.pids));
    }
    for (const mount of spec.mounts ?? []) {
      check(mount.type === 'volume' ? NAME.test(mount.source) : absolute(mount.source), 'mount source', mount.source);
      check(absolute(mount.target), 'mount target', mount.target);
      args.push('--mount', `type=${mount.type},source=${mount.source},target=${mount.target}${mount.readonly ? ',readonly' : ''}`);
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      check(ENV_KEY.test(key) && !value.includes('\0'), 'environment variable', key);
      args.push('--env', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.privateEnv ?? {})) {
      check(ENV_KEY.test(key) && !value.includes('\0') && !Object.hasOwn(spec.env ?? {}, key), 'private environment variable', key);
      args.push('--env', key);
    }
    if (spec.workdir !== undefined) {
      check(absolute(spec.workdir), 'workdir', spec.workdir);
      args.push('--workdir', spec.workdir);
    }
    if (spec.interactive) args.push('--interactive');
    if (spec.entrypoint !== undefined) {
      check(ENTRYPOINT.test(spec.entrypoint), 'entrypoint', spec.entrypoint);
      args.push('--entrypoint', spec.entrypoint);
    }
    args.push('--', spec.image, ...(spec.command ?? []));
    const hidden = spec.privateEnv ?? {};
    const out = await this.must(args, undefined, Object.keys(hidden).length > 0 ? { env: hidden } : undefined);
    return out.trim();
  }

  async containers(session?: string): Promise<ContainerRow[]> {
    const out = await this.must(['ps', '--all', '--no-trunc', ...this.filters(session), '--format', '{{json .}}']);
    const rows = jsonLines(out).map((row) => ({ id: String(row.ID), name: String(row.Names), state: String(row.State), labels: parseLabels(row.Labels) }));
    return labelled(rows, 'container', (row) => row.name);
  }

  async networks(session?: string): Promise<NetworkRow[]> {
    const out = await this.must(['network', 'ls', '--no-trunc', ...this.filters(session), '--format', '{{json .}}']);
    const rows = jsonLines(out).map((row) => ({ id: String(row.ID), name: String(row.Name), labels: parseLabels(row.Labels) }));
    return labelled(rows, 'network', (row) => row.name);
  }

  async volumes(session?: string): Promise<VolumeRow[]> {
    const out = await this.must(['volume', 'ls', ...this.filters(session), '--format', '{{json .}}']);
    const rows = jsonLines(out).map((row) => ({ name: String(row.Name), labels: parseLabels(row.Labels) }));
    return labelled(rows, 'volume', (row) => row.name);
  }

  // The labelled images, of one session or with one tag: listed with the
  // label filter, then inspected, and each one's labels checked, since the
  // list does not print them.
  private async imageRows(filters: readonly string[]): Promise<ImageRow[]> {
    const out = await this.must(['image', 'ls', '--no-trunc', ...filters, '--format', '{{json .}}']);
    const ids = [...new Set(jsonLines(out).map((row) => String(row.ID)))];
    if (ids.length === 0) return [];
    type Inspected = { Id?: string; RepoTags?: string[] | null; Created?: string; Config?: { Labels?: Record<string, string> | null; WorkingDir?: string; Volumes?: Record<string, unknown> | null } };
    const inspected = JSON.parse(await this.must(['image', 'inspect', '--', ...ids], new Set(ids))) as Inspected[];
    const rows = inspected.map((image) => ({
      id: String(image.Id), name: image.RepoTags?.[0] ?? '<none>', labels: { ...(image.Config?.Labels ?? {}) },
      workdir: image.Config?.WorkingDir ?? '', volumes: Object.keys(image.Config?.Volumes ?? {}), created: image.Created ?? '',
    }));
    return labelled(rows, 'image', (row) => row.name);
  }

  async images(session: string): Promise<ImageRow[]> {
    const rows = await this.imageRows(this.filters(session));
    for (const row of rows) if (row.labels[SESSION_LABEL] !== session) throw new LabelRuleError(`docker listed image ${row.name} without ${SESSION_LABEL}=${session}: refused`);
    return rows;
  }

  // The labelled images that also carry `key=value` (a prepared image's service).
  async imagesLabelled(key: string, value: string): Promise<ImageRow[]> {
    check(LABEL_KEY_NAME.test(key), 'label', key);
    check(LABEL_VALUE_TEXT.test(value), 'label value', value);
    const rows = await this.imageRows(['--filter', LABEL_FILTER, '--filter', `label=${key}=${value}`]);
    for (const row of rows) if (row.labels[key] !== value) throw new LabelRuleError(`docker listed image ${row.name} without ${key}=${value}: refused`);
    return rows;
  }

  // A labelled image by its tag, or undefined when there is none.
  async image(tag: string): Promise<ImageRow | undefined> {
    check(IMAGE.test(tag), 'image tag', tag);
    return (await this.imageRows(['--filter', LABEL_FILTER, '--filter', `reference=${tag}`]))[0];
  }

  // Removes a labelled image by its tag: false when there is none.
  async removeImage(tag: string): Promise<boolean> {
    const row = await this.image(tag);
    if (!row) return false;
    await this.must(['image', 'rm', '--force', '--', row.id], new Set([row.id]));
    return true;
  }

  // The id of the session's container with this name, from a labelled list.
  private async owned(session: string, name: string): Promise<{ id: string; owned: ReadonlySet<string> }> {
    const row = (await this.containers(session)).find((c) => c.name === name || c.name === `/${name}`);
    if (!row) throw new DockerError(`no container named ${name} with ${LABEL} in session ${session}`);
    return { id: row.id, owned: new Set([row.id]) };
  }

  async start(session: string, name: string): Promise<void> {
    const { id, owned } = await this.owned(session, name);
    await this.must(['start', '--', id], owned);
  }

  // Kills a session's container, as a crash would (the tests of issue #453;
  // the service never calls it): by the id a labelled list returned, as
  // every targeted command.
  async kill(session: string, name: string): Promise<void> {
    const { id, owned } = await this.owned(session, name);
    await this.must(['kill', '--', id], owned);
  }

  // Runs a command in a running container and returns its result, whatever
  // its exit code: the caller decides what a failure means.
  async exec(session: string, name: string, command: readonly string[], options: { readonly input?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number } = {}): Promise<DockerResult> {
    check(command.length > 0, 'command', command);
    const { id, owned } = await this.owned(session, name);
    const env: string[] = [];
    for (const [key, value] of Object.entries(options.env ?? {})) {
      check(ENV_KEY.test(key), 'environment variable', key);
      env.push('--env', `${key}=${value}`);
    }
    return this.call(['exec', ...(options.input === undefined ? [] : ['--interactive']), ...env, '--', id, ...command], owned, options);
  }

  async inspect(session: string, name: string): Promise<Record<string, unknown>> {
    const { id, owned } = await this.owned(session, name);
    const [first] = JSON.parse(await this.must(['inspect', '--type', 'container', '--', id], owned)) as Record<string, unknown>[];
    return first ?? {};
  }

  async inspectNetwork(session: string, name: string): Promise<Record<string, unknown>> {
    const row = (await this.networks(session)).find((n) => n.name === name);
    if (!row) throw new DockerError(`no network named ${name} with ${LABEL} in session ${session}`);
    const [first] = JSON.parse(await this.must(['network', 'inspect', '--', row.id], new Set([row.id]))) as Record<string, unknown>[];
    return first ?? {};
  }

  // Starts a container created with `interactive` and returns the docker
  // process attached to its standard streams: the session adapter writes
  // to the runner's stdin and reads its stdout through it.
  async attach(session: string, name: string): Promise<ChildProcessWithoutNullStreams> {
    const { id, owned } = await this.owned(session, name);
    const args = ['start', '--attach', '--interactive', '--', id];
    assertLabelRule(args, owned);
    return this.spawner(args);
  }

  // A command in a running container whose standard streams the caller keeps
  // (the Cursor harness's turns: one process per turn, its prompt on the
  // standard input so that no word of it is a docker argument): `docker exec
  // --interactive` as the given user in the given folder.
  async execStream(session: string, name: string, options: { readonly user: string; readonly workdir: string; readonly command: readonly string[] }): Promise<ChildProcessWithoutNullStreams> {
    check(USER.test(options.user), 'user', options.user);
    check(absolute(options.workdir) && /^[A-Za-z0-9/_.-]+$/.test(options.workdir), 'workdir', options.workdir);
    check(options.command.length > 0 && options.command.every((word) => !word.includes('\0')), 'command', options.command);
    const { id, owned } = await this.owned(session, name);
    const args = ['exec', '--interactive', '--user', options.user, '--workdir', options.workdir, '--', id, ...options.command];
    assertLabelRule(args, owned);
    return this.spawner(args);
  }

  // A shell for a human in a running container (the web terminal of a
  // session taken over, milestone 2 decision 32): `docker exec --interactive
  // --tty` as the given user in the given folder, under the host's `script`,
  // which gives the client the terminal --tty needs. The command line `script`
  // runs is built from fixed words, the owned id and the checked user and
  // folder only; what the human types goes to the returned process's input.
  async terminal(session: string, name: string, options: { readonly user: string; readonly workdir: string; readonly command: readonly string[] }): Promise<ChildProcessWithoutNullStreams> {
    check(USER.test(options.user), 'user', options.user);
    check(absolute(options.workdir) && /^[A-Za-z0-9/_.-]+$/.test(options.workdir), 'workdir', options.workdir);
    check(options.command.length > 0 && options.command.every((word) => !word.includes('\0')), 'command', options.command);
    const { id, owned } = await this.owned(session, name);
    const args = ['exec', '--interactive', '--tty', '--env', 'TERM=xterm-256color', '--user', options.user, '--workdir', options.workdir, '--', id, ...options.command];
    assertLabelRule(args, owned);
    return this.scripter(['--quiet', '--return', '--flush', '--command', ['docker', ...args].map(shellWord).join(' '), '/dev/null']);
  }

  // What the container printed, both streams.
  async logs(session: string, name: string): Promise<string> {
    const { id, owned } = await this.owned(session, name);
    const result = await this.call(['logs', '--', id], owned);
    if (result.code !== 0) throw new DockerError(`docker logs failed (${result.code}): ${firstLine(result.stderr)}`);
    return result.stdout + result.stderr;
  }

  // Stops and removes the session's containers, then its networks, then
  // the images built for it; with `only`, just the ones named there. Each
  // removal names only what the labelled list just returned.
  async removeSession(
    session: string,
    options: {
      readonly stopTimeoutSeconds?: number;
      readonly only?: { readonly containers: readonly string[]; readonly networks: readonly string[]; readonly images?: readonly string[] };
    } = {},
  ): Promise<{ containers: number; networks: number; images: number }> {
    assertSessionId(session);
    const { stopTimeoutSeconds = 5, only } = options;
    const named = (name: string, list: readonly string[] | undefined): boolean => list === undefined || list.includes(name.replace(/^\//, ''));
    const containers = (await this.containers(session)).filter((row) => named(row.name, only?.containers)).map((row) => row.id);
    if (containers.length > 0) {
      const owned = new Set(containers);
      await this.must(['stop', '--time', String(stopTimeoutSeconds), '--', ...containers], owned);
      await this.must(['rm', '--force', '--volumes', '--', ...containers], owned);
    }
    const networks = (await this.networks(session)).filter((row) => named(row.name, only?.networks)).map((row) => row.id);
    if (networks.length > 0) await this.must(['network', 'rm', '--', ...networks], new Set(networks));
    const images = (await this.images(session)).filter((row) => only === undefined || (only.images ?? []).includes(row.name)).map((row) => row.id);
    if (images.length > 0) await this.must(['image', 'rm', '--force', '--', ...images], new Set(images));
    return { containers: containers.length, networks: networks.length, images: images.length };
  }

  // The subnets of every labelled network (the doctor's pool section, issue
  // 265): one labelled list, then an inspection of the ids it returned.
  async networkSubnets(): Promise<{ name: string; subnets: string[] }[]> {
    const rows = await this.networks();
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const inspected = JSON.parse(await this.must(['network', 'inspect', '--', ...ids], new Set(ids))) as { Name?: string; IPAM?: { Config?: { Subnet?: string }[] | null } }[];
    return inspected.map((n) => ({ name: String(n.Name ?? ''), subnets: (n.IPAM?.Config ?? []).flatMap((c) => (typeof c.Subnet === 'string' ? [c.Subnet] : [])) }));
  }

  // Releases the containers and networks of sessions that are stopped (issue
  // 265): one labelled list of each, then, by name, the rows whose
  // `cleared.session` is one of `sessions` and whose name is that
  // session's (`cleared-v2-<id>` or under it). The containers go first, so
  // that no network is still in use; never a volume, an image or a prune.
  async releaseStopped(sessions: readonly string[]): Promise<{ containers: string[]; networks: string[] }> {
    for (const session of sessions) assertSessionId(session);
    const wanted = new Set(sessions);
    const ours = (row: { readonly name: string; readonly labels: Readonly<Record<string, string>> }): boolean => {
      const session = row.labels[SESSION_LABEL];
      if (session === undefined || !wanted.has(session) || row.labels[LABEL_KEY] !== LABEL_VALUE) return false;
      const name = row.name.replace(/^\//, '');
      return name === `cleared-v2-${session}` || name.startsWith(`cleared-v2-${session}-`);
    };
    const containers = wanted.size === 0 ? [] : (await this.containers()).filter(ours).map((row) => row.name.replace(/^\//, ''));
    if (containers.length > 0) await this.must(['rm', '--force', '--', ...containers], new Set(containers));
    const networks = wanted.size === 0 ? [] : (await this.networks()).filter(ours).map((row) => row.name);
    if (networks.length > 0) await this.must(['network', 'rm', '--', ...networks], new Set(networks));
    return { containers, networks };
  }

  async removeVolumes(session: string): Promise<number> {
    assertSessionId(session);
    const volumes = (await this.volumes(session)).map((row) => row.name);
    if (volumes.length > 0) await this.must(['volume', 'rm', '--', ...volumes], new Set(volumes));
    return volumes.length;
  }
}
