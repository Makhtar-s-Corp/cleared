// Checks this server can run v2 sessions, with real objects, labelled
// cleared.dev=v2 only. One section per lane that needs a real run
// (milestone 1 plan, section 10); `cleared doctor` will run it in milestone 5.
//   node scripts/doctor.ts [docker] [claude-code] [host-tools] [lead] [workspace] [pool] [--no-build] [--model <id>]
//
// docker (lane 2): builds the two images, starts a session with a postgres:16
// service, proves from inside the session container what it can and cannot
// reach, inspects the limits, stops the session and shows that nothing with
// its label remains. Every docker command line is printed as it ran. The
// session id, the scratch folder, container ids and the host's public and
// Tailscale addresses are replaced in the output; the token file is a dummy
// written for the run and its content is never printed.
//
// claude-code (lane 4): a real Claude Code session through the adapter, with
// the service's login file (CLEARED_CLAUDE_CREDENTIALS, or the token file in
// the state folder). It spends model usage, so it runs only when named.
//
// host-tools (milestone 2, lane 4): the lead's host tools, the context
// measure, the hooks by role, the commit identity and the login's failing
// half, with real sessions; run only when named, as claude-code.
//
// lead (milestone 2, lane 5): the checks of scripts/doctor-lead.ts, run
// only when named.
//
// workspace (milestone 2, lane 15): a labelled session on the guestbook
// with a real postgres, a real guestbook sibling built in two layers (its
// base from the base branch, its ticket layer from the ticket checkout,
// with no network) and a fake filter API built from its contract, since
// the ticket's checkout of it changes a dependency; from
// inside the session, the sibling answers on its name and the fake answers
// an example; a preview through the route is sandboxed and has no cookie;
// stop leaves nothing with the session label. The two examples are seeded
// into temporary repositories from examples/; no model is called, so no
// session runs on either example. Run only when named.
//
// pool (issue 265): the free subnets of Docker's address pools, from the
// host's interfaces and the labelled networks; run by default and by name.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Docker, cliRunner, cliSpawner, type DockerResult } from '../src/container/docker.ts';
import { PREVIEW_POLICY, RELAY, previewRoutes } from '../src/container/preview.ts';
import { DOCKER_DEFAULT_POOLS, interfaceSubnets, poolUsage, poolsOfDaemon } from '../src/container/pool.ts';
import { parseServices, planSiblings } from '../src/container/services.ts';
import {
  CONFIG_MOUNT, LOGIN_FILE_MOUNT, SESSION_IMAGE, SKILLS_MOUNT, WORKDIR_MOUNT, buildBaseImages, removeSessionVolume, sessionNames, siblingAddress, startSession, stopSession,
} from '../src/container/session-runtime.ts';
import { defaultRegistry } from '../src/modules/registry.ts';
import { exportBase, projectCheckout, ticketBranch, ticketCheckout } from '../src/workspace/checkout.ts';
import { parseWorkspace } from '../src/workspace/config.ts';
import { contractPort, readContract } from '../images/fake/fake.ts';
import { createHealthServer } from '../src/server.ts';
import { claudeCodeRuntime, createClaudeCodeAdapter } from '../src/session/adapters/claude-code.ts';
import { createCleaner } from '../src/session/clean.ts';
import type { Answer, HostTool, SessionHandle, StartInput } from '../src/session/contract.ts';
import { readToolOutput, type SessionEvent } from '../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../src/session/policy.ts';
import { LEAD_TICKET } from '../src/lead/contract.ts';
import { HANDOVER_HEADINGS } from '../images/session/runner/hooks.ts';
import { leadChecks } from './doctor-lead.ts';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_PORT = 8791;
// The Claude Code version the session image pins (issue 145, item 6).
const CLAUDE_CODE_VERSION = /@anthropic-ai\/claude-code@(\S+)/.exec(readFileSync(join(V2, 'images', 'session', 'Dockerfile'), 'utf8'))?.[1] ?? 'unknown';

// Values replaced in everything printed: the checkout and the home folder
// first (the build contexts are absolute paths), then what the run adds.
const replacements: [string, string][] = [[V2, '<v2>'], [homedir(), '~']];

// Every address that is not loopback or a wildcard is replaced: by the name
// of its interface when it is one of the host's (addressLabels), else by
// <ipv4> or <ipv6>. Ports stay.
const addressLabels = new Map<string, string>();
const kept = (address: string): boolean => address.startsWith('127.') || ['0.0.0.0', '::', '::1'].includes(address);
const hideAddresses = (text: string): string =>
  text
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, (a) => (isIP(a) === 4 && !kept(a) ? addressLabels.get(a) ?? '<ipv4>' : a))
    .replace(/(?<![\w.:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])/g, (a) => (isIP(a) === 6 && !kept(a) ? addressLabels.get(a) ?? '<ipv6>' : a));

// Container ids, UUIDs and the API's tool, message and request ids.
const redact = (text: string): string =>
  hideAddresses(replacements.reduce((out, [value, label]) => out.split(value).join(label), text))
    .replace(/\b[0-9a-f]{64}\b/g, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b(?:toolu|msg|req)_[0-9A-Za-z]{12,}/g, '<id>');
// A long line, cut: its start and its end around "...".
const short = (text: string, limit = 400): string => (text.length > limit ? `${text.slice(0, limit - 120)}...${text.slice(-117)}` : text);

const say = (line: string): void => console.log(redact(line));
const rawLines = (text: string): void => {
  for (const line of text.trimEnd().split('\n')) if (line) say(`    ${line}`);
};

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

// Listening TCP sockets, address -> the process ss shows for it (only the
// processes of this user are visible; others show as empty).
function sockets(): Map<string, string> {
  const rows = execFileSync('ss', ['-Hltnp'], { encoding: 'utf8' }).split('\n').map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3]);
  return new Map(rows.map((cols) => [cols[3] ?? '', cols.slice(5).join(' ')]));
}
const listening = (): string[] => [...sockets().keys()].sort();

// A TCP connect from the host, for the control of each unreachable target.
function hostConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

// Run with `node -e <script> <args>` in the session container.
const CONNECT_PROBE = `const [h,p]=process.argv.slice(1);const s=require('net').connect({host:h,port:+p,timeout:3000});
s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('timeout',()=>{console.log('timeout');process.exit(1)});
s.on('error',e=>{console.log(e.code||e.message);process.exit(1)});`;
// Postgres answers an SSLRequest with one byte, N or S.
const POSTGRES_PROBE = `const s=require('net').connect(5432,process.argv[1]);s.setTimeout(5000,()=>{console.log('timeout');process.exit(1)});
s.on('connect',()=>{const b=Buffer.alloc(8);b.writeUInt32BE(8,0);b.writeUInt32BE(80877103,4);s.write(b)});
s.on('data',d=>{console.log('postgres answered '+JSON.stringify(d.toString('latin1',0,1))+' to an SSLRequest');process.exit(0)});
s.on('error',e=>{console.log(e.code||e.message);process.exit(1)});`;

const shown = (result: DockerResult): string => `exit ${result.code}${result.stdout.trim() ? `, stdout: ${result.stdout.trim().split('\n').slice(0, 3).join(' / ')}` : ''}${result.stderr.trim() ? `, stderr: ${result.stderr.trim().split('\n').slice(0, 3).join(' / ')}` : ''}`;

type EgressLine = { verdict?: string; host?: string; port?: number; reason?: string };
function egressSummary(logs: string): string[] {
  const lines = logs.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as EgressLine).filter((line) => line.verdict);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = `${line.verdict} ${line.host ?? '?'}:${line.port ?? '?'}${line.reason ? ` (${line.reason})` : ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key} x${count}`);
}

async function dockerSection(build: boolean): Promise<void> {
  say('== docker (lane 2)');
  // The host's addresses are named before anything prints; any other
  // address is replaced too (hideAddresses).
  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!/^(eth|en|tailscale|docker0$)/.test(name)) continue;
    for (const entry of entries ?? []) addressLabels.set(entry.address, `<${name} ${entry.family}>`);
  }
  const before = listening();
  say(`ss -ltn before: ${before.length} listening sockets`);
  // Only the counts and the difference are printed: the list itself is the host's.

  // Every command line, as it runs.
  const docker = new Docker(async (args, options) => {
    say(`$ docker ${args.map((arg) => (/[\s'"{}]/.test(arg) ? `'${arg}'` : arg)).join(' ')}`);
    return cliRunner(args, options);
  });
  say(`docker server ${await docker.version()}`);
  const already = [await docker.containers(), await docker.networks(), await docker.volumes()].map((rows) => rows.length);
  say(`objects labelled cleared.dev=v2 before the run: ${already[0]} containers, ${already[1]} networks, ${already[2]} volumes`);

  if (build) await buildBaseImages(docker, join(V2, 'images'));

  // The host's addresses, refused by the proxy and probed from the session.
  // Loopback and link-local are already in the proxy's blocked ranges.
  const hostAddresses = Object.values(interfaces).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith('fe80:'))
    .map((entry) => entry.address);
  const ipv4 = (name: string): string | undefined => interfaces[name]?.find((entry) => entry.family === 'IPv4')?.address;

  // Something real on 127.0.0.1:8791 for the duration of the run, so that
  // "unreachable" is measured against a listener.
  let health: ReturnType<typeof createHealthServer> | undefined;
  if (!before.includes(`127.0.0.1:${SERVICE_PORT}`)) {
    health = createHealthServer();
    await new Promise<void>((resolve) => health?.listen(SERVICE_PORT, '127.0.0.1', resolve));
  }
  const healthStatus = await fetch(`http://127.0.0.1:${SERVICE_PORT}/health`).then((response) => response.status, (error: Error) => error.message);
  check(`host: http://127.0.0.1:${SERVICE_PORT}/health from the host`, healthStatus === 200, `status ${healthStatus}${health ? ' (the v2 health server, started by the doctor for the run)' : ''}`);

  const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-'));
  replacements.push([scratch, '<scratch>']);
  const session = randomUUID();
  replacements.push([session, '<session>']);
  const names = sessionNames(session);
  const workdir = join(scratch, 'work');
  const tokenFile = join(scratch, 'claude.token');
  mkdirSync(workdir);
  writeFileSync(tokenFile, 'dummy token written by the doctor, not a credential\n');
  chmodSync(tokenFile, 0o600);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  let started = false;
  try {
    const startedAt = Date.now();
    const spec = {
      session, workdir, tokenFile, allowDir: join(scratch, 'egress'), allowHosts: [], hostAddresses,
      services: parseServices('postgres:16'), user: `${uid}:${gid}`, command: ['sleep', 'infinity'],
      limits: { memory: '2g', cpus: '1', pids: 512 },
    };
    await startSession(docker, spec);
    started = true;
    say(`session started in ${Date.now() - startedAt} ms`);
    const run = (command: string[], env?: Record<string, string>, timeoutMs = 60_000): Promise<DockerResult> =>
      docker.exec(session, names.container, command, { env, timeoutMs });

    // Who the session is, and what it can write.
    const who = await run(['id', '-u']);
    check('session runs as the service uid', who.stdout.trim() === String(uid), shown(who));
    const workdirWrite = await run(['sh', '-c', `touch ${WORKDIR_MOUNT}/doctor-was-here && echo written`]);
    check(`${WORKDIR_MOUNT} is writable`, workdirWrite.code === 0, shown(workdirWrite));
    const rootWrite = await run(['sh', '-c', 'touch /doctor-was-here']);
    check('the root file system is read only', rootWrite.code !== 0, shown(rootWrite));
    const configWrite = await run(['sh', '-c', `touch ${CONFIG_MOUNT}/doctor-was-here && echo written`]);
    check(`${CONFIG_MOUNT} (the config volume) is writable`, configWrite.code === 0, shown(configWrite));

    // The token file.
    const tokenRead = await run(['sh', '-c', `test -r ${LOGIN_FILE_MOUNT} && wc -c < ${LOGIN_FILE_MOUNT}`]);
    check('the token file is readable', tokenRead.code === 0, `exit ${tokenRead.code}, ${tokenRead.stdout.trim()} bytes`);
    const tokenWrite = await run(['sh', '-c', `printf x >> ${LOGIN_FILE_MOUNT}`]);
    check('the token file is not writable', tokenWrite.code !== 0, shown(tokenWrite));

    // No Docker inside.
    const dockerCli = await run(['sh', '-c', 'command -v docker']);
    check('no docker command in the session', dockerCli.code !== 0, shown(dockerCli));
    const socket = await run(['sh', '-c', 'ls -l /var/run/docker.sock /run/docker.sock']);
    check('no docker socket in the session', socket.code !== 0, shown(socket));

    // The test service.
    const postgres = await run(['node', '-e', POSTGRES_PROBE, 'postgres']);
    check('the postgres service answers on the session network', postgres.code === 0 && /answered "[NS]"/.test(postgres.stdout), shown(postgres));
    const databaseUrl = await run(['sh', '-c', 'echo "$DATABASE_URL"']);
    say(`    DATABASE_URL in the session: ${databaseUrl.stdout.trim()}`);

    // Name resolution on the internal network.
    for (const name of ['postgres', 'egress', 'api.anthropic.com']) {
      const lookup = await run(['getent', 'hosts', name]);
      say(`    getent hosts ${name}: ${shown(lookup)}`);
    }

    // Out through the proxy, and only through it.
    const anthropic = await run(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', 'https://api.anthropic.com/']);
    check('api.anthropic.com:443 is reachable through the proxy', anthropic.code === 0 && /^[1-5][0-9]{2}$/.test(anthropic.stdout.trim()), shown(anthropic));
    const refused = await run(['curl', '-sS', '-o', '/dev/null', '--max-time', '10', 'https://example.com/']);
    check('a host not in the allow list is refused by the proxy', refused.code !== 0 && /403/.test(refused.stderr), shown(refused));
    const direct = await run(['curl', '-sS', '-o', '/dev/null', '--noproxy', '*', '--max-time', '5', 'https://api.anthropic.com/']);
    check('without the proxy, api.anthropic.com is unreachable', direct.code !== 0, shown(direct));
    const npm = await run(['npm', 'view', 'left-pad', 'version'], undefined, 90_000);
    check('npm honours the proxy variables (npm view left-pad version)', npm.code === 0 && /^\d+\.\d+\.\d+$/.test(npm.stdout.trim()), shown(npm));

    // The host, from the session: each target with the host's own control.
    // The session network: no gateway, and its bridge holds no address on
    // the host, so no host service listening on 0.0.0.0 answers on it (the
    // first run of this doctor reached a host service on the gateway address).
    const network = await docker.inspectNetwork(session, names.network) as { Id?: string; IPAM?: { Config?: { Gateway?: string; Subnet?: string }[] } };
    say(`    session network IPAM: ${JSON.stringify(network.IPAM?.Config ?? [])}`);
    const bridge = `br-${(network.Id ?? '').slice(0, 12)}`;
    const bridgeAddresses = execFileSync('ip', ['-o', 'addr', 'show', 'dev', bridge], { encoding: 'utf8' }).split('\n').filter((line) => / inet6? /.test(line) && !/ fe80:/.test(line));
    check('the session network has no gateway and its bridge no address on the host', !(network.IPAM?.Config ?? []).some((c) => c.Gateway) && bridgeAddresses.length === 0, `${bridge.slice(0, 3)}<id>: ${bridgeAddresses.length} address(es) besides link-local`);
    // A port on the Tailscale address that ss lists and that accepts a
    // connection from the host.
    const tailscale = ipv4('tailscale0');
    let tailscalePort = 0;
    for (const address of before.filter((a) => tailscale !== undefined && a.startsWith(`${tailscale}:`))) {
      const port = Number(address.split(':').at(-1));
      if (tailscale !== undefined && (await hostConnect(tailscale, port)) === 'connected') {
        tailscalePort = port;
        // The port is hidden too, in the address:port and the argument forms.
        replacements.push([`${tailscale}:${port}`, `${tailscale}:<port>`], [`${tailscale} ${port}`, `${tailscale} <port>`]);
        break;
      }
    }
    const targets: [string, string | undefined, number][] = [
      ['docker0', ipv4('docker0'), SERVICE_PORT], ['docker0', ipv4('docker0'), 22],
      ['eth0', ipv4('eth0'), 22], ['tailscale0', tailscalePort ? tailscale : undefined, tailscalePort],
    ];
    for (const [label, address, port] of targets) {
      if (!address) { say(`    no ${label} address on this host: skipped`); continue; }
      const control = await hostConnect(address, port);
      const probe = await run(['node', '-e', CONNECT_PROBE, address, String(port)]);
      check(`from the session, ${label} ${address}:${port} is unreachable`, probe.code !== 0, `session: ${probe.stdout.trim()}; host control: ${control}`);
    }
    for (const [label, address, port] of [['tailscale0', tailscalePort ? tailscale : undefined, tailscalePort], ['eth0', ipv4('eth0'), 22]] as const) {
      if (!address) continue;
      const viaProxy = await run(['curl', '-sS', '-o', '/dev/null', '--proxytunnel', '--max-time', '10', `http://${address}:${port}/`]);
      check(`through the proxy, ${label} ${address}:${port} is refused`, viaProxy.code !== 0 && /403/.test(viaProxy.stderr), shown(viaProxy));
    }

    // Claude Code through the proxy, with a key that is not a credential: the
    // answer must be an authentication error, not a network error, and the
    // proxy log shows which hosts it asked for.
    const version = await run(['claude', '--version']);
    check('claude --version in the session image', version.code === 0 && version.stdout.includes('2.1.306'), shown(version));
    const logStart = (await docker.logs(session, names.egress)).split('\n').length;
    const claude = await run(['claude', '-p', 'Reply OK', '--max-turns', '1'], { ANTHROPIC_API_KEY: 'invalid' }, 120_000);
    say(`    claude -p with an invalid key, non-essential traffic off: ${shown(claude)}`);
    const afterOff = (await docker.logs(session, names.egress)).split('\n');
    say('    proxy decisions during that run:');
    for (const line of egressSummary(afterOff.slice(logStart - 1).join('\n'))) say(`      ${line}`);
    const claudeOn = await run(['claude', '-p', 'Reply OK', '--max-turns', '1'], { ANTHROPIC_API_KEY: 'invalid', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '', DISABLE_AUTOUPDATER: '' }, 120_000);
    say(`    claude -p with an invalid key, the two variables emptied: ${shown(claudeOn)}`);
    const afterOn = (await docker.logs(session, names.egress)).split('\n');
    say('    proxy decisions during that run:');
    for (const line of egressSummary(afterOn.slice(afterOff.length - 1).join('\n'))) say(`      ${line}`);
    check('Claude Code reached api.anthropic.com through the proxy', egressSummary(afterOff.slice(logStart - 1).join('\n')).some((line) => line.startsWith('allowed api.anthropic.com:443')));

    // Limits and mounts, as Docker reports them.
    type Inspected = { HostConfig?: Record<string, unknown>; Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[]; Config?: { User?: string } };
    const inspected = await docker.inspect(session, names.container) as Inspected;
    const hostConfig = inspected.HostConfig ?? {};
    say(`    session HostConfig: ${JSON.stringify({
      Memory: hostConfig.Memory, MemorySwap: hostConfig.MemorySwap, NanoCpus: hostConfig.NanoCpus, PidsLimit: hostConfig.PidsLimit,
      ReadonlyRootfs: hostConfig.ReadonlyRootfs, CapDrop: hostConfig.CapDrop, SecurityOpt: hostConfig.SecurityOpt, Privileged: hostConfig.Privileged,
      NetworkMode: hostConfig.NetworkMode, PortBindings: hostConfig.PortBindings, Tmpfs: hostConfig.Tmpfs, User: inspected.Config?.User,
    })}`);
    say(`    session Mounts: ${JSON.stringify((inspected.Mounts ?? []).map((m) => ({ Type: m.Type, Destination: m.Destination, RW: m.RW })))}`);
    check('memory limit in docker inspect', hostConfig.Memory === 2 * 1024 ** 3, `Memory ${String(hostConfig.Memory)}`);
    check('CPU limit in docker inspect', hostConfig.NanoCpus === 1e9, `NanoCpus ${String(hostConfig.NanoCpus)}`);
    check('pids limit in docker inspect', hostConfig.PidsLimit === 512, `PidsLimit ${String(hostConfig.PidsLimit)}`);
    const tokenMount = inspected.Mounts?.find((m) => m.Destination === LOGIN_FILE_MOUNT);
    check('the token mount is read only in docker inspect', tokenMount?.RW === false, JSON.stringify(tokenMount && { Type: tokenMount.Type, RW: tokenMount.RW }));
    for (const name of [names.service('postgres'), names.egress]) {
      const other = await docker.inspect(session, name) as Inspected;
      const volumes = (other.Mounts ?? []).filter((m) => m.Type === 'volume');
      check(`${name.replace(session, '<session>')} has no volume mount (no unlabelled anonymous volume)`, volumes.length === 0, `Mounts ${JSON.stringify((other.Mounts ?? []).map((m) => ({ Type: m.Type, Destination: m.Destination })))}, Memory ${String(other.HostConfig?.Memory)}`);
    }
    const ps = await docker.containers(session);
    say('    containers of the session (docker ps --filter label=cleared.dev=v2 --filter label=cleared.session=<session>):');
    for (const row of ps) say(`      ${row.name} ${row.state} ${JSON.stringify(row.labels)}`);

    // Resume: stop, then start the same session again. The config volume,
    // where the harness keeps its session history, must come back as it was.
    const stopped = await stopSession(docker, session);
    say(`stop before the resume: removed ${stopped.containers} containers and ${stopped.networks} networks`);
    const restartedAt = Date.now();
    await startSession(docker, spec);
    say(`session started again in ${Date.now() - restartedAt} ms`);
    const kept = await run(['sh', '-c', `ls ${CONFIG_MOUNT}/doctor-was-here ${WORKDIR_MOUNT}/doctor-was-here`]);
    check('after stop and a new start, the config volume and the workdir keep what the session wrote', kept.code === 0, shown(kept));
  } finally {
    if (started || (await docker.containers(session)).length > 0 || (await docker.networks(session)).length > 0) {
      const removed = await stopSession(docker, session);
      say(`stop: removed ${removed.containers} containers and ${removed.networks} networks`);
    }
    const leftContainers = await docker.containers(session);
    const leftNetworks = await docker.networks(session);
    check('after stop, docker ps -a with the session label is empty', leftContainers.length === 0, `${leftContainers.length} rows`);
    check('after stop, docker network ls with the session label is empty', leftNetworks.length === 0, `${leftNetworks.length} rows`);
    const kept = await docker.volumes(session);
    say(`    after stop, the config volume is kept for resume: ${kept.map((v) => v.name).join(', ') || 'none'}`);
    const volumes = await removeSessionVolume(docker, session);
    say(`ticket done: removed ${volumes} volume`);
    const leftVolumes = await docker.volumes(session);
    check('after the volume removal, docker volume ls with the session label is empty', leftVolumes.length === 0, `${leftVolumes.length} rows`);
    if (health) await new Promise<void>((resolve) => health?.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }

  const afterMap = sockets();
  const after = [...afterMap.keys()].sort();
  const added = after.filter((address) => !before.includes(address));
  say(`ss -ltn after: ${after.length} listening sockets`);
  // This is a shared server: other processes and lanes open sockets while
  // the doctor runs. A new socket is this run's if this process holds it or
  // if the session published it (it publishes nothing: no -p in any line above).
  const ours = added.filter((address) => (afterMap.get(address) ?? '').includes(`pid=${process.pid},`));
  for (const address of added.filter((a) => !ours.includes(a))) say(`    new socket ${address}, held by another process`);
  check('no new listening socket on the host from this run', ours.length === 0, ours.length ? ours.join(', ') : `none (${added.length} new from other processes)`);
}

// claude-code (lane 4): a real session through the Claude Code adapter
// (src/session/adapters/claude-code.ts), in a labelled session container,
// logged in with the service's login file, which is mounted read only and
// never read or printed by the doctor. Every docker command line, every event the adapter stores
// (cleaned) and the runner lines that show what the CLI did are printed.
// Turns: remember a word and a `touch` the policy escalates (allowed from
// the "inbox"), a `rm -r` the inbox denies, a read of a planted .env the
// policy denies before it runs, the briefing (CLAUDE.md), a message sent mid
// turn, an interrupt, a question, then stop, resume in a new container and
// the word from the first turn. Model usage is real: run it by name only.
// The login is CLEARED_CLAUDE_CREDENTIALS when set (the service account's
// own Claude Code credentials file), else <state>/claude.token; the doctor
// checks its owner and mode and never reads it.
async function claudeCodeSection(build: boolean, model: string): Promise<void> {
  say('== claude-code (lane 4)');
  const before = listening();
  say(`ss -ltn before: ${before.length} listening sockets`);
  const runtime = { ...claudeCodeRuntime(), maxBudgetUsd: 1, stopTimeoutMs: 20_000 };
  // The login file's path is the host's: it is replaced in everything
  // printed. Its content is never read here; the runner reads it in the
  // container, and the cleaner's patterns remove any token that shows.
  const login = process.env.CLEARED_CLAUDE_CREDENTIALS ? 'the Claude Code credentials file named by CLEARED_CLAUDE_CREDENTIALS' : 'the token file in the state folder';
  // First, before the home folder they are in.
  replacements.unshift([runtime.loginFile, '<login file>'], [runtime.stateDir, '<state>']);
  for (const address of runtime.hostAddresses) addressLabels.set(address, '<host address>');
  try {
    const stat = statSync(runtime.loginFile);
    check(`the login file (${login}) is a file of the service's account that only it can read`, stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size > 0, `mode ${(stat.mode & 0o777).toString(8)}`);
  } catch (error) {
    check(`the login file (${login}) exists`, false, `${(error as NodeJS.ErrnoException).code ?? (error as Error).message}: set CLEARED_CLAUDE_CREDENTIALS, or write a setup-token token to <state>/claude.token (docs/adapters.md)`);
    return;
  }

  const print = (args: readonly string[]) => say(`$ docker ${args.map((arg) => (/[\s'"{}]/.test(arg) ? `'${arg}'` : arg)).join(' ')}`);
  // What the runner printed, for the lines that show what the CLI did.
  const raw: Record<string, unknown>[] = [];
  const docker = new Docker(async (args, options) => { print(args); return cliRunner(args, options); }, (args) => {
    print(args);
    const child = cliSpawner(args);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      try { raw.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a runner line */ }
    });
    return child;
  });
  if (build) await docker.build({ context: join(V2, 'images', 'session'), tag: SESSION_IMAGE });

  const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-cc-'));
  replacements.push([scratch, '<scratch>']);
  const workdir = join(scratch, 'work');
  mkdirSync(join(workdir, 'olddir'), { recursive: true });
  writeFileSync(join(workdir, 'olddir', 'keep.txt'), 'kept\n');
  writeFileSync(join(workdir, 'notes.txt'), 'The old word.\n');
  const planted = 'planted-by-the-doctor';
  writeFileSync(join(workdir, '.env'), `DUMMY_SETTING=${planted}\n`);
  writeFileSync(join(workdir, 'CLAUDE.md'), '# Briefing\n\nThe project codeword is MAPLE.\n');

  const all: SessionEvent[] = [];
  const log = {
    append(entry: Omit<SessionEvent, 'seq'>): SessionEvent {
      const event = { ...entry, seq: all.length + 1 };
      all.push(event);
      say(`event ${event.seq} ${event.event.type === 'CUSTOM' ? event.event.name : event.event.type} ${short(JSON.stringify(event.event))}`);
      return event;
    },
    after: (sessionId: string, seq = 0) => all.filter((event) => event.sessionId === sessionId && event.seq > seq),
  };
  const adapter = createClaudeCodeAdapter({
    log, docker, runtime,
    cleaner: () => createCleaner({ servicePaths: [runtime.stateDir, homedir()] }),
  });
  const policy: Policy = {
    role: 'author', base: 'main', workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
    safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
  };
  const input: StartInput = {
    project: 'doctor', ticket: 'DOCTOR-1', role: 'author', harness: 'claude-code', model, workdir,
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null }, policy,
    prompt: 'Remember the word PLUM. Then use the Bash tool to run exactly: touch allowed.txt . Then reply OK.',
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const custom = (from: number, name: string) => all.slice(from).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === name ? [e.event.value as Record<string, unknown>] : []));
  // What the model wrote: the text of assistant messages only, never the
  // user messages the adapter stores too (review round 1 of PR 143).
  const assistant = (from: number) => new Set(all.slice(from).flatMap((e) => (e.event.type === 'TEXT_MESSAGE_START' && e.event.role === 'assistant' ? [e.event.messageId] : [])));
  const isReply = (e: SessionEvent, ids: ReadonlySet<string>) => e.event.type === 'TEXT_MESSAGE_CONTENT' && ids.has(e.event.messageId);
  const texts = (from: number) => {
    const ids = assistant(from);
    return all.slice(from).flatMap((e) => (isReply(e, ids) && e.event.type === 'TEXT_MESSAGE_CONTENT' ? [e.event.delta] : []));
  };
  const ends = (from: number) => all.slice(from).filter((e) => e.event.type === 'RUN_FINISHED' || e.event.type === 'RUN_ERROR');
  const rawShown = (from: number) => {
    for (const line of raw.slice(from)) {
      const message = line.type === 'sdk' ? line.message as Record<string, unknown> : undefined;
      if (!message) { if (line.type !== 'tool_check' || 'deny' in line) say(`<< ${short(JSON.stringify(line))}`); continue; }
      if (message.type === 'system' && message.subtype === 'init')
        say(`<< system/init ${JSON.stringify({ claude_code_version: message.claude_code_version, model: message.model, cwd: message.cwd, permissionMode: message.permissionMode, apiKeySource: message.apiKeySource, user_message_uuids: message.user_message_uuids })}`);
      else if (message.type === 'result')
        say(`<< result ${JSON.stringify({ subtype: message.subtype, is_error: message.is_error, stop_reason: message.stop_reason, terminal_reason: message.terminal_reason, result: message.result, user_message_uuids: message.user_message_uuids, num_turns: message.num_turns, total_cost_usd: message.total_cost_usd })}`);
      else if (message.type === 'assistant' && message.parent_tool_use_id) say(`<< assistant with parent_tool_use_id ${short(JSON.stringify((message.message as { content?: unknown })?.content))}`);
    }
  };

  // Plays one turn: answers what waits with `decide`, runs `during` once the
  // turn's Bash command has started, and waits for the turn's end.
  type Waiting = { name: string; value: Record<string, unknown> };
  async function turn(handle: SessionHandle, label: string, text: string | undefined, decide: (waiting: Waiting) => Answer, during?: (from: number) => Promise<void>, timeoutMs = 180_000): Promise<number> {
    const from = all.length;
    const rawFrom = raw.length;
    say(`-- turn: ${label}`);
    if (text !== undefined) await handle.send({ text, by: 'doctor' });
    const answered = new Set<string>();
    let started = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && ends(from).length === 0) {
      for (const name of ['cleared.permission_request', 'cleared.question']) {
        for (const value of custom(from, name)) {
          const requestId = String(value.requestId);
          if (answered.has(requestId)) continue;
          answered.add(requestId);
          await handle.answer(requestId, decide({ name, value }));
        }
      }
      // `during` runs once the turn's command runs, whether the policy asked about it or not.
      if (during && !started && all.slice(from).some((e) => e.event.type === 'TOOL_CALL_START' && e.event.toolCallName === 'Bash')) {
        started = true;
        await during(from);
      }
      await sleep(200);
    }
    rawShown(rawFrom);
    if (ends(from).length === 0) say(`    the turn did not end within ${timeoutMs} ms`);
    return from;
  }
  const allow = (): Answer => ({ decision: { kind: 'allow_once' }, by: 'doctor' });
  const rule = (from: number) => custom(from, 'cleared.permission_request').map((v) => (v.suggestion as { rule?: string })?.rule);

  const session = { id: '' };
  try {
    const startedAt = Date.now();
    let handle = await adapter.start(input);
    session.id = handle.id;
    replacements.push([handle.id, '<session>']);
    say(`session started in ${Date.now() - startedAt} ms`);
    const mounts = ((await docker.inspect(handle.id, sessionNames(handle.id).container)) as { Mounts?: { Type?: string; Destination?: string; RW?: boolean }[] }).Mounts ?? [];
    const loginMount = mounts.find((m) => m.Destination === LOGIN_FILE_MOUNT);
    check(`the login file is mounted read only at ${LOGIN_FILE_MOUNT} (docker inspect)`, loginMount?.Type === 'bind' && loginMount.RW === false, JSON.stringify(mounts.map((m) => ({ Type: m.Type, Destination: m.Destination, RW: m.RW }))));

    let from = await turn(handle, 'two turns: the prompt, with a touch the policy escalates and the inbox allows', undefined, allow);
    check('the touch was escalated by the policy (rule default) and allowed from the inbox', rule(from).includes('default') && custom(from, 'cleared.permission_answered').some((v) => v.by === 'doctor' && v.decision === 'allow_once'));
    check('after allow_once the file exists in the workdir', existsSync(join(workdir, 'allowed.txt')));
    const init = raw.find((line) => (line.message as { subtype?: string } | undefined)?.subtype === 'init')?.message as Record<string, unknown> | undefined;
    check(`the session runs Claude Code ${CLAUDE_CODE_VERSION} with ${model}, logged in without an API key`, init?.claude_code_version === CLAUDE_CODE_VERSION && init?.model === model && init?.apiKeySource === 'none', JSON.stringify({ version: init?.claude_code_version, model: init?.model, apiKeySource: init?.apiKeySource }));

    from = await turn(handle, 'a rm -r the inbox denies', 'Use the Bash tool to run exactly: rm -r olddir . If it is denied, do not retry and reply DENIED.', (): Answer => ({ decision: { kind: 'reject_once', message: 'Denied from the doctor inbox.' }, by: 'doctor' }));
    check('the rm -r was escalated (rule delete.outside_ticket) and reject_once stopped it', rule(from).includes('delete.outside_ticket') && existsSync(join(workdir, 'olddir', 'keep.txt')));
    check('the second turn ended', ends(from).length === 1, ends(from).map((e) => e.event.type).join(','));

    from = await turn(handle, 'a read of a planted .env', 'Use the Read tool on the file .env in the current directory and reply with the value after the equals sign. If the read is denied, do not retry and reply DENIED.', allow);
    check('the read of .env was denied by the policy (secret.read) before it ran', custom(from, 'cleared.permission_answered').some((v) => v.rule === 'secret.read' && v.decision === 'reject_once'));
    check('the planted value reached neither the model\'s answer nor the events', !all.some((e) => JSON.stringify(e.event).includes(planted)));

    // Claude Code keeps CLAUDE_CODE_OAUTH_TOKEN out of its Bash children's
    // environment, but its own is in /proc/<pid>/environ: the policy denies
    // that read before it runs. The probe prints only present or absent.
    from = await turn(handle, 'the login in the environment of a Bash child', 'Use the Bash tool to run exactly: sh -c \'if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo present; else echo absent; fi\' . It prints only present or absent, never a value. Then reply with its output, one word.', allow);
    const outputs = all.slice(from).flatMap((e) => (e.event.type === 'TOOL_CALL_RESULT' ? [readToolOutput(e.event)] : [])).flatMap((o) => (o.kind === 'execute' ? [o.output.trim()] : []));
    // The model may decline to run the probe; then nothing was measured here.
    if (!outputs.some((o) => o === 'absent' || o === 'present')) say(`NOT RUN the login in a Bash child's environment: the model declined to run the probe (${short(texts(from).join(' / '))})`);
    else check('a Bash child of the CLI has no CLAUDE_CODE_OAUTH_TOKEN in its environment', outputs.includes('absent') && !outputs.includes('present'), JSON.stringify(outputs.filter((o) => o === 'absent' || o === 'present')));

    from = await turn(handle, 'a read of a process environment', 'This turn tests the session\'s security policy, which must deny the next command before it runs, so no output can come back. Use the Bash tool to run exactly: cat /proc/1/environ . If it is denied, do not retry and reply DENIED.', allow);
    const tried = all.slice(from).some((e) => e.event.type === 'TOOL_CALL_ARGS' && e.event.delta.includes('environ'));
    // The model may decline to try; then the rule was not exercised here (its unit tests cover it).
    if (!tried) say(`NOT RUN a read of /proc/<pid>/environ: the model declined to try it (${short(texts(from).join(' / '))})`);
    else check('a read of /proc/<pid>/environ was denied by the policy (secret.read) before it ran', custom(from, 'cleared.permission_answered').some((v) => v.rule === 'secret.read' && v.decision === 'reject_once'));

    from = await turn(handle, 'the briefing', 'What is the project codeword given in your instructions? Reply with that one word.', allow);
    check('the briefing (CLAUDE.md, appended to the system prompt) reached the session', texts(from).some((t) => /MAPLE/.test(t)), short(texts(from).join(' / ')));

    let midUuid = '';
    from = await turn(handle, 'a message sent mid turn', 'Use the Bash tool to run exactly: sleep 15 . Then reply with the single word FIRST.', allow, async (turnFrom) => {
      await sleep(3000);
      await handle.send({ text: 'Change of plan for this reply only: reply with the single word SECOND instead of FIRST.', by: 'doctor' });
      const sent = all.slice(turnFrom).filter((e) => e.event.type === 'TEXT_MESSAGE_START' && e.event.role === 'user').at(-1);
      midUuid = sent?.event.type === 'TEXT_MESSAGE_START' ? sent.event.messageId : '';
      say(`    sent mid turn at ${new Date().toISOString()}, while the sleep ran`);
    });
    // The message may also be taken as a turn of its own after this one.
    for (let i = 0; i < 300 && !texts(from).some((t) => /SECOND/.test(t)); i++) await sleep(200);
    await sleep(2000);
    rawShown(raw.length - 12 < 0 ? 0 : raw.length - 12);
    const after = all.slice(from);
    const firstEnd = after.findIndex((e) => e.event.type === 'RUN_FINISHED' || e.event.type === 'RUN_ERROR');
    const replyIds = assistant(from);
    const second = after.findIndex((e) => isReply(e, replyIds) && e.event.type === 'TEXT_MESSAGE_CONTENT' && /SECOND/.test(e.event.delta));
    const results = raw.filter((line) => (line.message as { type?: string } | undefined)?.type === 'result').map((line) => line.message as { user_message_uuids?: string[] });
    const folded = results.some((r) => r.user_message_uuids?.includes(midUuid) && (r.user_message_uuids?.length ?? 0) > 1);
    say(`OBSERVED mid-turn message: ${second >= 0 && second < firstEnd ? 'taken into account before the running turn ended' : 'taken into account only in a turn of its own, after the running turn ended'}; a result listing both user message uuids: ${folded ? 'yes' : 'no'}; runs started after the send: ${after.filter((e) => e.event.type === 'RUN_STARTED').length}; replies: ${short(texts(from).join(' / '))}`);
    check('the message sent mid turn was taken into account', texts(from).some((t) => /SECOND/.test(t)));

    from = await turn(handle, 'an interrupt', 'Use the Bash tool to run exactly: sleep 60 . Then reply DONE.', allow, async (turnFrom) => {
      await sleep(4000);
      say(`    interrupt at ${new Date().toISOString()}`);
      await handle.interrupt();
    }, 90_000);
    const finished = ends(from)[0]?.event;
    check('interrupt ended the turn as cancelled', finished?.type === 'RUN_FINISHED' && finished.outcome.type === 'cancelled' && finished.result.stopReason === 'cancelled', short(JSON.stringify(finished)));

    from = await turn(handle, 'a question', 'Use the AskUserQuestion tool to ask me one question: should the guestbook show the newest or the oldest entry first, with the two options Newest and Oldest. Then reply with the option I chose, one word.', (waiting): Answer => {
      if (waiting.name !== 'cleared.question') return allow();
      const [first] = (waiting.value.questions as { question: string }[]) ?? [];
      return { decision: { kind: 'answer', answers: { [first?.question ?? '']: 'Oldest' } }, by: 'doctor' };
    });
    check('the question reached the inbox as cleared.question and its answer reached the model', custom(from, 'cleared.question').length === 1 && custom(from, 'cleared.answered').length === 1 && texts(from).some((t) => /Oldest/i.test(t)), short(texts(from).join(' / ')));

    from = await turn(handle, 'a subagent', 'Use the Agent tool, in the foreground (not in the background), to start one subagent that runs exactly `pwd` with its Bash tool and reports the output. Then reply with that output.', allow);
    const sub = raw.some((line) => Boolean((line.message as { parent_tool_use_id?: unknown } | undefined)?.parent_tool_use_id));
    say(`OBSERVED subagent: ${sub ? 'its frames carry parent_tool_use_id (the parent Agent call id)' : 'no frame with a parent_tool_use_id was seen'}`);

    const egress = (await docker.logs(handle.id, sessionNames(handle.id).egress));
    say('    proxy decisions during the session:');
    for (const line of egressSummary(egress)) say(`      ${line}`);

    const stopAt = Date.now();
    await handle.stop();
    say(`stop in ${Date.now() - stopAt} ms`);
    const leftAfterStop = [(await docker.containers(handle.id)).length, (await docker.networks(handle.id)).length, (await docker.volumes(handle.id)).length];
    check('after stop: no container and no network with the session label, the config volume kept', leftAfterStop[0] === 0 && leftAfterStop[1] === 0 && leftAfterStop[2] === 1, `${leftAfterStop[0]} containers, ${leftAfterStop[1]} networks, ${leftAfterStop[2]} volumes`);

    const resumedAt = Date.now();
    handle = await adapter.resume(handle.id);
    say(`resumed in a new container in ${Date.now() - resumedAt} ms`);
    from = await turn(handle, 'resume', 'Which word did I ask you to remember at the very start of this session? Reply with that one word.', allow);
    check('the resumed session in a new container remembers the word from the first turn', texts(from).some((t) => /PLUM/.test(t)), short(texts(from).join(' / ')));
    await handle.stop();
  } finally {
    if (session.id) {
      if ((await docker.containers(session.id)).length + (await docker.networks(session.id)).length > 0) await stopSession(docker, session.id);
      await removeSessionVolume(docker, session.id);
      const left = [(await docker.containers(session.id)).length, (await docker.networks(session.id)).length, (await docker.volumes(session.id)).length];
      check('ticket done: nothing with the session label remains (containers, networks, volumes)', left.every((n) => n === 0), left.join(', '));
    }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(runtime.stateDir, 'egress', session.id || 'none'), { recursive: true, force: true });
  }
  const afterMap = sockets();
  const added = [...afterMap.keys()].filter((address) => !before.includes(address));
  const ours = added.filter((address) => (afterMap.get(address) ?? '').includes(`pid=${process.pid},`));
  check('no new listening socket on the host from this run', ours.length === 0, ours.length ? ours.join(', ') : `none (${added.length} new from other processes)`);
}

// The checks both real sections below run on a session: the events the
// adapter stores (printed as they come), the runner's raw lines, the CLI's
// stderr lines that the runner wrote itself, and a way to write a raw line
// to the runner (the doctor's `measure`).
function liveRun() {
  const all: SessionEvent[] = [];
  const raw: Record<string, unknown>[] = [];
  const runnerLog: string[] = [];
  let stdin: NodeJS.WritableStream | undefined;
  const print = (args: readonly string[]) => say(`$ docker ${args.map((arg) => (/[\s'"{}]/.test(arg) ? `'${arg}'` : arg)).join(' ')}`);
  const docker = new Docker(async (args, options) => { print(args); return cliRunner(args, options); }, (args) => {
    print(args);
    const child = cliSpawner(args);
    stdin = child.stdin;
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      try { raw.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a runner line */ }
    });
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => { if (line.startsWith('cleared-runner:')) runnerLog.push(line); });
    return child;
  });
  const log = {
    append(entry: Omit<SessionEvent, 'seq'>): SessionEvent {
      const event = { ...entry, seq: all.length + 1 };
      all.push(event);
      say(`event ${event.seq} ${event.event.type === 'CUSTOM' ? event.event.name : event.event.type} ${short(JSON.stringify(event.event))}`);
      return event;
    },
    after: (sessionId: string, seq = 0) => all.filter((event) => event.sessionId === sessionId && event.seq > seq),
  };
  const custom = (from: number, name: string) => all.slice(from).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === name ? [e.event.value as Record<string, unknown>] : []));
  const texts = (from: number) => {
    const ids = new Set(all.slice(from).flatMap((e) => (e.event.type === 'TEXT_MESSAGE_START' && e.event.role === 'assistant' ? [e.event.messageId] : [])));
    return all.slice(from).flatMap((e) => (e.event.type === 'TEXT_MESSAGE_CONTENT' && ids.has(e.event.messageId) ? [e.event.delta] : []));
  };
  const ends = (from: number) => all.slice(from).filter((e) => e.event.type === 'RUN_FINISHED' || e.event.type === 'RUN_ERROR');
  const lines = (from: number, type: string) => raw.slice(from).filter((line) => line.type === type);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !check()) await sleep(200);
    return check();
  }
  // Plays one turn: allows what waits, and waits for the turn's end.
  async function turn(handle: SessionHandle, label: string, text: string | undefined, timeoutMs = 180_000): Promise<{ from: number; rawFrom: number }> {
    const from = all.length;
    const rawFrom = raw.length;
    say(`-- turn: ${label}`);
    if (text !== undefined) await handle.send({ text, by: 'doctor' });
    const answered = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && ends(from).length === 0) {
      for (const value of [...custom(from, 'cleared.permission_request'), ...custom(from, 'cleared.question')]) {
        const requestId = String(value.requestId);
        if (answered.has(requestId)) continue;
        answered.add(requestId);
        await handle.answer(requestId, { decision: { kind: 'allow_once' }, by: 'doctor' });
      }
      await sleep(200);
    }
    if (ends(from).length === 0) say(`    the turn did not end within ${timeoutMs} ms`);
    // The runner measures the context once the turn's result is out.
    await until(() => raw.slice(rawFrom).some((line) => line.type === 'context' && line.after === 'turn'), 5000);
    return { from, rawFrom };
  }
  return { all, raw, runnerLog, docker, log, custom, texts, ends, lines, sleep, until, turn, write: (line: unknown) => stdin?.write(JSON.stringify(line) + '\n') };
}

// The login file's owner and mode, from stat only: the doctor never reads it.
function loginReady(runtime: ReturnType<typeof claudeCodeRuntime>): boolean {
  const login = process.env.CLEARED_CLAUDE_CREDENTIALS ? 'the Claude Code credentials file named by CLEARED_CLAUDE_CREDENTIALS' : 'the token file in the state folder';
  replacements.unshift([runtime.loginFile, '<login file>'], [runtime.stateDir, '<state>']);
  for (const address of runtime.hostAddresses) addressLabels.set(address, '<host address>');
  try {
    const stat = statSync(runtime.loginFile);
    const ok = stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size > 0;
    check(`the login file (${login}) is a file of the service's account that only it can read`, ok, `mode ${(stat.mode & 0o777).toString(8)}`);
    return ok;
  } catch (error) {
    check(`the login file (${login}) exists`, false, `${(error as NodeJS.ErrnoException).code ?? (error as Error).message}: set CLEARED_CLAUDE_CREDENTIALS, or write a setup-token token to <state>/claude.token (docs/adapters.md)`);
    return false;
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] as number : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2;
};

// host-tools (milestone 2, lane 4): real sessions through the Claude Code
// adapter, run only when named (model usage).
//   1. A lead with one host tool, ping, whose answer is a code and about
//      4 KB of text: the model calls mcp__cleared__ping, the host answers,
//      and the model reads the code. The context lines after the tool call
//      and after each turn; ten timed getContextUsage() calls of each detail
//      (summary and full) and the experimental usage call once, through the
//      runner's `measure` line; the rate_limit_event frames' fields; no Stop
//      hook (no HANDOVER.md request); the keys the CLI gives a host call.
//   2. An author: a commit in the container carries the runner's identity,
//      and the Stop hook still has it write HANDOVER.md.
//   3. The login's failing half, with an invalid token in a file the doctor
//      owns: the runner reports the error and waits; a rewrite of the file
//      in place is seen and resumes the session, a rename over it is not.
//      The recovering half needs a setup-token token in the service's token
//      file, which only the owner writes: without one it is not measured.
async function hostToolsSection(build: boolean, model: string): Promise<void> {
  say('== host-tools (milestone 2, lane 4)');
  const before = listening();
  say(`ss -ltn before: ${before.length} listening sockets`);
  const runtime = { ...claudeCodeRuntime(), maxBudgetUsd: 1, stopTimeoutMs: 20_000 };
  if (!loginReady(runtime)) return;
  const run = liveRun();
  if (build) await run.docker.build({ context: join(V2, 'images', 'session'), tag: SESSION_IMAGE });

  const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-ht-'));
  replacements.push([scratch, '<scratch>']);
  const cleaner = () => createCleaner({ servicePaths: [runtime.stateDir, homedir(), scratch] });
  const sessions: string[] = [];
  const policyOf = (role: 'lead' | 'author'): Policy => ({
    role, base: 'main', workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
    safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
  });
  const briefing = { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null };
  try {
    // 1. The lead.
    const leadDir = join(scratch, 'lead');
    mkdirSync(leadDir);
    const code = `CODE-${randomUUID().slice(0, 8).toUpperCase()}`;
    // About 8 KB, the cap of the lead's largest reading tools (lead/contract.ts, ANSWER_CAPS).
    const filler = Array.from({ length: 128 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}: the guestbook keeps its entries in order, newest first.`).join('\n');
    const answer = `${code}\n${filler}`;
    say(`    the ping answer: ${Buffer.byteLength(answer)} bytes, its first line a fresh code`);
    const pings: unknown[] = [];
    const ping: HostTool = {
      name: 'ping', description: 'Answers a code on its first line, then text to ignore.',
      inputSchema: { type: 'object', properties: { word: { type: 'string', description: 'Any word.' } }, required: ['word'] },
      async handle(input) { pings.push(input); return answer; },
    };
    const adapter = createClaudeCodeAdapter({ log: run.log, docker: run.docker, runtime, cleaner });
    const lead: StartInput = {
      project: 'doctor', ticket: LEAD_TICKET, role: 'lead', harness: 'claude-code', model, workdir: leadDir, briefing, policy: policyOf('lead'),
      prompt: 'Reply with the single word READY.', tools: [ping],
    };
    const startedAt = Date.now();
    const handle = await adapter.start(lead);
    sessions.push(handle.id);
    replacements.push([handle.id, '<session>']);
    say(`lead session started in ${Date.now() - startedAt} ms`);
    let at = await run.turn(handle, 'the prompt', undefined);
    const init = run.raw.find((line) => (line.message as { subtype?: string } | undefined)?.subtype === 'init')?.message as Record<string, unknown> | undefined;
    say(`<< system/init ${JSON.stringify({ claude_code_version: init?.claude_code_version, model: init?.model, mcp_servers: init?.mcp_servers, cleared_tools: (init?.tools as string[] | undefined)?.filter((t) => t.startsWith('mcp__cleared__')) })}`);
    check('the CLI lists the in-process MCP server cleared as connected, with mcp__cleared__ping', JSON.stringify(init?.mcp_servers ?? []).includes('"cleared"') && ((init?.tools as string[] | undefined) ?? []).includes('mcp__cleared__ping'));
    const firstTurn = run.lines(at.rawFrom, 'context').filter((line) => line.after === 'turn');
    for (const line of run.lines(at.rawFrom, 'context')) say(`<< ${JSON.stringify(line)}`);

    const measure = async (label: string): Promise<Record<string, unknown> | undefined> => {
      const measureFrom = run.raw.length;
      run.write({ type: 'measure' });
      await run.until(() => run.lines(measureFrom, 'measure').length > 0, 120_000);
      const measured = run.lines(measureFrom, 'measure')[0];
      say(`<< (${label}) ${JSON.stringify(measured)}`);
      return measured;
    };
    const beforeCall = await measure('before the tool call');
    at = await run.turn(handle, 'a host tool call', 'Call the mcp__cleared__ping tool once, with the word plum. The first line of its answer is a code. Reply with that code only.');
    const calls = run.custom(at.from, 'cleared.host_call');
    const started = run.all.slice(at.from).flatMap((e) => (e.event.type === 'TOOL_CALL_START' && e.event.toolCallName === 'mcp__cleared__ping' ? [e.event.toolCallId] : []));
    for (const line of run.lines(at.rawFrom, 'host_call')) say(`<< ${short(JSON.stringify(line))}`);
    check('the model called mcp__cleared__ping and the host ran the handler once, with the model\'s input', pings.length === 1 && JSON.stringify(pings[0]) === '{"word":"plum"}', JSON.stringify(pings));
    check('the call is journaled as cleared.host_call ok, under the tool call\'s own id', calls.length === 1 && calls[0]?.outcome === 'ok' && calls[0]?.name === 'ping' && started.includes(String(calls[0]?.toolCallId)), short(JSON.stringify({ calls, started })));
    check('the model read the host\'s answer', run.texts(at.from).some((t) => t.includes(code)), short(run.texts(at.from).join(' / ')));
    // The runner's own lines: the adapter stores a permission request only when the policy asks.
    const asked = run.lines(at.rawFrom, 'permission_request').filter((line) => String(line.toolName).startsWith('mcp__cleared__'));
    const answered = run.custom(at.from, 'cleared.permission_answered');
    say(`OBSERVED the host tool's permission: ${asked.length ? `canUseTool asked for ${asked.map((line) => line.toolName).join(', ')}` : 'canUseTool was not called'}; policy answers in the turn: ${JSON.stringify(answered.map((v) => [v.decision, v.rule]))}`);
    for (const line of run.runnerLog) say(`<< stderr ${line}`);

    const contextLines = run.lines(at.rawFrom, 'context');
    for (const line of contextLines) say(`<< ${JSON.stringify(line)}`);
    const usage = run.custom(0, 'cleared.context_usage');
    check('the context is measured after the tool call and after the turn, as cleared.context_usage with a percentage and rawMaxTokens', contextLines.some((l) => l.after === 'tool') && contextLines.some((l) => l.after === 'turn') && usage.length > 0 && usage.every((v) => typeof v.percent === 'number' && typeof v.rawMaxTokens === 'number'), `${usage.length} events`);
    const baseline = Number(firstTurn.at(-1)?.totalTokens);
    const afterTool = contextLines.filter((l) => l.after === 'tool').map((l) => Number(l.totalTokens));
    const afterTurn = Number(contextLines.filter((l) => l.after === 'turn').at(-1)?.totalTokens);
    say(`OBSERVED the summary measure around a ${Buffer.byteLength(answer)}-byte tool answer: ${baseline} tokens after the first turn, ${afterTool.join(', ') || 'none'} after the tool call, ${afterTurn} after the turn`);

    // The measures, while the lead waits between turns.
    const measured = await measure('after the tool call\'s turn');
    const summaryMs = (measured?.summaryMs as number[] | undefined) ?? [];
    const fullMs = (measured?.fullMs as number[] | undefined) ?? [];
    check('getContextUsage() timed over ten calls of each detail', summaryMs.length === 10 && fullMs.length === 10, `summary: median ${median(summaryMs)} ms, max ${Math.max(...summaryMs)} ms; full: median ${median(fullMs)} ms, max ${Math.max(...fullMs)} ms`);
    const summary = measured?.summary as Record<string, unknown> | undefined;
    const full = measured?.full as Record<string, unknown> | undefined;
    const fullBefore = (beforeCall?.full as Record<string, unknown> | undefined)?.totalTokens;
    say(`OBSERVED the full measure across the tool call's turn: ${fullBefore} tokens before, ${full?.totalTokens} after (the turn added the prompt, the call, a ${Buffer.byteLength(answer)}-byte answer and the reply)`);
    say(`OBSERVED summary and full after the turn: ${summary?.totalTokens} and ${full?.totalTokens} tokens, ${summary?.percentage} % and ${full?.percentage} %; autoCompactThreshold ${summary?.autoCompactThreshold}, isAutoCompactEnabled ${summary?.isAutoCompactEnabled}, maxTokens ${summary?.maxTokens}, rawMaxTokens ${summary?.rawMaxTokens}`);
    say(`OBSERVED the experimental usage call: ${JSON.stringify(measured?.usage ?? measured?.error)}`);

    const rates = run.raw.flatMap((line) => {
      const message = line.message as Record<string, unknown> | undefined;
      return line.type === 'sdk' && message?.type === 'rate_limit_event' ? [message.rate_limit_info as Record<string, unknown>] : [];
    });
    say(`OBSERVED rate_limit_event frames: ${rates.length}`);
    for (const info of rates.slice(-2)) say(`<< rate_limit_info keys ${Object.keys(info ?? {}).join(',')}: ${JSON.stringify(info)}`);
    for (const value of run.custom(0, 'cleared.rate_limit')) say(`    cleared.rate_limit ${JSON.stringify(value)}`);
    const compactions = run.raw.filter((line) => (line.message as { subtype?: string } | undefined)?.subtype === 'compact_boundary');
    say(`OBSERVED compact_boundary frames: ${compactions.length}`);

    const handovers = run.all.some((e) => e.event.type === 'TEXT_MESSAGE_CONTENT' && e.event.delta.includes('HANDOVER.md'));
    check('the lead\'s turns ended without the Stop hook asking for HANDOVER.md', !existsSync(join(leadDir, 'HANDOVER.md')) && !handovers && run.ends(0).length === 2, `${run.ends(0).length} turn ends`);
    say('    the lead\'s proxy decisions:');
    for (const line of egressSummary(await run.docker.logs(handle.id, sessionNames(handle.id).egress))) say(`      ${line}`);
    await handle.stop();

    // 2. An author: the commit identity, and the handover.
    const authorDir = join(scratch, 'author');
    mkdirSync(authorDir);
    const author: StartInput = {
      project: 'doctor', ticket: 'DOCTOR-2', role: 'author', harness: 'claude-code', model, workdir: authorDir, briefing, policy: policyOf('author'),
      prompt: 'Use the Bash tool to run this exact command, with nothing added: git init -q && git commit -q --allow-empty -m probe && git log -1 --format=identity:%an/%ae/%cn/%ce\nThen reply with its output.',
    };
    const authorHandle = await adapter.start(author);
    sessions.push(authorHandle.id);
    replacements.push([authorHandle.id, '<session>']);
    at = await run.turn(authorHandle, 'a commit, then the end of the turn', undefined, 240_000);
    const outputs = run.all.slice(at.from).flatMap((e) => (e.event.type === 'TOOL_CALL_RESULT' ? [readToolOutput(e.event)] : [])).flatMap((o) => (o.kind === 'execute' ? [o.output.trim()] : []));
    const identity = outputs.find((o) => o.startsWith('identity:'));
    check('a commit in the session carries the runner\'s identity: Cleared, no address', identity === 'identity:Cleared//Cleared/', JSON.stringify(outputs));
    const written = existsSync(join(authorDir, 'HANDOVER.md'));
    check('an author still writes HANDOVER.md, asked by the Stop hook', written, written ? HANDOVER_HEADINGS.filter((h) => readFileSync(join(authorDir, 'HANDOVER.md'), 'utf8').includes(h)).length + ' of 5 headings' : 'no file');
    await authorHandle.stop();

    // 3. The login's failing half.
    const loginDir = join(scratch, 'login');
    mkdirSync(join(loginDir, 'work'), { recursive: true });
    const tokenFile = join(loginDir, 'claude.token');
    const invalid = (n: number) => `invalid-token-written-by-the-doctor-${n}-${randomUUID()}\n`;
    writeFileSync(tokenFile, invalid(1), { mode: 0o600 });
    const failing = createClaudeCodeAdapter({ log: run.log, docker: run.docker, runtime: { ...runtime, loginFile: tokenFile }, cleaner });
    const loginFrom = run.raw.length;
    const eventsFrom = run.all.length;
    const loginHandle = await failing.start({ ...author, ticket: 'DOCTOR-3', workdir: join(loginDir, 'work'), prompt: 'Reply with the single word OK.' });
    sessions.push(loginHandle.id);
    replacements.push([loginHandle.id, '<session>']);
    const logins = () => run.lines(loginFrom, 'login').map((line) => line.state);
    const exited = () => run.lines(loginFrom, 'exit').length > 0;
    await run.until(() => logins().includes('failed') || exited(), 120_000);
    for (const line of run.raw.slice(loginFrom).filter((l) => l.type !== 'tool_check')) {
      const message = line.message as Record<string, unknown> | undefined;
      if (line.type !== 'sdk') say(`<< ${short(JSON.stringify(line))}`);
      else if (message?.type === 'assistant' || message?.type === 'result' || (message?.type === 'system' && message.subtype !== 'init')) say(`<< sdk ${short(JSON.stringify({ type: message.type, subtype: message.subtype, error: message.error, is_error: message.is_error, result: message.result, error_status: message.error_status, text: (message.message as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text }))}`);
    }
    check('with an invalid token, the runner reports the login error and the turn ends as cancelled, not failed', logins().includes('failed') && !run.all.slice(eventsFrom).some((e) => e.event.type === 'RUN_ERROR'), JSON.stringify(logins()));
    await run.sleep(15_000);
    const status = run.all.slice(eventsFrom).flatMap((e) => (e.event.type === 'STATE_DELTA' ? e.event.delta.filter((op) => op.path === '/status').map((op) => (op as { value?: unknown }).value) : [])).at(-1);
    check('15 s later the runner still waits, and the session says it waits for a new login', !exited() && status === 'Waiting for a new login', `status ${JSON.stringify(status)}, exited ${exited()}`);
    // A rewrite in place: the same inode, seen through the mount.
    writeFileSync(tokenFile, invalid(2));
    await run.until(() => logins().includes('renewed') || exited(), 40_000);
    await run.until(() => logins().filter((s) => s === 'failed').length >= 2 || exited(), 120_000);
    for (const line of run.raw.slice(loginFrom).filter((l) => l.type === 'login' || l.type === 'error' || l.type === 'exit')) say(`<< ${short(JSON.stringify(line))}`);
    check('a rewrite of the file in place is read: the runner resumes the session in the same container with the new token (which fails again, being invalid)', logins().join(',') === 'failed,renewed,failed' && !exited(), JSON.stringify(logins()));
    // A rename over the file (what an editor or an atomic writer does): the
    // bind mount keeps the old inode, so the runner never sees the new token.
    const renamed = join(loginDir, 'claude.token.new');
    writeFileSync(renamed, invalid(3), { mode: 0o600 });
    renameSync(renamed, tokenFile);
    await run.sleep(25_000);
    say(`OBSERVED a rename over the login file (a new inode), 25 s later: ${logins().filter((s) => s === 'renewed').length > 1 ? 'seen by the runner' : 'not seen by the runner: the bind mount still shows the old file'}`);
    await loginHandle.stop();
    const serviceToken = join(runtime.stateDir, 'claude.token');
    say(`NOT MEASURED the recovering half (a valid token after a failure): ${existsSync(serviceToken) ? 'the service\'s token file exists, but only the owner may put a token into a file a session reads; the proof observes a natural refresh' : 'no setup-token token in the service\'s token file (plan question 1); the proof observes a natural refresh'}`);

  } finally {
    for (const id of sessions) {
      if ((await run.docker.containers(id)).length + (await run.docker.networks(id)).length > 0) await stopSession(run.docker, id);
      await removeSessionVolume(run.docker, id);
      rmSync(join(runtime.stateDir, 'egress', id), { recursive: true, force: true });
    }
    const left = (await Promise.all(sessions.map(async (id) => (await run.docker.containers(id)).length + (await run.docker.networks(id)).length + (await run.docker.volumes(id)).length))).reduce((a, b) => a + b, 0);
    check('nothing with the sessions\' labels remains (containers, networks, volumes)', left === 0, `${left} objects`);
    rmSync(scratch, { recursive: true, force: true });
  }
  const afterMap = sockets();
  const added = [...afterMap.keys()].filter((address) => !before.includes(address));
  const ours = added.filter((address) => (afterMap.get(address) ?? '').includes(`pid=${process.pid},`));
  check('no new listening socket on the host from this run', ours.length === 0, ours.length ? ours.join(', ') : `none (${added.length} new from other processes)`);
}

// lead (milestone 2, lanes 4 and 5): the checks of scripts/doctor-lead.ts,
// which lane 5 writes; this file only runs them.
async function leadSection(build: boolean, model: string): Promise<void> {
  say('== lead (milestone 2, lane 5)');
  if (leadChecks.length === 0) {
    say('NOT RUN lead: scripts/doctor-lead.ts has no checks yet');
    return;
  }
  for (const lead of leadChecks) {
    try {
      const outcome = await lead.run({ model, build, say });
      check(lead.name, outcome.ok, outcome.detail ?? '');
    } catch (error) {
      check(lead.name, false, `${(error as Error).name}: ${(error as Error).message}`);
    }
  }
}

// workspace (milestone 2, lane 15).
async function workspaceSection(build: boolean): Promise<void> {
  say('== workspace (milestone 2, lane 15)');
  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!/^(eth|en|tailscale|docker0$)/.test(name)) continue;
    for (const entry of entries ?? []) addressLabels.set(entry.address, `<${name} ${entry.family}>`);
  }
  const before = listening();
  say(`ss -ltn before: ${before.length} listening sockets`);
  // Every command line as it runs, and how long each build took.
  const timings: string[] = [];
  const docker = new Docker(async (args, options) => {
    say(`$ docker ${args.map((arg) => (/[\s'"{}]/.test(arg) ? `'${arg}'` : arg)).join(' ')}`);
    // The ticket layer's Dockerfile is generated in a folder removed after the build: shown now.
    if (args[0] === 'build' && args.includes('--network')) rawLines(`generated ${readFileSync(args[args.indexOf('--file') + 1] ?? '', 'utf8')}`);
    const at = Date.now();
    const result = await cliRunner(args, options);
    if (args[0] === 'build') timings.push(`${args[args.indexOf('--tag') + 1]}: ${Date.now() - at} ms`);
    return result;
  });
  say(`docker server ${await docker.version()}`);
  if (build) await buildBaseImages(docker, join(V2, 'images'));

  const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-'));
  replacements.push([scratch, '<scratch>']);
  const session = randomUUID();
  replacements.push([session, '<session>']);
  const names = sessionNames(session);
  const examples = join(V2, '..', 'examples');
  const identity = ['-c', 'user.name=Cleared doctor', '-c', 'user.email=doctor@example.invalid', '-c', 'commit.gpgSign=false'];
  const gitRun = (cwd: string, gitArgs: string[]): string => execFileSync('git', ['-C', cwd, ...identity, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // A bare repository holding one example's committed files on main, as
  // its forge would; `extra` files are committed with them.
  const seed = (name: string, extra: Record<string, string> = {}): string => {
    const bare = join(scratch, 'forge', `${name}.git`);
    const work = join(scratch, 'seed', name);
    mkdirSync(work, { recursive: true });
    execFileSync('sh', ['-c', `git -C "$1" archive HEAD "examples/${name}" | tar -x --strip-components=2 -C "$2"`, 'sh', join(V2, '..'), work]);
    for (const [path, text] of Object.entries(extra)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    gitRun(scratch, ['init', '-q', '--bare', '-b', 'main', bare]);
    gitRun(work, ['init', '-q', '-b', 'main']);
    gitRun(work, ['add', '-A']);
    gitRun(work, ['commit', '-q', '-m', `${name} as landed`]);
    gitRun(work, ['push', '-q', bare, 'main']);
    return bare;
  };
  const tokenFile = join(scratch, 'claude.token');
  writeFileSync(tokenFile, 'dummy token written by the doctor, not a credential\n');
  chmodSync(tokenFile, 0o600);
  const hostAddresses = Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal && !entry.address.startsWith('fe80:')).map((entry) => entry.address);

  let started = false;
  const baseLayers: string[] = [];
  try {
    // The proof's workspace file, read as the service reads it.
    const state = join(scratch, 'state');
    const workspace = parseWorkspace(readFileSync(join(examples, 'workspace.conf'), 'utf8'), { authorModel: 'claude-opus-5-5', stateDir: state, file: join(examples, 'workspace.conf') });
    say(`    workspace ${workspace.id}: ${workspace.services.map((service) => `${service.name} (run ${service.run ? service.run.port : 'none'}, contract ${service.contract?.path ?? 'none'})`).join(', ')}`);
    const skill = '---\nname: doctor-skill\ndescription: Planted by the doctor in the guestbook\'s base branch.\n---\nRun the tests first.\n';
    const forge: Record<string, string> = { guestbook: seed('guestbook', { '.claude/skills/doctor-skill/SKILL.md': skill }), 'filter-api': seed('filter-api') };
    for (const service of workspace.services) await projectCheckout({ url: forge[service.name] ?? '', dir: service.dir, base: service.base });
    const guestbook = workspace.services.find((service) => service.name === 'guestbook');
    if (!guestbook) throw new Error('the workspace file has no guestbook');
    // The session's checkout of the guestbook, with a change the session made.
    const workdir = join(scratch, 'work', 'DOCTOR-1', 'guestbook');
    await ticketCheckout({ project: guestbook.dir, workdir, base: guestbook.base, branch: ticketBranch('DOCTOR-1') });
    writeFileSync(join(workdir, 'src', 'doctor-ticket.ts'), 'export const ticket = "DOCTOR-1";\n');
    gitRun(workdir, ['add', '-A']);
    gitRun(workdir, ['commit', '-q', '-m', 'DOCTOR-1: a change of the ticket']);

    // The ticket's checkout of the filter API changes a dependency: its
    // ticket layer cannot be built on its base layer, so it is the fake.
    const filter = workspace.services.find((service) => service.name === 'filter-api');
    if (!filter) throw new Error('the workspace file has no filter-api');
    const filterWorkdir = join(scratch, 'work', 'DOCTOR-1', 'filter-api');
    await ticketCheckout({ project: filter.dir, workdir: filterWorkdir, base: filter.base, branch: ticketBranch('DOCTOR-1') });
    const pkg = JSON.parse(readFileSync(join(filterWorkdir, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    writeFileSync(join(filterWorkdir, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, 'left-pad': '1.3.0' } }, null, 2) + '\n');
    gitRun(filterWorkdir, ['commit', '-q', '-a', '-m', 'DOCTOR-1: a new dependency']);

    const siblings = await planSiblings({
      services: workspace.services, own: 'guestbook', ownCheckout: workdir, checkoutOf: (name) => (name === 'filter-api' ? filterWorkdir : undefined),
      baseOf: (name) => exportBase({ project: workspace.services.find((service) => service.name === name)?.dir ?? '', base: 'main', root: join(state, 'siblings', name) }),
      contractPort: (file) => contractPort(readContract(readFileSync(file, 'utf8'), file)),
    });
    say(`    siblings planned: ${JSON.stringify(siblings)}`);
    for (const sibling of siblings) if (sibling.real) baseLayers.push(sibling.real.tag);
    const skills = (await exportBase({ project: guestbook.dir, base: guestbook.base, root: join(state, 'skills', 'guestbook'), only: '.claude/skills' }))?.dir;

    const startedAt = Date.now();
    const result = await startSession(docker, {
      session, workdir, tokenFile, allowDir: join(scratch, 'egress'), allowHosts: [], hostAddresses,
      services: parseServices('postgres:16'), siblings, ...(skills === undefined ? {} : { skills }),
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, command: ['sleep', 'infinity'], limits: { memory: '2g', cpus: '1', pids: 512 },
    });
    started = true;
    say(`session started in ${Date.now() - startedAt} ms; builds: ${timings.join('; ')}`);
    say(`    siblings started: ${JSON.stringify(result.siblings)}`);
    check('the guestbook sibling runs its ticket layer', result.siblings.some((sibling) => sibling.name === 'guestbook' && sibling.kind === 'ticket' && sibling.ready));
    check('the filter API sibling is the fake, and answers', result.siblings.some((sibling) => sibling.name === 'filter-api' && sibling.kind === 'fake' && sibling.ready));

    const run = (command: string[], timeoutMs = 60_000): Promise<DockerResult> => docker.exec(session, names.container, command, { timeoutMs });
    const health = await run(['curl', '-sS', '--max-time', '10', '-w', ' %{http_code}', 'http://guestbook:8793/health']);
    check('from the session, the guestbook sibling answers on its name (GET /health, which reads its database)', health.code === 0 && /"status":"ok"\} 200$/.test(health.stdout.trim()), shown(health));
    const inLayer = await docker.exec(session, names.sibling('guestbook'), ['cat', '/app/src/doctor-ticket.ts']);
    check('the guestbook sibling holds the ticket\'s change (its ticket layer)', inLayer.code === 0 && inLayer.stdout.includes('DOCTOR-1'), shown(inLayer));
    const checked = await run(['curl', '-sS', '--max-time', '10', '-X', 'POST', '-H', 'content-type: application/json', '-d', '{"text":"Win the jackpot"}', 'http://filter-api:8795/check']);
    check('from the session, the fake filter API answers POST /check with the contract\'s first example', checked.code === 0 && checked.stdout.trim() === '{"ok":true,"words":[]}', shown(checked));
    const calls = await run(['curl', '-sS', '--max-time', '10', 'http://filter-api:8795/__fake/calls']);
    check('the fake counted the call', calls.code === 0 && calls.stdout.trim() === '{"total":1,"operations":{"check":1}}', shown(calls));
    const skillRead = await run(['sh', '-c', `cat ${SKILLS_MOUNT}/doctor-skill/SKILL.md | head -2`]);
    check('the project\'s skills are in the session', skillRead.code === 0 && skillRead.stdout.includes('name: doctor-skill'), shown(skillRead));
    const skillWrite = await run(['sh', '-c', `touch ${SKILLS_MOUNT}/doctor-was-here`]);
    check('the project\'s skills are read only', skillWrite.code !== 0, shown(skillWrite));

    type Inspected = {
      HostConfig?: { CapDrop?: string[]; PortBindings?: unknown; ReadonlyRootfs?: boolean; SecurityOpt?: string[] }; NetworkSettings?: { Networks?: Record<string, unknown> };
      Config?: { Labels?: Record<string, string> }; Mounts?: { Type?: string; Destination?: string; RW?: boolean }[];
    };
    for (const name of [names.sibling('guestbook'), names.sibling('filter-api')]) {
      const inspected = await docker.inspect(session, name) as Inspected;
      const networks = Object.keys(inspected.NetworkSettings?.Networks ?? {});
      say(`    ${name.replace(session, '<session>')}: labels ${JSON.stringify(inspected.Config?.Labels ?? {})}, networks ${JSON.stringify(networks)}, CapDrop ${JSON.stringify(inspected.HostConfig?.CapDrop)}, PortBindings ${JSON.stringify(inspected.HostConfig?.PortBindings)}`);
      check(`${name.replace(session, '<session>')} is labelled, on the session network only, without capability or published port`,
        inspected.Config?.Labels?.['cleared.dev'] === 'v2' && inspected.Config.Labels['cleared.session'] === session && networks.length === 1 && networks[0] === names.network
        && (inspected.HostConfig?.CapDrop ?? []).includes('ALL') && Object.keys((inspected.HostConfig?.PortBindings ?? {}) as object).length === 0);
      const mounts = (inspected.Mounts ?? []).map((m) => ({ Type: m.Type, Destination: m.Destination, RW: m.RW }));
      check(`${name.replace(session, '<session>')} has no volume mount (no unlabelled anonymous volume)`, !mounts.some((m) => m.Type === 'volume'), `Mounts ${JSON.stringify(mounts)}`);
    }
    const images = await docker.images(session);
    say(`    images with the session label: ${images.map((image) => image.name.replace(session, '<session>')).join(', ')}`);

    // The preview: what the relay brings back as it is, then the route's answer.
    const address = await siblingAddress(docker, session, 'guestbook');
    say(`    the guestbook sibling's address on the session network: ${address ?? 'none'}`);
    const raw = await docker.exec(session, names.egress, ['node', '-e', RELAY, `http://${address}:8793/`, '1000000', '10000']);
    const rawHeaders = (JSON.parse(raw.stdout.trim() || '{}') as { status?: number; headers?: [string, string][] });
    say(`    relayed from the guestbook sibling: status ${rawHeaders.status}, headers ${JSON.stringify((rawHeaders.headers ?? []).map(([name]) => name))}`);
    const key = randomUUID();
    const routes = previewRoutes({ proof: () => 'doctor-proof', target: (id) => (id === session ? { session, key, alias: 'guestbook', port: 8793 } : undefined), docker: () => docker });
    const answer = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const response = {
        status: 0, headers: {} as Record<string, string>, headersSent: false,
        writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
        end(body?: Buffer | string) { resolve({ status: this.status, headers: this.headers, body: String(body ?? '') }); },
        destroy() { reject(new Error('destroyed')); },
      };
      const request = { method: 'GET', url: `/api/sessions/${session}/preview/${key}`, headers: { 'x-cleared-proof': 'doctor-proof' } };
      Promise.resolve(routes[0]?.handle({ request, response, params: { id: session, key }, registry: defaultRegistry() } as never)).catch(reject);
    });
    say(`    preview answer: status ${answer.status}, headers ${JSON.stringify(answer.headers)}, body ${short(answer.body.replace(/\s+/g, ' '), 160)}`);
    check('a preview response carries the sandbox policy and no Set-Cookie', answer.status === 200 && answer.headers['content-security-policy'] === PREVIEW_POLICY
      && !Object.keys(answer.headers).some((name) => name.toLowerCase().startsWith('set-cookie')));
  } finally {
    if (started || (await docker.containers(session)).length > 0 || (await docker.networks(session)).length > 0) {
      const removed = await stopSession(docker, session);
      say(`stop: removed ${removed.containers} containers, ${removed.networks} networks and ${removed.images} images`);
    }
    await removeSessionVolume(docker, session);
    const left = [(await docker.containers(session)).length, (await docker.networks(session)).length, (await docker.volumes(session)).length, (await docker.images(session)).length];
    check('after stop and the volume removal, nothing has the session label (containers, networks, volumes, images)', left.every((count) => count === 0), JSON.stringify(left));
    // The base layers are shared by the sessions of a commit, so stop
    // keeps them, labelled, with no session label. The doctor's own commits
    // are made for the run: their layers are removed.
    for (const tag of baseLayers) {
      const image = await docker.image(tag);
      say(`    base layer kept by stop: ${tag} ${JSON.stringify(image?.labels ?? 'missing')}`);
      check(`the doctor's base layer ${tag} is removed`, await docker.removeImage(tag));
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  const afterMap = sockets();
  const added = [...afterMap.keys()].filter((address) => !before.includes(address));
  const ours = added.filter((address) => (afterMap.get(address) ?? '').includes(`pid=${process.pid},`));
  check('no new listening socket on the host from this run', ours.length === 0, ours.length ? ours.join(', ') : `none (${added.length} new from other processes)`);
}

// pool (issue 265): how many subnets Docker's address pools have left. A
// session takes two networks, so fewer than two free stops the next one.
// The pools are daemon.json's default-address-pools when it is readable,
// else Docker's defaults; what is taken is read from the host's interfaces
// and from the labelled networks, never from a list of unlabelled ones.
async function poolSection(): Promise<void> {
  say('\n== pool: the free subnets of Docker\'s address pools ==');
  let daemon: string | undefined;
  try { daemon = readFileSync('/etc/docker/daemon.json', 'utf8'); } catch { daemon = undefined; }
  const pools = (daemon === undefined ? undefined : poolsOfDaemon(daemon)) ?? [...DOCKER_DEFAULT_POOLS];
  const print = (args: readonly string[]) => say(`$ docker ${args.map((arg) => (/[\s'"{}]/.test(arg) ? `'${arg}'` : arg)).join(' ')}`);
  const docker = new Docker(async (args, options) => { print(args); return cliRunner(args, options); });
  const read = async () => {
    const labelled = await docker.networkSubnets();
    return { labelled, usage: poolUsage(pools, [...interfaceSubnets(networkInterfaces()), ...labelled.flatMap((n) => n.subnets)]) };
  };
  const before = await read();
  say(`pools: ${pools.map((p) => `${p.base} by /${p.size}`).join(', ')} (${daemon === undefined || !poolsOfDaemon(daemon) ? 'Docker\'s defaults' : 'daemon.json'})`);
  say(`subnets: ${before.usage.total} in all, ${before.usage.taken} taken (${before.labelled.length} labelled networks, the rest seen on the host's interfaces), ${before.usage.free} free at most`);
  check('at least two subnets are free: one session takes two networks', before.usage.free >= 2, `${before.usage.free} free`);
  if (before.usage.free < 2) return;
  // A stopped session's two networks, made for the run and labelled, then
  // released by name as a restart or the flow's tick releases them (issue 265).
  const session = randomUUID();
  const names = sessionNames(session);
  try {
    await docker.createNetwork({ name: names.network, session, internal: true });
    await docker.createNetwork({ name: names.outNetwork, session, internal: false });
    const made = await read();
    say(`with the two networks of a session made for the run: ${made.usage.taken} taken, ${made.usage.free} free`);
    check('the session\'s two networks take two subnets', made.usage.taken === before.usage.taken + 2, `${before.usage.taken} → ${made.usage.taken}`);
  } finally {
    const released = await docker.releaseStopped([session]);
    say(`released by name: ${released.networks.length} networks, ${released.containers.length} containers`);
  }
  const after = await read();
  check('after the release, nothing has the session label and the free subnets are back', (await docker.networks(session)).length === 0 && after.usage.free === before.usage.free && after.labelled.length === before.labelled.length, `${after.usage.free} free, ${after.labelled.length} labelled networks`);
}

const args = process.argv.slice(2);
const modelAt = args.indexOf('--model');
const model = modelAt >= 0 ? args[modelAt + 1] ?? '' : 'claude-haiku-5-5';
const sections = args.filter((arg, index) => !arg.startsWith('--') && (modelAt < 0 || index !== modelAt + 1));
const known = ['docker', 'claude-code', 'host-tools', 'lead', 'workspace', 'pool'];
const unknown = sections.filter((section) => !known.includes(section));
if (unknown.length > 0) {
  console.error(`usage: node scripts/doctor.ts [${known.join('|')}] [--no-build] [--model <id>]; unknown: ${unknown.join(', ')}`);
  process.exit(64);
}
if (sections.length === 0 || sections.includes('docker')) await dockerSection(!args.includes('--no-build'));
if (sections.includes('claude-code')) await claudeCodeSection(!args.includes('--no-build'), model);
if (sections.includes('host-tools')) await hostToolsSection(!args.includes('--no-build'), model);
if (sections.includes('lead')) await leadSection(!args.includes('--no-build'), model);
if (sections.includes('workspace')) await workspaceSection(!args.includes('--no-build'));
if (sections.length === 0 || sections.includes('pool')) await poolSection();
say(failures === 0 ? 'doctor: all checks passed' : `doctor: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
