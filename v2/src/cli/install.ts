// The one command's Node part (docs/v2/milestone-5-plan.md, section 4): what
// `docker compose -f v2/compose.yaml run --rm install` runs, in the install
// container, on the host's network, with the Docker socket, the clone read
// only at CLEARED_V2_CLONE and the state folder at its own path.
//
// In this order, and nothing is written before the checks pass:
//   1. the settings: the three ports (never 80, 443, 8787, 8788 or 8790,
//      each its own) and the state folder, an absolute path;
//   2. Docker and Compose answer;
//   3. what of the project already runs (a list filtered on cleared.dev=v2
//      and the project's name): when the service, the app and the broker
//      all run, nothing else is done but saying the address;
//   4. the owner of the clone, never root: the sessions run as that account;
//   5. the ports the project would bind, with lib/ports.ts, except those of
//      a container of the project that already runs;
//   6. the state folder: made for the owner (mode 700), or one the owner has
//      that others cannot write; an empty one of root's is the folder Docker
//      made for the mount, and is given to the owner;
//   7. the session images, built when missing, then `compose up -d` of the
//      three containers, which builds Cleared's image when it is missing;
//   8. the app's first answer, and the service's last log line that names
//      /setup, which the setup assistant writes with its one-time code.
// Exit 0 when Cleared answers, 64 for a setting refused, 69 when Docker does
// not answer, 1 otherwise. Words: messages/install.<language>.json.
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readdirSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Language } from '../../app/src/catalog.ts';
import type { Translate } from '../../app/web/lib/i18n.ts';
import { lasted } from '../../app/web/lib/time.ts';
import { listeners, type Listener } from '../../../lib/ports.ts';
import { RESERVED_PORTS } from '../config.ts';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../container/session-runtime.ts';
import { CLI_MESSAGES_DIR, cliTranslator, languageOf } from './cleared.ts';

export const INSTALL_MESSAGES_DIR = CLI_MESSAGES_DIR;
export type DockerResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

// What the install reaches outside itself, given by the caller so that the
// tests give fakes: the docker CLI (with the variables Compose reads, and
// whether its output is shown as it comes), the listening ports, the app's
// address, the clone's owner, the clock and the terminal.
export type InstallHost = {
  readonly docker: (args: readonly string[], env?: Readonly<Record<string, string>>, show?: boolean) => Promise<DockerResult>;
  readonly listeners: () => readonly Listener[] | null;
  readonly answers: (url: string) => Promise<boolean>;
  readonly owner: (clone: string) => { readonly uid: number; readonly gid: number } | null;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly say: (line: string) => void;
};

export type InstallSettings = {
  readonly project: string;
  readonly stateDir: string;
  readonly clone: string;
  readonly composeFile: string;
  readonly servicePort: number;
  readonly appPort: number;
  readonly previewPort: number;
  readonly language: Language;
};

export class InstallError extends Error {
  override name = 'InstallError';
  readonly values: Record<string, string>;
  constructor(key: string, values: Record<string, string> = {}) {
    super(key);
    this.values = values;
  }
}

const RUNNING = ['service', 'app', 'broker'] as const;
const IMAGES = [['session', SESSION_IMAGE], ['egress', EGRESS_IMAGE]] as const;
// How long the app may take to answer once Compose has started it.
const WAIT_MS = 3 * 60_000;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new InstallError('settings_port', { name, value: raw });
  const number = Number(raw);
  const reserved = [...RESERVED_PORTS];
  if (RESERVED_PORTS.has(number)) throw new InstallError('settings_reserved', { name, port: raw, reserved: reserved.join(', ') });
  return number;
}

export function readInstallSettings(env: NodeJS.ProcessEnv): InstallSettings {
  const project = env.CLEARED_V2_COMPOSE_PROJECT?.trim() || 'cleared-v2';
  if (!PROJECT_NAME.test(project)) throw new InstallError('settings_project', { value: project });
  const stateDir = env.CLEARED_V2_STATE_DIR?.trim() || '/var/lib/cleared-v2';
  // A colon or a space would split Compose's short mount syntax.
  if (!isAbsolute(stateDir) || resolve(stateDir) !== stateDir || stateDir === '/' || /[:\s]/.test(stateDir)) throw new InstallError('settings_state', { value: stateDir });
  const ports = [['CLEARED_V2_PORT', port(env, 'CLEARED_V2_PORT', 8791)], ['CLEARED_V2_APP_PORT', port(env, 'CLEARED_V2_APP_PORT', 8792)], ['CLEARED_V2_PREVIEW_PORT', port(env, 'CLEARED_V2_PREVIEW_PORT', 8794)]] as const;
  for (const [index, [name, value]] of ports.entries()) {
    const other = ports.slice(0, index).find(([, taken]) => taken === value);
    if (other) throw new InstallError('settings_same', { name: other[0], other: name, port: String(value) });
  }
  const clone = env.CLEARED_V2_CLONE?.trim() || '/opt/cleared/clone';
  return {
    project, stateDir, clone, composeFile: join(clone, 'v2', 'compose.yaml'),
    servicePort: ports[0][1], appPort: ports[1][1], previewPort: ports[2][1], language: languageOf(env),
  };
}

// The service's last log line that names the /setup page, as it wrote it.
export function setupLine(log: string): string | undefined {
  return log.split('\n').map((line) => line.trimEnd()).filter((line) => /\/setup\b/.test(line)).at(-1);
}

const firstLine = (result: DockerResult): string => (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split('\n')[0]!;
const lastLines = (result: DockerResult): string => (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split('\n').slice(-5).join('\n');

const LABEL = 'label=cleared.dev=v2';

// The running containers of the project, by their Compose service.
async function runningOf(settings: InstallSettings, host: InstallHost): Promise<Map<string, string>> {
  const list = await host.docker(['ps', '--filter', LABEL, '--filter', `label=com.docker.compose.project=${settings.project}`, '--format', '{{.ID}} {{.Label "com.docker.compose.service"}}']);
  const running = new Map<string, string>();
  if (list.code !== 0) return running;
  for (const line of list.stdout.split('\n')) {
    const [id, service] = line.trim().split(/\s+/);
    if (id && service) running.set(service, id);
  }
  return running;
}

async function sayAddress(settings: InstallSettings, host: InstallHost, t: Translate, running: ReadonlyMap<string, string>): Promise<void> {
  host.say(t('open_next', { port: String(settings.appPort) }));
  const id = running.get('service');
  if (id === undefined) return;
  const log = await host.docker(['logs', '--tail', '200', '--', id]);
  const line = log.code === 0 ? setupLine(`${log.stdout}\n${log.stderr}`) : undefined;
  if (line !== undefined) host.say(t('setup_said', { line }));
}

// The folder Docker makes for a mount whose source is missing.
function emptyOfRoot(path: string): boolean {
  try { const stats = statSync(path); return stats.isDirectory() && stats.uid === 0 && readdirSync(path).length === 0; } catch { return false; }
}

const mode = (stats: Stats): string => (stats.mode & 0o777).toString(8).padStart(3, '0');

export async function install(env: NodeJS.ProcessEnv, host: InstallHost): Promise<number> {
  const started = host.now();
  const t = cliTranslator('install', languageOf(env));
  let settings: InstallSettings;
  try {
    settings = readInstallSettings(env);
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    host.say(t(error.message, error.values));
    host.say(t('nothing_written'));
    return 64;
  }
  const { project, stateDir } = settings;
  const address = `http://127.0.0.1:${settings.appPort}/`;
  // When the state folder was not there, Docker made it, empty and root's,
  // to mount it in this container, and a mount point cannot be removed from
  // inside: a refusal says so, and the next run takes it as it is.
  // Numbers go in as text: the translator would group a port's digits.
  const refuse = (key: string, values: Record<string, string> = {}, code = 1): number => {
    host.say(t(key, values));
    host.say(t('nothing_written'));
    if (process.getuid?.() === 0 && emptyOfRoot(stateDir)) host.say(t('mount_folder_left', { path: stateDir }));
    return code;
  };

  const version = await host.docker(['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) return refuse('docker_missing', { reason: firstLine(version) }, 69);
  const compose = await host.docker(['compose', 'version', '--short']);
  if (compose.code !== 0) return refuse('compose_missing', { reason: firstLine(compose) }, 69);

  let running = await runningOf(settings, host);
  if (RUNNING.every((service) => running.has(service))) {
    host.say(t('already', { project, address }));
    await sayAddress(settings, host, t, running);
    return 0;
  }

  const owner = host.owner(settings.clone);
  if (owner === null) return refuse('clone_unreadable', { path: settings.clone });
  if (owner.uid === 0) return refuse('clone_root');

  const list = host.listeners();
  if (list === null) return refuse('ports_unreadable');
  const wanted: [string, number][] = [
    ...(running.has('service') ? [] : [['CLEARED_V2_PORT', settings.servicePort] as [string, number]]),
    ...(running.has('app') ? [] : [['CLEARED_V2_APP_PORT', settings.appPort], ['CLEARED_V2_PREVIEW_PORT', settings.previewPort]] as [string, number][]),
  ];
  const held = wanted.flatMap(([name, value]) => list.filter((one) => one.port === String(value)).map((one) => ({ name, port: String(value), address: one.address })));
  if (held.length > 0) {
    for (const one of held.slice(0, -1)) host.say(t('port_held', one));
    return refuse('port_held', held.at(-1)!);
  }

  let stats: Stats | undefined;
  try { stats = statSync(stateDir); } catch { stats = undefined; }
  if (stats === undefined) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (process.getuid?.() === 0) chownSync(stateDir, owner.uid, owner.gid);
  } else if (!stats.isDirectory()) return refuse('state_not_folder', { path: stateDir });
  else if (process.getuid?.() === 0 && emptyOfRoot(stateDir)) {
    chownSync(stateDir, owner.uid, owner.gid);
    chmodSync(stateDir, 0o700);
  } else if (stats.uid !== owner.uid) return refuse('state_other', { path: stateDir, uid: String(stats.uid), owner: String(owner.uid) });
  else if ((stats.mode & 0o022) !== 0) return refuse('state_open', { path: stateDir, mode: mode(stats) });
  host.say(t('state_ready', { path: stateDir, uid: String(owner.uid) }));

  // What Compose reads in compose.yaml, as this command was given it.
  const variables: Record<string, string> = {
    CLEARED_V2_STATE_DIR: stateDir, CLEARED_V2_PORT: String(settings.servicePort), CLEARED_V2_APP_PORT: String(settings.appPort),
    CLEARED_V2_PREVIEW_PORT: String(settings.previewPort), CLEARED_V2_APP_LANGUAGE: settings.language,
    ...(env.CLEARED_V2_PROJECT_DIR?.trim() ? { CLEARED_V2_PROJECT_DIR: env.CLEARED_V2_PROJECT_DIR.trim() } : {}),
  };
  const composeArgs = ['compose', '--project-name', project, '--project-directory', join(settings.clone, 'v2'), '--file', settings.composeFile];
  const missing: string[] = [];
  for (const [service, image] of IMAGES) {
    const found = await host.docker(['image', 'ls', '--filter', LABEL, '--filter', `reference=${image}`, '--quiet']);
    if (found.code !== 0 || found.stdout.trim() === '') missing.push(service);
  }
  if (missing.length > 0) {
    host.say(t('images_build', { names: missing.join(', ') }));
    const built = await host.docker([...composeArgs, 'build', ...missing], variables, true);
    if (built.code !== 0) return failed(host, t, built);
  }
  host.say(t('starting', { project }));
  const up = await host.docker([...composeArgs, 'up', '-d', ...RUNNING], variables, true);
  if (up.code !== 0) return failed(host, t, up);

  const waitFrom = host.now();
  while (!(await host.answers(address))) {
    if (host.now() - waitFrom >= WAIT_MS) {
      host.say(t('no_answer', { address, duration: lasted(WAIT_MS, t), project }));
      return 1;
    }
    await host.sleep(1000);
  }
  host.say(t('answered', { address, duration: lasted(host.now() - started, t) }));
  running = await runningOf(settings, host);
  await sayAddress(settings, host, t, running);
  return 0;
}

function failed(host: InstallHost, t: Translate, result: DockerResult): number {
  host.say(t('start_failed', { reason: lastLines(result) }));
  return 1;
}

// The real host: the docker CLI, lib/ports.ts, the app over loopback.
function dockerCli(args: readonly string[], env: Readonly<Record<string, string>> = {}, show = false): Promise<DockerResult> {
  return new Promise((done) => {
    const child = spawn('docker', [...args], { env: { ...process.env, ...env }, stdio: ['ignore', show ? 'inherit' : 'pipe', show ? 'inherit' : 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 1_000_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => done({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

export const HOST: InstallHost = {
  docker: dockerCli,
  listeners: () => listeners(),
  answers: async (url) => {
    try {
      const answer = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      await answer.body?.cancel();
      return answer.status < 500;
    } catch { return false; }
  },
  owner: (clone) => { try { const stats = statSync(clone); return { uid: stats.uid, gid: stats.gid }; } catch { return null; } },
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
  say: (line) => { process.stdout.write(`${line}\n`); },
};

if (import.meta.main) process.exitCode = await install(process.env, HOST);
