#!/usr/bin/env node
// The ports the installation binds or publishes, checked before anything is
// written (serve/install.ts). Issue #112.
//
// Two rules, with no setting to turn them off:
//   - never 80 or 443: they belong to the public proxy of the machine. On
//     2026-10-17 `tailscale serve` held 443 on the Tailscale address, and after
//     a reboot the proxy could not bind 0.0.0.0:443: production was down for
//     six hours;
//   - never a port something else already listens on, on any address of the
//     machine (stricter than the kernel: a holder on one address would still
//     stop a later bind of 0.0.0.0 on that port, as the proxy found). The one
//     holder accepted is this installation's own unit for that port, so that
//     running the installer again changes nothing.
// When the list of listening ports cannot be read, nothing can be proved free:
// the check fails.
//
// The port of lib/ports.sh (docs/v2/milestone-4-plan.md, step c), with the
// same messages. The dashboard's port is no longer checked: the installer no
// longer installs the dashboard (step a).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runAsCommand } from './conf.mjs';

// Where the kernel's tables are read, and the programs that list the sockets
// and tell what tailscale serve publishes. Given by the caller, never read
// from the environment: serve/install.ts takes the defaults, and only the
// tests' own command line (`ports.ts --proc …`) names others.
export type PortsHost = { readonly proc: string; readonly ss: string; readonly tailscale: string };
export const HOST: PortsHost = { proc: '/proc', ss: 'ss', tailscale: 'tailscale' };

export type Listener = { readonly address: string; readonly port: string; readonly pid: string; readonly uid: string; readonly inode: string; readonly name: string };

const say = (text: string): void => { process.stderr.write(`${text}\n`); };

// Whether a program can be run: an absolute path that is an executable file,
// or a name found on the PATH, as `command -v` finds it.
export function onPath(program: string): boolean {
  const usable = (path: string) => { try { return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0; } catch { return false; } };
  if (program.includes('/')) return usable(program);
  return (process.env.PATH ?? '').split(':').filter(Boolean).some((dir) => usable(join(dir, program)));
}

const LISTEN = (table: string): boolean => readFileSync(table, 'utf8').split('\n').slice(1).some((line) => line.trim().split(/\s+/)[3] === '0A');
const readable = (path: string): boolean => { try { readFileSync(path); return true; } catch { return false; } };

// One entry per TCP socket that listens ("-" for what is not known). ss names
// the process only for this account's own sockets; /proc/net/tcp gives the
// account and the inode, not the process. Null, saying why, when neither can
// be read, or when ss prints a line that is no listening socket. Nothing
// printed by ss is "nothing listens" only when the kernel's tables show no
// listener either.
export function listeners(host: PortsHost = HOST): Listener[] | null {
  const tables = [join(host.proc, 'net', 'tcp'), join(host.proc, 'net', 'tcp6')];
  if (onPath(host.ss)) {
    const run = spawnSync(host.ss, ['-ltnHp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\n+$/, '');
    if (run.status !== 0) { say(`ss -ltnHp failed: ${said.split('\n')[0] ?? ''}`); return null; }
    if (said === '') {
      for (const table of tables) {
        if (!existsSync(table)) continue;
        if (!readable(table)) { say(`ss printed nothing, and ${table} cannot be read: the listening ports cannot be proved`); return null; }
        if (LISTEN(table)) { say(`ss printed nothing, but ${table} has listening sockets: the list of listening ports cannot be read`); return null; }
      }
      return [];
    }
    const out: Listener[] = [];
    for (const line of said.split('\n')) {
      const fields = line.trim() === '' ? [] : line.trim().split(/\s+/);
      if (fields.length === 0) continue;
      const local = fields[3];
      const at = local === undefined ? -1 : local.lastIndexOf(':');
      const port = local === undefined || at < 0 ? '' : local.slice(at + 1);
      if (fields.length < 4 || at < 0 || !/^[0-9]+$/.test(port)) { say(`ss printed a line that is no listening socket: ${line}`); return null; }
      const users = /users:\(\("([^"]*)",pid=([0-9]+)/.exec(line);
      out.push({ address: local!.slice(0, at), port, pid: users?.[2] ?? '-', uid: '-', inode: '-', name: users?.[1] ?? '-' });
    }
    return out;
  }
  const out: Listener[] = [];
  let read = false;
  for (const table of tables) {
    if (!existsSync(table)) continue;
    if (!readable(table)) { say(`ss is not installed and ${table} cannot be read`); return null; }
    read = true;
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [hex = '', portHex = ''] = (fields[1] ?? '').split(':');
      const port = String(Number.parseInt(portHex, 16) || 0);
      let address: string;
      if (hex.length === 8) address = [6, 4, 2, 0].map((i) => String(Number.parseInt(hex.slice(i, i + 2), 16))).join('.');
      else address = /^0+$/.test(hex) ? '[::]' : `[${hex}]`;
      out.push({ address, port, pid: '-', uid: fields[7] ?? '-', inode: fields[9] ?? '-', name: '-' });
    }
  }
  if (!read) { say(`ss is not installed and ${host.proc}/net/tcp cannot be read`); return null; }
  return out;
}

// The process of this account holding that socket, by its inode.
export function pidOfInode(inode: string, host: PortsHost = HOST): string | null {
  let pids: string[];
  try { pids = readdirSync(host.proc).filter((name) => /^[0-9]/.test(name)).sort(); } catch { return null; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = readdirSync(join(host.proc, pid, 'fd')).sort(); } catch { continue; }
    for (const fd of fds) {
      try { if (readlinkSync(join(host.proc, pid, 'fd', fd)) === `socket:[${inode}]`) return pid; } catch { /* gone */ }
    }
  }
  return null;
}

// The systemd user unit of this account the process runs in (its cgroup), or
// nothing. A child of the unit's main process counts: `cleared app` starts
// the server as a child.
export function unitOfPid(pid: string, host: PortsHost = HOST): string {
  let text: string;
  try { text = readFileSync(join(host.proc, pid, 'cgroup'), 'utf8'); } catch { return ''; }
  const own = new RegExp(`^[0-9]*:[^:]*:(/.*/user@${process.getuid?.()}\\.service/.*)$`);
  const path = text.split('\n').map((line) => own.exec(line)?.[1]).find((found) => found !== undefined) ?? '';
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.endsWith('.service') ? last : '';
}

// Refuses what is not a port, and 80 and 443.
export function portNumber(what: string, port: string): boolean {
  if (port === '' || /[^0-9]/.test(port) || port.startsWith('0')) { say(`${what} is "${port}", which is not a port number`); return false; }
  if (Number(port) > 65535) { say(`${what} is ${port}, which is not a port number`); return false; }
  if (port === '80' || port === '443') {
    say(`${what} is ${port}: the installation never binds or publishes ports 80 and 443, they belong to the public proxy of this machine (docs/concepts.md, Decisions). Choose another port`);
    return false;
  }
  return true;
}

// The port an http(s) address is reached on, the scheme's own when none is
// written (https://host is 443). The scheme is read in any case, as browsers
// read it (HTTPS://host is 443 too). Null on what is not
// http(s)://host[:port][/path]: another scheme, no host, a user name.
export function originPort(url: string): string | null {
  if (!url.includes('://')) return null;
  const scheme = url.slice(0, url.indexOf('://')).toLowerCase();
  const own = scheme === 'https' ? '443' : scheme === 'http' ? '80' : null;
  if (own === null) return null;
  const rest = url.slice(url.indexOf('://') + 3);
  const hostport = rest.replace(/[/?#].*$/s, '');
  if (/[@\s]/.test(hostport)) return null;
  let host: string;
  let port: string;
  if (/^\[.*\]:/.test(hostport)) { host = hostport.slice(0, hostport.lastIndexOf(']:')); port = hostport.slice(hostport.lastIndexOf(']:') + 2); }
  else if (/^\[.*\]$/.test(hostport)) { host = hostport; port = own; }
  else if ((hostport.match(/:/g) ?? []).length >= 2) return null;
  else if (hostport.includes(':')) { host = hostport.slice(0, hostport.indexOf(':')); port = hostport.slice(hostport.lastIndexOf(':') + 1); }
  else { host = hostport; port = own; }
  if (host === '' || host === '[') return null;
  return port;
}

// Whether the address is https, the scheme read in any case.
export const isHttps = (url: string): boolean => url.includes('://') && url.slice(0, url.indexOf('://')).toLowerCase() === 'https';

function accountName(uid: string): string {
  const run = spawnSync('getent', ['passwd', uid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return (run.stdout ?? '').split(':')[0] ?? '';
}

// Says who holds the port, unless it is only the unit named. False when
// something else holds it.
export function portHeld(list: readonly Listener[], what: string, port: string, ownUnit: string, change: string, host: PortsHost = HOST): boolean {
  let held = false;
  for (const one of list) {
    if (one.port !== port) continue;
    const pid = one.pid !== '-' || one.inode === '-' ? one.pid : (pidOfInode(one.inode, host) ?? '-');
    const unit = pid === '-' ? '' : unitOfPid(pid, host);
    if (ownUnit && unit === ownUnit) continue;
    let who: string;
    if (pid !== '-') who = `${one.name === '-' ? 'a process' : one.name} (pid ${pid}${unit ? `, unit ${unit}` : ''})`;
    else if (one.uid !== '-') who = `a process of ${accountName(one.uid)} (uid ${one.uid})`;
    else who = 'a process of another account';
    // A container or WSL has no user unit in its cgroup: the unit of the running app cannot be recognised then.
    const note = pid !== '-' && !unit ? ' In a container or WSL, where the cgroup names no user unit of this account, the unit that runs the app cannot be recognised: stop that unit first, or pass a free port.' : '';
    say(`${what} is ${port}, and ${one.address}:${port} is already held by ${who} ('sudo ss -ltnp "sport = :${port}"' names it). ${change}.${note}`);
    held = true;
  }
  return !held;
}

// Whether tailscale serve publishes that port, as `tailscale serve status
// --json` says it (a key of its "TCP" object), the JSON parsed, never
// evaluated. 0: it does; 1: it does not; 2: it cannot be told (no
// tailscale, a refusal, an answer that is no such JSON).
export function portServed(port: string, host: PortsHost = HOST): 0 | 1 | 2 {
  if (!onPath(host.tailscale)) return 2;
  const run = spawnSync(host.tailscale, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.status !== 0) return 2;
  let status: unknown;
  try { status = JSON.parse(run.stdout ?? ''); } catch { return 2; }
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 2;
  const tcp = (status as { TCP?: unknown }).TCP;
  if (tcp === undefined || tcp === null) return 1;
  if (typeof tcp !== 'object' || Array.isArray(tcp)) return 2;
  return Object.hasOwn(tcp, port) ? 0 : 1;
}

// Whether an address of this machine is on the tailnet: 100.64.0.0/10, or
// fd7a:115c:a1e0::/48 (as ss writes it, brackets and scope aside).
export function tailnet(address: string): boolean {
  const a = address.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '').toLowerCase();
  return /^(100\.6[4-9]\.|100\.[7-9][0-9]\.|100\.1[01][0-9]\.|100\.12[0-7]\.|fd7a:115c:a1e0:)/.test(a);
}

const comm = (pid: string, host: PortsHost): string => { try { return readFileSync(join(host.proc, pid, 'comm'), 'utf8').split('\n')[0] || '-'; } catch { return '-'; } };

// The port tailscale serve is told to publish is free, or tailscale serve's
// already (a re-run). Accepted holders: a process named tailscaled (ss names
// this account's own, /proc/<pid>/comm the one found by its socket); and, as
// tailscaled runs as root and cannot be named without root, a holder of
// another account on a Tailscale address when `tailscale serve status` lists
// that port. Anything else is refused, named as far as this account can.
export function originHeld(list: readonly Listener[], origin: string, port: string, bind: string, host: PortsHost = HOST): boolean {
  let served: 0 | 1 | 2 | null = null;
  let held = false;
  for (const one of list) {
    if (one.port !== port) continue;
    const pid = one.pid !== '-' || one.inode === '-' ? one.pid : (pidOfInode(one.inode, host) ?? '-');
    const name = one.name === '-' && pid !== '-' ? comm(pid, host) : one.name;
    if (name === 'tailscaled') continue;
    let who: string;
    if (pid !== '-') who = `${name === '-' ? 'a process' : name} (pid ${pid}), which is not tailscaled`;
    else {
      who = `${one.uid !== '-' ? `a process of ${accountName(one.uid)} (uid ${one.uid})` : 'a process of another account'}, which this account cannot name without root`;
      let reason: string;
      if (one.address.replace(/%.*$/, '') === bind || tailnet(one.address)) {
        served ??= portServed(port, host);
        if (served === 0) {
          say(`note: ${one.address}:${port} is held by ${who}; 'tailscale serve status' lists port ${port}, so it is taken as tailscale serve, already publishing there.`);
          continue;
        }
        reason = served === 1 ? `'tailscale serve status' does not list port ${port}, so it is not tailscale serve`
          : `'tailscale serve status' could not be read to show that it is tailscale serve (is tailscale installed, and may this account read it? 'sudo tailscale set --operator=${spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()}' allows it): an unknown holder`;
      } else reason = 'not a Tailscale address, so not tailscale serve';
      who = `${who}; ${reason}`;
    }
    say(`the port of [app] public_origin (${origin}) is ${port}, the port tailscale serve is told to publish, and ${one.address}:${port} is already held by ${who} ('sudo ss -ltnp "sport = :${port}"' names it). Free that port, or choose another one for public_origin (8443 or 10000) and its tailscale serve command (docs/app.md).`);
    held = true;
  }
  return !held;
}

// The values systemd gives these variables from the Environment= lines of
// <directory>/*.conf, read as text and never evaluated: files in the order of
// their names, [Service] only, comments and other keys skipped, quotes and
// backslashes as systemd reads them, an empty Environment= clearing what came
// before, the last assignment winning. A directory that cannot be read has no
// drop-in for this account; a file in it that cannot be read, or a line whose
// quotes do not close, fails (null): what the unit gets cannot be told then.
export function dropinEnv(dir: string, names: readonly string[]): Map<string, string> | null {
  const set = new Map<string, string>();
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return set;
    entries = readdirSync(dir);
  } catch { return set; }
  const files: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.conf')).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const file = join(dir, entry);
    try { if (realpathSync(file) === '/dev/null') continue; } catch { /* a broken link: said below */ }
    let ok = false;
    try { ok = statSync(file).isFile() && readable(file); } catch { ok = false; }
    if (!ok) { say(`${file} cannot be read`); return null; }
    files.push(file);
  }
  let broken = false;
  const words = (s: string): string[] | null => {
    const out: string[] = [];
    let cur = '';
    let quote = '';
    let has = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (quote === '' && (c === ' ' || c === '\t')) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
      has = true;
      if (c === '\\' && quote !== "'" && i < s.length - 1) { i += 1; cur += s[i]; continue; }
      if (quote === '' && (c === '"' || c === "'")) { quote = c; continue; }
      if (quote !== '' && c === quote) { quote = ''; continue; }
      cur += c;
    }
    if (quote !== '') return null;
    if (has) out.push(cur);
    return out;
  };
  for (const file of files) {
    let section = '';
    let pending = '';
    for (const raw of readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')) {
      let line = raw.replace(/\r$/, '');
      if (pending === '' && /^[ \t]*[#;]/.test(line)) continue;
      line = pending + line;
      pending = '';
      if (/\\$/.test(line)) { pending = `${line.slice(0, -1)} `; continue; }
      if (/^[ \t]*\[/.test(line)) { section = line.replace(/^[ \t]+|[ \t]+$/g, ''); continue; }
      if (section !== '[Service]' || !/^[ \t]*Environment[ \t]*=/.test(line)) continue;
      const value = line.replace(/^[ \t]*Environment[ \t]*=[ \t]*/, '').replace(/[ \t]+$/, '');
      if (value === '') { set.clear(); continue; }
      const found = words(value);
      if (found === null) { say(`${file}: a quote does not close: ${line}`); broken = true; continue; }
      for (const word of found) {
        const at = word.indexOf('=');
        if (at < 1) continue;
        const name = word.slice(0, at);
        if (names.includes(name)) set.set(name, word.slice(at + 1));
      }
    }
  }
  return broken ? null : set;
}

// A notification link names an address, never 80 or 443:
// http(s)://host[:port], the scheme read in any case.
export function linkChecked(what: string, address: string): boolean {
  const port = originPort(address);
  if (port === null) say(`${what} is "${address}", which is not an http(s) address with a host (http(s)://host[:port]).`);
  else if (portNumber(`the port of ${what} (${address})`, port)) return true;
  say('  Use the address of [app] public_origin, with its port, for example https://<machine>.<tailnet>.ts.net:8443 (docs/notifications.md)');
  return false;
}

export type InstallPorts = {
  readonly appPort: string;           // CLEARED_APP_PORT, what the app's unit binds
  readonly confPort: string;          // [app] port, what `cleared app` binds without --port
  readonly origin: string;            // [app] public_origin
  readonly link: string;              // CLEARED_NOTIFY_LINK_BASE of this shell
  readonly bind: string;              // the Tailscale address of this machine
  readonly units?: string;            // the systemd user units directory, whose drop-ins set the link
  readonly legacyLink?: string;       // ORCH_NOTIFY_LINK_BASE of this shell
};

// Every port the installation binds, and every port it tells to publish,
// before anything is written; and the notification link, from this shell
// (CLEARED_ and the legacy ORCH_ name) and from the drop-ins of
// cleared-wake.service and cleared-app.service in the units directory. Says
// every problem, then answers false when there is one.
export function installCheck(ports: InstallPorts, host: PortsHost = HOST): boolean {
  const list = listeners(host);
  if (list === null) { say('the listening ports of this machine could not be read, so no port can be proved free'); return false; }
  let failed = false;
  if (!portNumber('the app port (CLEARED_APP_PORT)', ports.appPort)) failed = true;
  else if (!portHeld(list, 'the app port (CLEARED_APP_PORT)', ports.appPort, 'cleared-app.service', 'Nothing of it is touched: run this again with CLEARED_APP_PORT=<a free port> (and the tailscale serve target with it)', host)) failed = true;
  if (ports.confPort && !portNumber("[app] port (what 'cleared app' binds without --port)", ports.confPort)) failed = true;
  if (ports.origin) {
    const port = originPort(ports.origin);
    if (port === null) { say(`[app] public_origin (${ports.origin}) is not an http(s) address`); failed = true; }
    else if (!portNumber(`the port of [app] public_origin (${ports.origin})`, port)) {
      say(`  Publish the app on HTTPS port 8443 (or 10000), never 443, for example: tailscale serve --bg --https=8443 http://127.0.0.1:${ports.appPort}, and set [app] public_origin = https://<machine>.<tailnet>.ts.net:8443 (docs/app.md)`);
      failed = true;
    } else if (isHttps(ports.origin) && port === ports.appPort) {
      // (an http origin is the app itself, on its own port: http://localhost:8788)
      say(`the port of [app] public_origin (${port}) is also the port of the app: tailscale serve publishes the app on a port of its own, for example 8443`);
      failed = true;
    } else if (isHttps(ports.origin) && !originHeld(list, ports.origin, port, ports.bind, host)) failed = true;
  }
  if (ports.link && !linkChecked('CLEARED_NOTIFY_LINK_BASE in this shell', ports.link)) failed = true;
  if (ports.legacyLink && !linkChecked('ORCH_NOTIFY_LINK_BASE in this shell', ports.legacyLink)) failed = true;
  if (ports.units) {
    for (const unit of ['cleared-wake.service', 'cleared-app.service']) {
      const dir = join(ports.units, `${unit}.d`);
      const assigned = dropinEnv(dir, ['CLEARED_NOTIFY_LINK_BASE', 'ORCH_NOTIFY_LINK_BASE']);
      if (assigned === null) {
        say(`the drop-ins of ${unit} (${dir}) could not be read, so the notification link they set cannot be checked: make them readable by this account, or remove the broken one`);
        failed = true;
        continue;
      }
      for (const [variable, value] of assigned) {
        if (value && !linkChecked(`${variable}, set for ${unit} in ${dir}`, value)) failed = true;
      }
    }
  }
  // Not this installation's to undo, but the very state of 2026-10-17: said.
  for (const one of list) {
    if (one.port !== '80' && one.port !== '443') continue;
    if (one.address.replace(/%.*$/, '') !== ports.bind && !tailnet(one.address)) continue;
    const remedy = one.port === '80' ? 'tailscale serve --http=80 off' : `tailscale serve --https=${one.port} off`;
    say(`WARNING: something listens on ${one.address}:${one.port}, a Tailscale address of this machine (tailscale serve on its default port?). It stops a public proxy from binding 0.0.0.0:${one.port} after a reboot: see 'tailscale serve status', and '${remedy}'.`);
  }
  return !failed;
}

// The command that publishes the app on the port of public_origin, already
// checked by installCheck; empty when there is none to publish.
export function serveHint(origin: string, address: string, port: string): string {
  if (!isHttps(origin)) return '';
  const published = originPort(origin);
  return published === null ? '' : `tailscale serve --bg --https=${published} http://${address}:${port}`;
}

// For the tests: `ports.ts [--proc <dir>] [--ss <program>] [--tailscale
// <program>] <listeners | install-check | serve-hint | tailnet> <argument>...`.
if (runAsCommand(import.meta.url)) {
  const args = process.argv.slice(2);
  const host = { ...HOST };
  while (args[0]?.startsWith('--')) {
    const [option, value = ''] = [args.shift()!, args.shift()];
    if (option === '--proc') host.proc = value;
    else if (option === '--ss') host.ss = value;
    else if (option === '--tailscale') host.tailscale = value;
  }
  const [command, ...rest] = args;
  if (command === 'listeners') {
    const list = listeners(host);
    if (list === null) process.exitCode = 1;
    else process.stdout.write(list.map((one) => `${one.address} ${one.port} ${one.pid} ${one.uid} ${one.inode} ${one.name}\n`).join(''));
  } else if (command === 'install-check') {
    const [appPort = '', confPort = '', origin = '', link = '', bind = '', units = '', legacyLink = ''] = rest;
    process.exitCode = installCheck({ appPort, confPort, origin, link, bind, units, legacyLink }, host) ? 0 : 1;
  } else if (command === 'serve-hint') {
    const hint = serveHint(rest[0] ?? '', rest[1] ?? '', rest[2] ?? '');
    if (hint) process.stdout.write(`${hint}\n`);
  } else if (command === 'tailnet') process.exitCode = tailnet(rest[0] ?? '') ? 0 : 1;
  else { process.stderr.write('usage: ports.ts [--proc <dir>] [--ss <program>] [--tailscale <program>] listeners | install-check | serve-hint | tailnet …\n'); process.exitCode = 64; }
}
