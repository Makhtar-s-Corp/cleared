// Checks this server can run v2 sessions, with real objects, labelled
// cleared.dev=v2 only. One section per lane that needs a real run
// (milestone 1 plan, section 10); `cleared doctor` will run it in milestone 5.
//   node scripts/doctor.ts [docker] [--no-build]
//
// docker (lane 2): builds the two images, starts a session with a postgres:16
// service, proves from inside the session container what it can and cannot
// reach, inspects the limits, stops the session and shows that nothing with
// its label remains. Every docker command line is printed as it ran. The
// session id, the scratch folder, container ids and the host's public and
// Tailscale addresses are replaced in the output; the token file is a dummy
// written for the run and its content is never printed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Docker, cliRunner, type DockerResult } from '../src/container/docker.ts';
import { parseServices } from '../src/container/services.ts';
import {
  CONFIG_MOUNT, LOGIN_FILE_MOUNT, WORKDIR_MOUNT, buildBaseImages, removeSessionVolume, sessionNames, startSession, stopSession,
} from '../src/container/session-runtime.ts';
import { createHealthServer } from '../src/server.ts';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_PORT = 8791;

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

const redact = (text: string): string =>
  hideAddresses(replacements.reduce((out, [value, label]) => out.split(value).join(label), text)).replace(/\b[0-9a-f]{64}\b/g, '<id>');

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
    // first run of this doctor reached sshd on the gateway address).
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
        replacements.push([`:${port}`, ':<port>']);
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

const args = process.argv.slice(2);
const sections = args.filter((arg) => !arg.startsWith('--'));
const known = ['docker'];
const unknown = sections.filter((section) => !known.includes(section));
if (unknown.length > 0) {
  console.error(`usage: node scripts/doctor.ts [${known.join('|')}] [--no-build]; unknown: ${unknown.join(', ')}`);
  process.exit(64);
}
if (sections.length === 0 || sections.includes('docker')) await dockerSection(!args.includes('--no-build'));
say(failures === 0 ? 'doctor: all checks passed' : `doctor: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
