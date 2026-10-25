// Prepared images (docs/v2/milestone-5-plan.md, section 10, decision 13,
// matrix C15): per service, cleared-v2-prep-<service>:<hash>, labelled
// cleared.dev=v2, cleared.service=<service> and cleared.prepared=<hash>,
// built ahead so that a session starts on it in seconds.
//
// The hash covers what the service's base branch holds, read from git's
// objects at refs/remotes/origin/<base> of its checkout, never the working
// tree: the devcontainer file (the service's folder's, else the
// repository's), the Dockerfile it builds, the lock files at the service's
// root, the install command (`[session] install_command` of its
// .cleared/agents.conf, one simple command), the image it starts from and
// this file's recipe. A manifest (package.json) is copied for the install
// but not hashed: a version or a script changes no dependency, a dependency
// changes the lock file.
//
// The image starts from Cleared's session image, the image the devcontainer
// file names (Cleared's own session image under any tag is this install's),
// or the one its Dockerfile builds, first, under <tag>-devcontainer. The
// manifests and lock files are copied to PREPARED_WORKDIR and the install
// command runs there, without a shell: the session's checkout is mounted
// over /workspace, which would hide anything the image put there, so the
// dependencies live outside it, and /node_modules links to them, where
// Node's resolution and npm's scripts look once /workspace has none.
//
// ensure() builds a service's image when no image is ready for its hash,
// and nothing otherwise; one build per service at a time, which a second
// caller waits for. Each build is recorded in <state>/prepared/<service>.json
// (mode 600): what the session's start, the environment step and the doctor
// read. After a build, the images of the two newest hashes of the service
// are kept and the older ones removed, chosen by the label and the exact
// repository name. choose() is the session's start: the ready image, or a
// build waited for, or Cleared's image with the reason.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { FlowListener } from '../flow/events.ts';
import { parseCommand } from '../session/policy.ts';
import { CheckoutError, exportBase, git } from '../workspace/checkout.ts';
import { parseConf } from '../workspace/config.ts';
import { DevcontainerError, parseJsonc, readDevcontainer } from './devcontainer.ts';
import { DockerError, type Docker } from './docker.ts';
import { SESSION_IMAGE } from './session-runtime.ts';

export const SERVICE_LABEL = 'cleared.service';
export const PREPARED_LABEL = 'cleared.prepared';
export const PREPARED_KEEP = 2;
export const PREPARED_WORKDIR = '/opt/cleared/prepared';
// Changed when what a build makes from the same inputs changes.
const RECIPE = '1';

// Hashed and copied: a change of one is a change of the dependencies.
export const LOCK_FILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'uv.lock',
  'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
] as const;
// Copied for the install command, which reads them beside the lock file.
export const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json'] as const;

const DEVCONTAINER = '.devcontainer/devcontainer.json';
const CONF = '.cleared/agents.conf';
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
const SERVICE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// <mode> SP <type> SP <object> TAB <path>
const ENTRY = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s;

export class PreparedError extends Error {
  override name = 'PreparedError';
}

// A service as the builder reads it: its checkout, as the flow fetches it,
// its base branch, and its folder when it is one of a monorepo.
export type PreparedSource = { readonly service: string; readonly dir: string; readonly base: string; readonly path: string | null };

export type PreparedInputs = {
  readonly commit: string;
  readonly hash: string;
  readonly devcontainer: 'none' | 'image' | 'dockerfile';
  readonly from: string | null;                     // the image it starts from; null: the devcontainer's Dockerfile builds it
  readonly devcontainerRoot: string;                // the repository folder whose .devcontainer is read ('' for the root)
  readonly install: readonly string[] | null;
  readonly installText: string | null;
  readonly files: readonly string[];                // copied, at the service's root
};

export type PreparedRecord = {
  readonly service: string;
  readonly dir: string;
  readonly base: string;
  readonly path: string | null;
  readonly state: 'building' | 'ready' | 'failed';  // the last build's
  readonly hash: string | null;                     // the last ready image's, with its tag and its build
  readonly tag: string | null;
  readonly builtAt: string | null;
  readonly buildMs: number | null;
  readonly attempt: string | null;                  // the hash the last build was for
  readonly startedAt: string | null;
  readonly error: string | null;                    // the failed build's first line
};

// The image a session starts on, and why when it is not the prepared one.
export type PreparedChoice =
  | { readonly kind: 'prepared'; readonly image: string; readonly waitedMs: number }
  | { readonly kind: 'default'; readonly reason: 'not_prepared' | 'not_fetched' | 'unreadable' | 'build_failed'; readonly waitedMs: number };

export const preparedTag = (service: string, hash: string): string => `cleared-v2-prep-${service}:${hash}`;
const repositoryOf = (service: string): string => `cleared-v2-prep-${service}`;

// The flow's state folder, where the adapters' runtime keeps its files.
export const stateDirOf = (env: NodeJS.ProcessEnv): string =>
  env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');

// --------------------------------------------------------------- inputs

async function baseCommitOf(source: PreparedSource): Promise<string | undefined> {
  try {
    const commit = (await git(source.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${source.base}^{commit}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : undefined;
  } catch (error) {
    if (error instanceof CheckoutError) return undefined;
    throw error;
  }
}

// The plain files among `paths` at the commit: path -> object id.
async function blobs(dir: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  for (const line of (await git(dir, ['ls-tree', '-r', '-z', commit, '--', ...paths])).split('\0')) {
    const match = ENTRY.exec(line);
    if (match && match[2] === 'blob' && (match[1] === '100644' || match[1] === '100755')) found.set(match[4] as string, match[3] as string);
  }
  return found;
}

const text = async (dir: string, object: string): Promise<string> => git(dir, ['cat-file', 'blob', object]);

// Cleared's own session image, under any tag, is the one this install built.
const fromImage = (named: string, baseImage: string): string => (/^cleared-v2-session(?::[A-Za-z0-9_.-]+)?$/.test(named) ? baseImage : named);

// What the base branch holds for the service's image, and its hash; undefined
// when the checkout has no base fetched. A devcontainer file or an install
// command that cannot be used is a PreparedError, said to the person.
export async function readInputs(source: PreparedSource, options: { readonly baseImage?: string } = {}): Promise<PreparedInputs | undefined> {
  const baseImage = options.baseImage ?? SESSION_IMAGE;
  if (!SERVICE.test(source.service)) throw new PreparedError(`not a service name: ${JSON.stringify(source.service)}`);
  if (source.path !== null && (source.path === '' || source.path.split('/').some((part) => part === '' || part === '.' || part === '..'))) throw new PreparedError(`not a folder of the repository: ${JSON.stringify(source.path)}`);
  const commit = await baseCommitOf(source);
  if (!commit) return undefined;
  const at = (file: string) => (source.path === null ? file : `${source.path}/${file}`);
  const named = [...LOCK_FILES, ...MANIFEST_FILES].map(at);
  const found = await blobs(source.dir, commit, [...new Set([...named, at(CONF), CONF, at(DEVCONTAINER), DEVCONTAINER])]);

  // The install command: the folder's settings, else the repository's.
  const conf = found.get(at(CONF)) ?? found.get(CONF);
  const installText = conf === undefined ? null : (parseConf(await text(source.dir, conf)).session?.install_command?.trim() || null);
  const install = installText === null ? null : parseCommand(installText) ?? null;
  if (installText !== null && !install) throw new PreparedError(`[session] install_command must be one simple command (no list, pipe, redirection or expansion), not "${installText.slice(0, 80)}"`);

  // The devcontainer file: the folder's, else the repository's.
  const devcontainerRoot = found.has(at(DEVCONTAINER)) ? (source.path ?? '') : '';
  const devcontainerPath = devcontainerRoot === '' ? DEVCONTAINER : `${devcontainerRoot}/${DEVCONTAINER}`;
  const devcontainerObject = found.get(devcontainerPath);
  let devcontainer: PreparedInputs['devcontainer'] = 'none';
  let from: string | null = baseImage;
  let dockerfile: readonly [string, string] | null = null;
  if (devcontainerObject !== undefined) {
    let config: Record<string, unknown>;
    try {
      const parsed = parseJsonc(await text(source.dir, devcontainerObject));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SyntaxError('expected an object');
      config = parsed as Record<string, unknown>;
    } catch (error) {
      throw new PreparedError(`${devcontainerPath}: not valid JSON with comments (${(error as Error).message})`);
    }
    const build = config.build as Record<string, unknown> | undefined;
    if (typeof config.image === 'string' && build === undefined) {
      if (!IMAGE.test(config.image)) throw new PreparedError(`${devcontainerPath}: image must be an image reference`);
      devcontainer = 'image';
      from = fromImage(config.image, baseImage);
    } else if (build !== undefined && typeof build === 'object' && build !== null && typeof build.dockerfile === 'string' && config.image === undefined) {
      const path = posix.normalize(posix.join(posix.dirname(devcontainerPath), build.dockerfile));
      if (path.startsWith('../') || path === '..' || posix.isAbsolute(path)) throw new PreparedError(`${devcontainerPath}: build.dockerfile leaves the repository`);
      devcontainer = 'dockerfile';
      from = null;
      dockerfile = [path, (await blobs(source.dir, commit, [path])).get(path) ?? 'missing'];
    } else if (config.image !== undefined || build !== undefined) {
      throw new PreparedError(`${devcontainerPath}: give either image or build.dockerfile`);
    }
  }

  const files = named.filter((path) => found.has(path)).map((path) => posix.basename(path)).sort();
  const locks = LOCK_FILES.map(at).filter((path) => found.has(path)).map((path) => [posix.basename(path), found.get(path)]);
  const hash = createHash('sha256').update(JSON.stringify({
    recipe: RECIPE, from, install, locks,
    devcontainer: devcontainerObject === undefined ? null : [devcontainerPath, devcontainerObject], dockerfile,
  })).digest('hex').slice(0, 16);
  return { commit, hash, devcontainer, from, devcontainerRoot, install, installText, files, };
}

// ------------------------------------------------------------- Dockerfile

const words = (list: readonly string[]): string => JSON.stringify(list).replace(/","/g, '", "');

// Cleared's Dockerfile of a prepared image: FROM, the files copied to
// PREPARED_WORKDIR, the install command in exec form, the link. Every word is
// checked, so nothing the branch holds becomes an instruction.
export function preparedDockerfile(input: { readonly from: string; readonly files: readonly string[]; readonly install: readonly string[] | null }): string {
  if (!IMAGE.test(input.from)) throw new PreparedError(`not an image reference: ${JSON.stringify(input.from.slice(0, 80))}`);
  for (const file of input.files) if (!FILE_NAME.test(file)) throw new PreparedError(`not a file of the service's root: ${JSON.stringify(file)}`);
  // eslint-disable-next-line no-control-regex
  if (input.install && (input.install.length === 0 || input.install.some((word) => /[\u0000-\u001f]/.test(word)))) throw new PreparedError('the install command holds a control character');
  const node = input.files.includes('package.json');
  const runs = input.install !== null || node;
  return [
    '# Generated by Cleared v2 (C15): the image a session starts on, its dependencies installed outside /workspace, which the checkout covers.',
    `FROM ${input.from}`,
    ...(runs ? ['USER root'] : []),
    ...(input.files.length > 0 ? [`WORKDIR ${PREPARED_WORKDIR}`, `COPY ${words([...input.files, `${PREPARED_WORKDIR}/`])}`] : []),
    ...(input.install ? [`RUN ${words(input.install)}`] : []),
    ...(node ? [`RUN ${words(['ln', '-s', `${PREPARED_WORKDIR}/node_modules`, '/node_modules'])}`] : []),
    'WORKDIR /workspace',
    '',
  ].join('\n');
}

// --------------------------------------------------------------- records

const recordFile = (stateDir: string, service: string): string => join(stateDir, 'prepared', `${service}.json`);

export function readRecord(stateDir: string, service: string): PreparedRecord | undefined {
  if (!SERVICE.test(service)) return undefined;
  try {
    return JSON.parse(readFileSync(recordFile(stateDir, service), 'utf8')) as PreparedRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(stateDir: string, record: PreparedRecord): void {
  const file = recordFile(stateDir, record.service);
  mkdirSync(join(stateDir, 'prepared'), { recursive: true, mode: 0o700 });
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
}

// The first line of what went wrong, short: a build's output may be long.
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 240) ?? 'unknown';

// ---------------------------------------------------------------- builder

// The builds running in this process, by state folder and service: the
// environment step, the merge hook and a session's start share them.
const BUILDS = new Map<string, Promise<PreparedRecord>>();

export class PreparedImages {
  readonly stateDir: string;
  readonly #docker: Docker;
  readonly #baseImage: string;
  readonly #now: () => Date;

  constructor(deps: { readonly docker: Docker; readonly stateDir: string; readonly baseImage?: string; readonly now?: () => Date }) {
    this.#docker = deps.docker;
    this.stateDir = deps.stateDir;
    this.#baseImage = deps.baseImage ?? SESSION_IMAGE;
    this.#now = deps.now ?? (() => new Date());
  }

  readInputs(source: PreparedSource): Promise<PreparedInputs | undefined> {
    return readInputs(source, { baseImage: this.#baseImage });
  }

  building(service: string): boolean {
    return BUILDS.has(`${this.stateDir}\0${service}`);
  }

  // The service's image ready for what its base holds now: built when there
  // is none, nothing otherwise.
  async ensure(source: PreparedSource): Promise<PreparedRecord> {
    const key = `${this.stateDir}\0${source.service}`;
    for (let running = BUILDS.get(key); running; running = BUILDS.get(key)) await running.catch(() => undefined);
    const made = this.#ensure(source);
    BUILDS.set(key, made);
    try {
      return await made;
    } finally {
      if (BUILDS.get(key) === made) BUILDS.delete(key);
    }
  }

  async #ensure(source: PreparedSource): Promise<PreparedRecord> {
    const inputs = await this.readInputs(source);
    if (!inputs) throw new PreparedError(`the base branch ${source.base} of ${source.service} is not fetched in its checkout`);
    const tag = preparedTag(source.service, inputs.hash);
    const record = readRecord(this.stateDir, source.service);
    if (record?.state === 'ready' && record.hash === inputs.hash && (await this.#docker.image(tag))) {
      if (record.dir === source.dir && record.base === source.base && record.path === source.path) return record;
      const moved = { ...record, dir: source.dir, base: source.base, path: source.path };
      writeRecord(this.stateDir, moved);
      return moved;
    }
    return this.#build(source, inputs, record);
  }

  async #build(source: PreparedSource, inputs: PreparedInputs, before: PreparedRecord | undefined): Promise<PreparedRecord> {
    const tag = preparedTag(source.service, inputs.hash);
    const started = this.#now();
    const clock = Date.now();
    const kept = {
      service: source.service, dir: source.dir, base: source.base, path: source.path,
      hash: before?.hash ?? null, tag: before?.tag ?? null, builtAt: before?.builtAt ?? null, buildMs: before?.buildMs ?? null,
      attempt: inputs.hash, startedAt: started.toISOString(),
    };
    writeRecord(this.stateDir, { ...kept, state: 'building', error: null });
    const labels = { [SERVICE_LABEL]: source.service, [PREPARED_LABEL]: inputs.hash };
    const work = mkdtempSync(join(tmpdir(), 'cleared-v2-prep-'));
    try {
      const exported = await exportBase({ project: source.dir, base: source.base, root: join(work, 'base') });
      if (!exported) throw new PreparedError(`the base branch ${source.base} of ${source.service} could not be exported`);
      // The base moved since it was read: the files are the new one's, so is the hash.
      if (exported.commit !== inputs.commit) throw new PreparedError('the base branch moved during the build: build again');
      let from = inputs.from;
      if (from === null) {
        const choice = readDevcontainer(join(exported.dir, inputs.devcontainerRoot), this.#baseImage);
        if (choice.kind !== 'dockerfile') throw new PreparedError('the devcontainer file names no Dockerfile');
        from = `${tag}-devcontainer`;
        await this.#docker.build({ context: choice.context, dockerfile: choice.dockerfile, tag: from, labels });
      }
      const root = source.path === null ? exported.dir : join(exported.dir, source.path);
      const context = join(work, 'context');
      mkdirSync(context);
      for (const file of inputs.files) {
        if (!lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) throw new PreparedError(`${file} is not a plain file`);
        copyFileSync(join(root, file), join(context, file));
      }
      writeFileSync(join(context, 'Dockerfile'), preparedDockerfile({ from, files: inputs.files, install: inputs.install }));
      await this.#docker.build({ context, dockerfile: join(context, 'Dockerfile'), tag, labels });
      const ready: PreparedRecord = {
        ...kept, state: 'ready', hash: inputs.hash, tag, builtAt: this.#now().toISOString(), buildMs: Date.now() - clock, error: null,
      };
      writeRecord(this.stateDir, ready);
      await this.cleanup(source.service).catch((error) => console.error(`cleared-v2: the older prepared images of ${source.service} were not removed (${firstLine(error)})`));
      return ready;
    } catch (error) {
      if (!(error instanceof PreparedError || error instanceof DockerError || error instanceof CheckoutError || error instanceof DevcontainerError)) throw error;
      const reason = firstLine(error);
      writeRecord(this.stateDir, { ...kept, state: 'failed', error: reason });
      throw error instanceof PreparedError ? error : new PreparedError(reason, { cause: error });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Keeps the images of the PREPARED_KEEP newest hashes of the service; only
  // labelled images of its exact repository name are looked at.
  async cleanup(service: string): Promise<number> {
    const prefix = `${repositoryOf(service)}:`;
    const rows = (await this.#docker.imagesLabelled(SERVICE_LABEL, service)).filter((row) => row.name.startsWith(prefix));
    const newest = new Map<string, string>();
    for (const row of rows) {
      const hash = row.labels[PREPARED_LABEL] ?? '';
      if ((newest.get(hash) ?? '') < row.created) newest.set(hash, row.created);
    }
    const kept = new Set([...newest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, PREPARED_KEEP).map(([hash]) => hash));
    let removed = 0;
    for (const row of rows) {
      if (kept.has(row.labels[PREPARED_LABEL] ?? '')) continue;
      if (await this.#docker.removeImage(row.name)) removed += 1;
    }
    return removed;
  }

  // The image a session of `service` starts on. A service never prepared,
  // or whose base cannot be read, runs Cleared's image; a ready image is
  // used at once; otherwise the session waits for the build (onWait says
  // so), and runs Cleared's image if it fails. A build that already failed
  // for this hash is not tried again at a start: the person fixes it first.
  async choose(service: string, onWait?: () => void): Promise<PreparedChoice> {
    const record = readRecord(this.stateDir, service);
    if (!record) return { kind: 'default', reason: 'not_prepared', waitedMs: 0 };
    const source: PreparedSource = { service, dir: record.dir, base: record.base, path: record.path };
    let inputs: PreparedInputs | undefined;
    try {
      inputs = await this.readInputs(source);
    } catch (error) {
      if (error instanceof PreparedError) return { kind: 'default', reason: 'unreadable', waitedMs: 0 };
      throw error;
    }
    if (!inputs) return { kind: 'default', reason: 'not_fetched', waitedMs: 0 };
    const tag = preparedTag(service, inputs.hash);
    if (!this.building(service)) {
      if (record.state === 'ready' && record.hash === inputs.hash && (await this.#docker.image(tag))) return { kind: 'prepared', image: tag, waitedMs: 0 };
      if (record.state === 'failed' && record.attempt === inputs.hash) return { kind: 'default', reason: 'build_failed', waitedMs: 0 };
    }
    onWait?.();
    const started = Date.now();
    try {
      const ready = await this.ensure(source);
      return { kind: 'prepared', image: ready.tag as string, waitedMs: Date.now() - started };
    } catch (error) {
      if (!(error instanceof PreparedError)) throw error;
      return { kind: 'default', reason: 'build_failed', waitedMs: Date.now() - started };
    }
  }
}

// A merge builds again the images of the services it may have changed:
// those a prepared image was ever built for, fetched first, then ensured,
// which builds nothing when the hash did not move. A failure is one line of
// the service's log.
export function preparedAfterMerge(deps: {
  readonly images: PreparedImages;
  readonly services: () => readonly PreparedSource[];
  readonly fetch: (source: PreparedSource) => Promise<void>;
}): FlowListener {
  return (event) => {
    if (event.type !== 'release_merged') return;
    return (async () => {
      for (const source of deps.services()) {
        if (event.service !== undefined && event.service !== source.service) continue;
        if (!readRecord(deps.images.stateDir, source.service)) continue;
        try {
          await deps.fetch(source);
          await deps.images.ensure(source);
        } catch (error) {
          console.error(`cleared-v2: the prepared image of ${source.service} was not built after pull request #${event.pr} (${firstLine(error)})`);
        }
      }
    })();
  };
}
