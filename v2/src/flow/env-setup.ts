// The setup session (docs/v2/milestone-5-plan.md, section 13, decision 14,
// matrix C4 and M10's setup sessions): a ticket of the "Prepare the
// environment" template (tickets/templates.ts), whose author writes the
// service's .devcontainer/devcontainer.json, with a Dockerfile for anything
// beyond an image. Cleared reads `image` and `build.dockerfile` only.
//
// Before its reviewer, the flow checks the branch (engine.ts, #authorDone):
// the image the branch would give the service once merged is built with the
// prepared images' builder (container/prepared.ts), from the branch's files
// read out of git's objects, and the service's declared check (`[session]
// test_command` of its base's agents.conf, else `npm test` when package.json
// has a test script) runs inside it, the branch's tree mounted at
// /workspace, with no capability and the session's limits, and no network
// but the one its declared test services (`[session] services`) are on, as
// a session has them, with their variables (its DATABASE_URL). A
// failure goes back to the author with the last lines of its output, cleaned
// by the engine and cut; a pass goes to the review. A service that declares
// no check stops at a working image. ENV_CHECK_ROUNDS failures put the
// ticket back in Todo.
//
// What the check makes carries cleared.dev=v2 and a session label of its own,
// never a prepared image's labels or name, and is removed by that label when
// it ends, whatever happened. The branch's own Dockerfile is built with
// Docker's default network, as a prepared image's is: installing a system
// package is what it is for. Nothing of the service's is mounted into it.
//
// After the merge, environmentAfterMerge builds the service's prepared image
// when it has none yet; one it has is built again by preparedAfterMerge.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DockerError, type Docker } from '../container/docker.ts';
import { DevcontainerError } from '../container/devcontainer.ts';
import { PreparedError, buildPrepared, readInputs, readRecord, type PreparedImages, type PreparedSource } from '../container/prepared.ts';
import { DEFAULT_LIMITS, SERVICE_LIMITS, SESSION_IMAGE, sessionNames } from '../container/session-runtime.ts';
import type { ServiceSpec } from '../container/services.ts';
import { duration } from '../lead/plans/estimates.ts';
import { typeLabel } from '../tickets/templates.ts';
import { CheckoutError, exportBase, git } from '../workspace/checkout.ts';
import { parseConf } from '../workspace/config.ts';
import { FlowConfigError, projectSettings } from './config.ts';
import type { FlowListener } from './events.ts';
import { TAIL_LINES } from './review-tests.ts';

export const ENVIRONMENT_LABEL = typeLabel('environment');
export const ENV_CHECK_ROUNDS = 3;                 // the failed checks after which the ticket goes back to Todo
export const ENV_CHECK_ROLE = 'env-check';
const LINE_MAX = 300;                              // the longest line of output kept
const CHECK_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 60_000;                   // a test service's, as a session's start waits for it
const WORKSPACE = '/workspace';

export const isEnvironmentTicket = (labels: readonly string[]): boolean => labels.includes(ENVIRONMENT_LABEL);

// What one check found. `tail`: the output's last lines, cut, not cleaned
// (the engine cleans what it writes); `checkMs`: null when nothing ran.
export type EnvCheck = {
  readonly outcome: 'passed' | 'failed' | 'build_failed' | 'no_check';
  readonly command: string | null;
  readonly tail: string | null;
  readonly buildMs: number;
  readonly checkMs: number | null;
  readonly devcontainer: 'none' | 'image' | 'dockerfile' | null;
};

// The last TAIL_LINES lines of `text`, each cut at LINE_MAX.
export function cut(text: string): string {
  return text.trimEnd().split('\n').slice(-TAIL_LINES).map((line) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)).join('\n');
}

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, LINE_MAX) ?? '';

// --------------------------------------------------------------- the check

// The service's declared check, as the flow reads it, and its test services.
export type DeclaredCheck = { readonly command: readonly string[]; readonly services: readonly ServiceSpec[] };

// The declared check run in `image`, `tree` mounted at /workspace and the
// command run in `workdir` under it. Its test services run first, as a
// session's do, on an internal network of the check's, which is its only
// one; with none, it has no network. Everything lives under a session id of
// the check's own, which the caller removes, with the images built under it.
export async function checkImage(input: {
  readonly docker: Docker; readonly session: string; readonly image: string; readonly tree: string; readonly workdir: string;
  readonly command: readonly string[]; readonly services?: readonly ServiceSpec[]; readonly timeoutMs?: number; readonly readyTimeoutMs?: number;
}): Promise<{ readonly passed: boolean; readonly tail: string; readonly ms: number }> {
  const { docker, session } = input;
  const names = sessionNames(session);
  const name = `cleared-v2-${session}`;
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS;
  const services = input.services ?? [];
  if (services.length > 0) {
    await docker.createNetwork({ name: names.network, session, internal: true });
    for (const service of services) {
      await docker.createContainer({
        name: names.service(service.alias), session, role: 'service', image: service.image,
        networks: [{ name: names.network, aliases: [service.alias] }], tmpfs: service.tmpfs, env: service.env, limits: SERVICE_LIMITS,
      });
      await docker.start(session, names.service(service.alias));
    }
    for (const service of services) {
      const deadline = Date.now() + (input.readyTimeoutMs ?? READY_TIMEOUT_MS);
      while ((await docker.exec(session, names.service(service.alias), service.ready)).code !== 0) {
        if (Date.now() >= deadline) throw new DockerError(`the test service ${service.alias} did not become ready within ${took(input.readyTimeoutMs ?? READY_TIMEOUT_MS)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  await docker.createContainer({
    name, session, role: ENV_CHECK_ROLE, image: input.image, networks: [{ name: services.length > 0 ? names.network : 'none' }],
    env: Object.assign({}, ...services.map((service) => service.sessionEnv)) as Record<string, string>,
    // The container ends itself a minute after the check's own limit, whatever happens to the service;
    // sleep is its program whatever ENTRYPOINT the project's image names.
    entrypoint: 'sleep', command: [String(Math.ceil(timeoutMs / 1000) + 60)],
    dropAllCapabilities: true, noNewPrivileges: true, limits: DEFAULT_LIMITS,
    mounts: [{ type: 'bind', source: input.tree, target: WORKSPACE }], workdir: input.workdir,
  });
  await docker.start(session, name);
  const started = Date.now();
  const result = await docker.exec(session, name, input.command, { timeoutMs });
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  return { passed: result.code === 0, tail: cut(output), ms: Date.now() - started };
}

// The ticket's branch, fetched into the service's checkout under `ref`,
// built as the service's prepared image would be once it is merged, then
// the declared check run in it. Everything it made is removed before it
// answers. Throws only when Docker or git cannot be asked at all.
export async function checkBranch(input: {
  readonly docker: Docker; readonly stateDir: string; readonly source: PreparedSource; readonly ref: string;
  readonly declared: DeclaredCheck | undefined; readonly baseImage?: string; readonly checkTimeoutMs?: number;
}): Promise<EnvCheck> {
  const { docker, source } = input;
  const baseImage = input.baseImage ?? SESSION_IMAGE;
  const command = input.declared && input.declared.command.length > 0 ? input.declared.command : undefined;
  const commandText = command ? command.join(' ') : null;
  const session = randomUUID();
  const work = mkdtempSync(join(tmpdir(), 'cleared-v2-check-'));
  // The branch's tree, mounted into the check's container: under the state
  // folder, which a Compose install mounts at the same path as the host's.
  const trees = join(input.stateDir, 'env-check', session);
  const started = Date.now();
  let devcontainer: EnvCheck['devcontainer'] = null;
  const failedBuild = (tail: string): EnvCheck => ({ outcome: 'build_failed', command: commandText, tail: cut(tail), buildMs: Date.now() - started, checkMs: null, devcontainer });
  try {
    let tree: string;
    let tag: string;
    try {
      const inputs = await readInputs(source, { baseImage, at: input.ref });
      if (!inputs) return failedBuild(`the branch ${input.ref} is not in the checkout of ${source.service}`);
      devcontainer = inputs.devcontainer;
      mkdirSync(trees, { recursive: true, mode: 0o700 });
      const exported = await exportBase({ project: source.dir, base: source.base, root: trees, commit: inputs.commit });
      if (!exported) return failedBuild(`the branch of ${source.service} could not be exported`);
      tree = exported.dir;
      tag = `cleared-v2-check-${source.service}:${inputs.hash}`;
      await buildPrepared({ docker, source, inputs, tree, work, tag, labels: {}, baseImage, session });
    } catch (error) {
      if (error instanceof DockerError) return failedBuild(error.tail || error.message);
      if (error instanceof PreparedError || error instanceof DevcontainerError || error instanceof CheckoutError) return failedBuild(error.message);
      throw error;
    }
    const buildMs = Date.now() - started;
    if (!command) return { outcome: 'no_check', command: null, tail: null, buildMs, checkMs: null, devcontainer };
    const workdir = source.path === null ? WORKSPACE : posix.join(WORKSPACE, source.path);
    const ran = await checkImage({ docker, session, image: tag, tree, workdir, command, services: input.declared?.services ?? [], ...(input.checkTimeoutMs === undefined ? {} : { timeoutMs: input.checkTimeoutMs }) });
    return { outcome: ran.passed ? 'passed' : 'failed', command: commandText, tail: ran.tail, buildMs, checkMs: ran.ms, devcontainer };
  } finally {
    await docker.removeSession(session, { stopTimeoutSeconds: 1 }).catch((error) => console.error(`cleared-v2: the environment check of ${source.service} left objects labelled ${session} (${firstLine(error)})`));
    rmSync(trees, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------- the assistant's environment step

// The check the service's base declares, as the flow reads it
// (effects.ts settings): `[session] test_command` of its agents.conf, else
// `npm test` when its package.json has a test script, with its `[session]
// services`. Undefined: none, or settings that cannot be read, which the
// checks step says.
export async function declaredCheck(source: Pick<PreparedSource, 'dir' | 'base'>): Promise<DeclaredCheck | undefined> {
  const at = `refs/remotes/origin/${source.base}`;
  try {
    const conf = parseConf(await git(source.dir, ['show', `${at}:.cleared/agents.conf`]));
    let scripts: string[] = [];
    try {
      scripts = Object.keys((JSON.parse(await git(source.dir, ['show', `${at}:package.json`])) as { scripts?: Record<string, unknown> }).scripts ?? {});
    } catch { /* no package.json at the base: no script */ }
    const settings = projectSettings(conf, scripts);
    return settings.testCommand ? { command: settings.testCommand, services: settings.services } : undefined;
  } catch (error) {
    if (error instanceof CheckoutError || error instanceof FlowConfigError) return undefined;
    throw error;
  }
}

// Whether the service's base holds a .devcontainer file, its folder's or
// the repository's; null when its base is not fetched.
export async function hasDevcontainer(source: Pick<PreparedSource, 'dir' | 'base' | 'path'>): Promise<boolean | null> {
  const at = `refs/remotes/origin/${source.base}`;
  const files = ['.devcontainer/devcontainer.json', ...(source.path === null ? [] : [`${source.path}/.devcontainer/devcontainer.json`])];
  try {
    return (await git(source.dir, ['ls-tree', '--name-only', at, '--', ...files])).trim() !== '';
  } catch (error) {
    if (error instanceof CheckoutError) return null;
    throw error;
  }
}

// The last check run in a service's prepared image, by the environment
// step: <state>/prepared/<service>.check.json, mode 600. `hash`: the image's.
export type PreparedCheck = { readonly hash: string; readonly command: string; readonly passed: boolean; readonly at: string; readonly ms: number; readonly tail: string };

const checkFile = (stateDir: string, service: string): string => join(stateDir, 'prepared', `${service}.check.json`);

export function readPreparedCheck(stateDir: string, service: string): PreparedCheck | undefined {
  if (!/^[a-z0-9-]+$/.test(service)) return undefined;
  try {
    return JSON.parse(readFileSync(checkFile(stateDir, service), 'utf8')) as PreparedCheck;
  } catch {
    return undefined;
  }
}

function writePreparedCheck(stateDir: string, service: string, check: PreparedCheck): void {
  mkdirSync(join(stateDir, 'prepared'), { recursive: true, mode: 0o700 });
  const file = checkFile(stateDir, service);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(check, null, 2)}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
}

// The declared check run in the service's ready prepared image, on its
// base's tree, as a session of it would run it; recorded for the step, its
// output passed through `clean` first (the service's cleaner): the record
// is read by the browser.
// Undefined when the service declares none. The image is the prepared
// one, never removed here: only the check's container is.
export async function checkPrepared(input: {
  readonly docker: Docker; readonly stateDir: string; readonly source: PreparedSource; readonly image: string; readonly hash: string;
  readonly declared: DeclaredCheck | undefined; readonly clean: (text: string) => string; readonly now?: () => Date; readonly timeoutMs?: number;
}): Promise<PreparedCheck | undefined> {
  const { docker, source, declared } = input;
  if (!declared || declared.command.length === 0) return undefined;
  const session = randomUUID();
  const trees = join(input.stateDir, 'env-check', session);
  try {
    mkdirSync(trees, { recursive: true, mode: 0o700 });
    const exported = await exportBase({ project: source.dir, base: source.base, root: trees });
    if (!exported) throw new PreparedError(`the base branch ${source.base} of ${source.service} could not be exported`);
    const workdir = source.path === null ? WORKSPACE : posix.join(WORKSPACE, source.path);
    const ran = await checkImage({ docker, session, image: input.image, tree: exported.dir, workdir, command: declared.command, services: declared.services, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    const check: PreparedCheck = { hash: input.hash, command: declared.command.join(' '), passed: ran.passed, at: (input.now ?? (() => new Date()))().toISOString(), ms: ran.ms, tail: input.clean(ran.tail) };
    writePreparedCheck(input.stateDir, source.service, check);
    return check;
  } finally {
    await docker.removeSession(session, { stopTimeoutSeconds: 1 }).catch((error) => console.error(`cleared-v2: the check of ${source.service}'s image left objects labelled ${session} (${firstLine(error)})`));
    rmSync(trees, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ words

// "34 s", "2 min 10 s", "1 h 05": how a ticket's comment says a duration.
export function took(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
  return duration(seconds / 60);
}

const FROM: Record<NonNullable<EnvCheck['devcontainer']>, string> = {
  none: 'from Cleared\'s session image (no .devcontainer)',
  image: 'from the image its .devcontainer names',
  dockerfile: 'from the Dockerfile its .devcontainer names',
};
const NO_CHECK = 'The service declares no check ([session] test_command in .cleared/agents.conf, or a test script in package.json), so a working image is the whole check.';

const block = (tail: string): string => `\n\n\`\`\`\n${tail.replaceAll('```', "'''")}\n\`\`\``;

// What the check found, in one or two sentences, and the output when it failed.
function said(check: EnvCheck): string {
  const built = `the branch's image built in ${took(check.buildMs)}${check.devcontainer ? ` ${FROM[check.devcontainer]}` : ''}`;
  switch (check.outcome) {
    case 'passed': return `${built}, and \`${check.command}\` passed in it in ${took(check.checkMs ?? 0)}.`;
    case 'no_check': return `${built}. ${NO_CHECK}`;
    case 'failed': return `${built}, and \`${check.command}\` failed in it after ${took(check.checkMs ?? 0)}. The last lines of its output:${block(check.tail ?? '')}`;
    case 'build_failed': return `the branch's image could not be built. The last lines of the build:${block(check.tail ?? '')}`;
  }
}

// The comment on the ticket, at each round.
export function envCheckComment(check: EnvCheck, round: number): string {
  return `Environment check, round ${round}: ${said(check)}`;
}

// What the author is sent when the check failed: its `failures`-th failure
// of `limit`, after which the ticket goes back to Todo.
export function envCheckRequest(check: EnvCheck, failures: number, limit: number): string {
  return `The environment check failed (attempt ${failures} of ${limit}): ${said(check)}\n\n`
    + 'Fix .devcontainer/devcontainer.json, or the Dockerfile it names, on this branch. Cleared reads `image` or `build.dockerfile` only, '
    + 'and a session needs Node 24, Claude Code and Cleared\'s runner, so start from cleared-v2-session. Commit, then end your turn: the check runs again before the review.';
}

// The note of a ticket put back after the last round.
export function envCheckGiveUp(check: EnvCheck, rounds: number): string {
  return `The environment check still failed after ${rounds} rounds, so the ticket goes back to Todo. The last one: ${said(check)}`;
}

// ------------------------------------------------------------------ rows

// `run`: when the ticket's run started (a start, after a put back, is a new
// one); its checks' rounds and failures count within it.
export const ENV_CHECKS_TABLE = `CREATE TABLE IF NOT EXISTS env_checks (
  ticket TEXT NOT NULL, run TEXT NOT NULL, round INTEGER NOT NULL, project TEXT NOT NULL, outcome TEXT NOT NULL, command TEXT,
  build_ms INTEGER NOT NULL, check_ms INTEGER, at TEXT NOT NULL, PRIMARY KEY (ticket, run, round)
)`;

export type EnvCheckRow = { readonly run: string; readonly round: number; readonly outcome: EnvCheck['outcome']; readonly command: string | null; readonly buildMs: number; readonly checkMs: number | null; readonly at: string };

// Each check of a ticket, kept: its run, its round in it, and how many of the run's failed.
export class EnvCheckStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(ENV_CHECKS_TABLE);
  }

  // The round this check was, in its run.
  add(ticket: string, project: string, run: string, check: EnvCheck, at: string): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(round), 0) + 1 AS round FROM env_checks WHERE ticket = ? AND run = ?').get(ticket, run) as { round: number };
    this.#db.prepare('INSERT INTO env_checks (ticket, run, round, project, outcome, command, build_ms, check_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticket, run, row.round, project, check.outcome, check.command, Math.round(check.buildMs), check.checkMs === null ? null : Math.round(check.checkMs), at);
    return row.round;
  }

  failures(ticket: string, run: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM env_checks WHERE ticket = ? AND run = ? AND outcome IN ('failed', 'build_failed')").get(ticket, run) as { n: number }).n;
  }

  list(ticket: string): EnvCheckRow[] {
    return (this.#db.prepare('SELECT run, round, outcome, command, build_ms, check_ms, at FROM env_checks WHERE ticket = ? ORDER BY at, round').all(ticket) as
      { run: string; round: number; outcome: EnvCheck['outcome']; command: string | null; build_ms: number; check_ms: number | null; at: string }[])
      .map((row) => ({ run: row.run, round: row.round, outcome: row.outcome, command: row.command, buildMs: row.build_ms, checkMs: row.check_ms, at: row.at }));
  }
}

// ------------------------------------------------------------- the merge

// The merge of an environment ticket builds the prepared image of a service
// that has none yet: fetched first, then ensured. A service that has one is
// built again by preparedAfterMerge, when the merge changed what it holds.
export function environmentAfterMerge(deps: {
  readonly images: PreparedImages;
  readonly services: () => readonly PreparedSource[];
  readonly fetch: (source: PreparedSource) => Promise<void>;
  readonly labels: (ticket: string) => Promise<readonly string[]>;
}): FlowListener {
  return (event) => {
    if (event.type !== 'release_merged') return;
    return (async () => {
      if (!isEnvironmentTicket(await deps.labels(event.ticket).catch(() => []))) return;
      for (const source of deps.services()) {
        if (event.service !== undefined && event.service !== source.service) continue;
        if (readRecord(deps.images.stateDir, source.service)) continue;
        try {
          await deps.fetch(source);
          await deps.images.ensure(source);
        } catch (error) {
          console.error(`cleared-v2: the prepared image of ${source.service} was not built after the environment of pull request #${event.pr} (${firstLine(error)})`);
        }
      }
    })();
  };
}
