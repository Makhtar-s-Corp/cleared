// The ports of the installation (lib/ports.sh, serve/install.sh; issue #112): never 80 or 443, never a port
// something else listens on, checked before anything is written. On 2026-10-17 `tailscale serve` on its
// default port held 443 on the Tailscale address, and after a reboot the machine's public proxy could not
// bind 0.0.0.0:443: production was down for six hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { scratch } from './support.mjs';

const uid = process.getuid();
const cgroup = (unit, user = uid) => `0::/user.slice/user-${user}.slice/user@${user}.service/app.slice/${unit}\n`;

// The helper, sourced as install.sh sources it, with the listeners and the kernel's tables of the test.
// `serve` is what the fake `tailscale serve status --json` prints (null: no tailscale; false: it is refused).
function ports({ listeners = '', ssFails = false, noSs = false, proc = null, serve = null } = {}) {
  const dir = scratch('orch-ports-');
  const ss = join(dir, 'ss');
  writeFileSync(join(dir, 'listeners'), listeners);
  writeFileSync(ss, ssFails ? '#!/bin/sh\necho "Cannot open netlink socket: Permission denied" >&2\nexit 1\n' : `#!/bin/sh\ncat '${join(dir, 'listeners')}'\n`, { mode: 0o755 });
  const tailscale = join(dir, serve === null ? 'no-such-tailscale' : 'tailscale');
  if (serve !== null) {
    writeFileSync(join(dir, 'serve-status'), serve === false ? '' : serve);
    writeFileSync(tailscale, serve === false ? '#!/bin/sh\necho "access denied: run as root or as the operator" >&2\nexit 1\n'
      : `#!/bin/sh\n[ "$*" = "serve status --json" ] || exit 9\ncat '${join(dir, 'serve-status')}'\n`, { mode: 0o755 });
  }
  const procDir = proc ?? join(dir, 'proc');
  mkdirSync(procDir, { recursive: true });
  // The units directory, where the drop-ins of cleared-wake.service and cleared-app.service are read.
  const units = join(dir, 'units');
  mkdirSync(units);
  const call = (fn, ...args) => spawnSync('bash', ['-c', `set -euo pipefail; . "$1/lib/ports.sh"; ports_ss=$2; ports_proc=$3; ports_tailscale=$4; shift 4; "$@"`, '_',
    ORCH_HOME, noSs ? join(dir, 'no-such-ss') : ss, procDir, tailscale, fn, ...args], { encoding: 'utf8' });
  // dashboard port, app port, [app] port, [app] public_origin, link base, Tailscale address, units directory, legacy link base
  const check = ({ dashboard = '8787', app = '8788', confPort = '8788', origin = '', link = '', bind = '100.64.0.1', legacy = '' } = {}) =>
    call('ports_install_check', dashboard, app, confPort, origin, link, bind, units, legacy);
  // dropIn('cleared-wake.service', 'notify.conf', text): a drop-in of the test.
  const dropIn = (unit, file, text) => {
    mkdirSync(join(units, `${unit}.d`), { recursive: true });
    writeFileSync(join(units, `${unit}.d`, file), text);
    return join(units, `${unit}.d`, file);
  };
  return { dir, procDir, units, call, check, dropIn };
}
const listen = (address, extra = '') => `LISTEN 0      4096   ${address}   0.0.0.0:*   ${extra}\n`;

test('a free port is accepted, on every address of the machine', () => {
  const run = ports({ listeners: listen('0.0.0.0:22') + listen('127.0.0.1:5432') + listen('100.64.0.1:9119') }).check();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('a port something else listens on is refused, whatever the address, naming the port, the holder and what to do', () => {
  const held = ports({ listeners: listen('127.0.0.1:8788') }).check();
  assert.equal(held.status, 1);
  assert.match(held.stderr, /the app port \(CLEARED_APP_PORT\) is 8788, and 127\.0\.0\.1:8788 is already held by a process of another account/);
  assert.match(held.stderr, /sudo ss -ltnp "sport = :8788"/);
  assert.match(held.stderr, /run this again with CLEARED_APP_PORT=<a free port>/);
  // A wildcard holder stops a bind of the Tailscale address on that port, and a holder of one address stops a later wildcard bind.
  for (const address of ['0.0.0.0:8787', '[::]:8787', '*:8787', '100.64.0.1%tailscale0:8787', '127.0.0.1:8787']) {
    const run = ports({ listeners: listen(address) }).check();
    assert.equal(run.status, 1, address);
    assert.match(run.stderr, /the dashboard port \(CLEARED_DASHBOARD_PORT\) is 8787/, address);
  }
  // A process of this account is named, with its unit when it has one.
  const box = ports({ listeners: listen('100.64.0.1:8787', 'users:(("python3",pid=4242,fd=3))') });
  mkdirSync(join(box.procDir, '4242'));
  writeFileSync(join(box.procDir, '4242', 'cgroup'), cgroup('other-site.service'));
  const named = box.check();
  assert.equal(named.status, 1);
  assert.match(named.stderr, /held by python3 \(pid 4242, unit other-site\.service\)/);
});

test('80 and 443 are refused outright: as the ports of the dashboard and the app, of [app] public_origin, of the link, of [app] port', () => {
  const free = ports();
  for (const [what, args, said] of [
    ['dashboard 80', { dashboard: '80' }, /the dashboard port \(CLEARED_DASHBOARD_PORT\) is 80: the installation never binds or publishes ports 80 and 443/],
    ['app 443', { app: '443', confPort: '' }, /the app port \(CLEARED_APP_PORT\) is 443: the installation never/],
    ['[app] port 443', { confPort: '443' }, /\[app\] port .* is 443/],
    ['https origin, no port: 443', { origin: 'https://box.tail1234.ts.net' }, /the port of \[app\] public_origin \(https:\/\/box\.tail1234\.ts\.net\) is 443/],
    ['https origin on 443', { origin: 'https://box.tail1234.ts.net:443/' }, /public_origin .* is 443/],
    ['http origin, no port: 80', { origin: 'http://box.tail1234.ts.net' }, /public_origin .* is 80/],
    ['link base, no port', { origin: 'https://box.tail1234.ts.net:8443', link: 'https://box.tail1234.ts.net' }, /CLEARED_NOTIFY_LINK_BASE .* is 443/],
  ]) {
    const run = free.check(args);
    assert.equal(run.status, 1, what);
    assert.match(run.stderr, said, what);
  }
  // What to do instead is said: an explicit HTTPS port that is not 443.
  assert.match(free.check({ origin: 'https://box.tail1234.ts.net' }).stderr, /tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:8788.*public_origin = https:\/\/<machine>\.<tailnet>\.ts\.net:8443/);
  // Not even when the port is free and nothing else is wrong; and no variable of the installer lets them through.
  const install = readFileSync(join(ORCH_HOME, 'serve', 'install.sh'), 'utf8') + readFileSync(join(ORCH_HOME, 'lib', 'ports.sh'), 'utf8');
  assert.doesNotMatch(install, /CLEARED_[A-Z_]*(ALLOW|SKIP|FORCE)[A-Z_]*PORT|PORT[A-Z_]*(ALLOW|SKIP|FORCE)/);
  // The explicit HTTPS port of the docs is accepted, as is an origin on the app's own machine.
  assert.equal(free.check({ origin: 'https://box.tail1234.ts.net:8443', link: 'https://box.tail1234.ts.net:8443' }).status, 0);
  assert.equal(free.check({ origin: 'http://localhost:8788' }).status, 0, 'an http origin is the app itself, on its own port');
  // Ports that are not ports, and one port for two things, are refused too.
  for (const args of [{ app: '0' }, { app: '65536' }, { app: 'x' }, { dashboard: '8788' }, { origin: 'https://box.tail1234.ts.net:8788' }]) assert.equal(free.check(args).status, 1, JSON.stringify(args));
});

test('a re-run accepts the ports this installation\'s own units hold, each its own, and nothing else', () => {
  const listeners = listen('100.64.0.1:8787', 'users:(("node",pid=4242,fd=20))') + listen('127.0.0.1:8788', 'users:(("node",pid=4343,fd=21))');
  const box = ports({ listeners });
  for (const [pid, unit] of [['4242', 'cleared-dashboard.service'], ['4343', 'cleared-app.service']]) {
    mkdirSync(join(box.procDir, pid));
    writeFileSync(join(box.procDir, pid, 'cgroup'), cgroup(unit));
  }
  const again = box.check({ origin: 'https://box.tail1234.ts.net:8443' });
  assert.equal(again.status, 0, again.stderr);
  // The dashboard's unit does not make the app's port free (the two moved, or something else took it).
  const swapped = box.check({ dashboard: '8788', app: '8787', confPort: '' });
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /8788 is already held by node \(pid 4343, unit cleared-app\.service\)/);
  // The same unit name under another account's systemd is not this installation.
  writeFileSync(join(box.procDir, '4343', 'cgroup'), cgroup('cleared-app.service', uid + 1));
  assert.equal(box.check().status, 1);
});

test('a list of listening ports that cannot be read fails closed', () => {
  const failed = ports({ ssFails: true }).check();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ss -ltnHp failed: Cannot open netlink socket/);
  assert.match(failed.stderr, /could not be read, so no port can be proved free/);
  // No ss, and no table of the kernel either.
  const none = ports({ noSs: true }).check();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /ss is not installed and .*\/net\/tcp cannot be read/);
});

test('without ss, the kernel\'s tables are read: a holder of another account is refused, this installation\'s own unit is found by its socket', () => {
  const box = ports({ noSs: true });
  mkdirSync(join(box.procDir, 'net'));
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  // 127.0.0.1:8788 (0x2254) of uid 1001, and 100.64.0.1:8787 (0x2253) of this account, socket 777; a connection (01) on 443 is not a listener.
  writeFileSync(join(box.procDir, 'net', 'tcp'), header
    + `   0: 0100007F:2254 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 555 1 0 100 0 0 10 0\n`
    + `   1: 01004064:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 777 1 0 100 0 0 10 0\n`
    + `   2: 01004064:01BB 0A000001:C350 01 00000000:00000000 00:00000000 00000000  ${uid}        0 778 1 0 100 0 0 10 0\n`);
  mkdirSync(join(box.procDir, '4242', 'fd'), { recursive: true });
  symlinkSync('socket:[777]', join(box.procDir, '4242', 'fd', '20'));
  writeFileSync(join(box.procDir, '4242', 'cgroup'), cgroup('cleared-dashboard.service'));
  const listed = box.call('ports_listeners');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, '127.0.0.1 8788 - 1001 555 -\n100.64.0.1 8787 - ' + uid + ' 777 -\n');
  const run = box.check();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /127\.0\.0\.1:8788 is already held by a process of .*\(uid 1001\)/);
  assert.doesNotMatch(run.stderr, /8787/, 'the dashboard\'s own socket is accepted');
  assert.equal(box.check({ app: '8790', confPort: '' }).status, 0);
});

test('the tailscale serve command the installer prints publishes on the checked port of public_origin, never on the default one', () => {
  const { call } = ports();
  assert.equal(call('ports_serve_hint', 'https://box.tail1234.ts.net:8443', '127.0.0.1', '8788').stdout, 'tailscale serve --bg --https=8443 http://127.0.0.1:8788\n');
  assert.equal(call('ports_serve_hint', '', '100.64.0.1', '8788').stdout, '');
  assert.equal(call('ports_serve_hint', 'http://localhost:8788', '127.0.0.1', '8788').stdout, '');
  const install = readFileSync(join(ORCH_HOME, 'serve', 'install.sh'), 'utf8');
  assert.doesNotMatch(install, /tailscale serve --bg [0-9]/, 'no serve on the default HTTPS port');
});

// The whole installer, on a machine of the test: a copy of the tool, a project, systemctl and tailscale stand-ins.
function installer({ app = 'bind = 127.0.0.1\nport = 8788\n', listeners = '', serve = '{}' } = {}) {
  const home = scratch('orch-install-ports-');
  const tool = join(home, 'tool');
  const bin = join(home, 'bin');
  const project = join(home, 'project');
  for (const made of [tool, bin, join(project, '.cleared')]) mkdirSync(made, { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'serve'), tool]);
  // The kernel's tables of this machine are not the test's: the copy reads an empty /proc (the fake ss is the listeners).
  const proc = join(home, 'proc');
  mkdirSync(proc);
  writeFileSync(join(tool, 'lib', 'ports.sh'), readFileSync(join(tool, 'lib', 'ports.sh'), 'utf8').replace('\nports_proc=/proc\n', `\nports_proc=${proc}\n`));
  writeFileSync(join(tool, 'dashboard.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(tool, 'serve', 'check.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'tailscale'), `#!/usr/bin/env bash\ncase "$*" in 'serve status --json') cat '${join(home, 'serve-status')}' ;; *) echo 100.64.0.1 ;; esac\n`, { mode: 0o755 });
  writeFileSync(join(home, 'serve-status'), serve);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(home, 'listeners'), listeners);
  writeFileSync(join(bin, 'ss'), `#!/usr/bin/env bash\ncat '${join(home, 'listeners')}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$*" >> '${join(home, 'systemctl-calls')}'\ncase "$*" in *is-enabled*|*is-active*) exit 1 ;; *show*) echo inactive ;; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(project, '.cleared', 'agents.conf'), `[guard]\nsalt = test-salt\nterms = none\nallowed = none\n[app]\n${app}`);
  const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    ORCH_GUARD_REF: 'HEAD', CLEARED_SKIP_HARNESS_PROBE: '1', CLEARED_REPO: project };
  const install = (extra = {}) => spawnSync(join(tool, 'serve', 'install.sh'), [], { env: { ...env, ...extra }, encoding: 'utf8' });
  // Everything the installer writes: the project's name, the state, the units, and what systemd was asked.
  const written = () => ({
    config: existsSync(join(home, 'config')) ? readdirSync(join(home, 'config'), { recursive: true }) : [],
    state: existsSync(join(home, 'state')) ? readdirSync(join(home, 'state'), { recursive: true }) : [],
    units: existsSync(join(home, '.config')) ? readdirSync(join(home, '.config'), { recursive: true }) : [],
    systemd: (existsSync(join(home, 'systemctl-calls')) ? readFileSync(join(home, 'systemctl-calls'), 'utf8') : '').match(/daemon-reload|enable --now|restart/g) ?? [],
  });
  const nothing = { config: [], state: [], units: [], systemd: [] };
  // A drop-in the human wrote before the run (docs/notifications.md), in the units directory of the installer.
  const dropIn = (unit, file, text) => {
    mkdirSync(join(home, '.config', 'systemd', 'user', `${unit}.d`), { recursive: true });
    writeFileSync(join(home, '.config', 'systemd', 'user', `${unit}.d`, file), text);
  };
  return { install, written, nothing, dropIn };
}

test('the installer writes nothing when a port check fails: a held port, 443 as the app\'s port, an https public_origin without its port', () => {
  const held = installer({ listeners: listen('0.0.0.0:8788') });
  const run = held.install();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /the app port \(CLEARED_APP_PORT\) is 8788, and 0\.0\.0\.0:8788 is already held/);
  assert.match(run.stderr, /install\.sh: a port check failed \(above\): nothing was written, no unit was touched/);
  assert.deepEqual(held.written(), held.nothing);

  const proxy = installer();
  const own443 = proxy.install({ CLEARED_APP_PORT: '443' });
  assert.notEqual(own443.status, 0);
  assert.match(own443.stderr, /CLEARED_APP_PORT\) is 443/);
  assert.deepEqual(proxy.written(), proxy.nothing);

  const origin = installer({ app: 'bind = 127.0.0.1\nport = 8788\npublic_origin = https://box.tail1234.ts.net\n' });
  const implicit = origin.install({ CLEARED_NOTIFY_LINK_BASE: 'https://box.tail1234.ts.net:8443' });
  assert.notEqual(implicit.status, 0);
  assert.match(implicit.stderr, /public_origin \(https:\/\/box\.tail1234\.ts\.net\) is 443/);
  assert.deepEqual(origin.written(), origin.nothing);
});

test('the installer goes on when its ports are free and prints the tailscale serve command on the port of public_origin', () => {
  const box = installer({ app: 'bind = 127.0.0.1\nport = 8788\npublic_origin = https://box.tail1234.ts.net:8443\n' });
  const run = box.install({ CLEARED_NOTIFY_LINK_BASE: 'https://box.tail1234.ts.net:8443' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Cleared app: https:\/\/box\.tail1234\.ts\.net:8443\/login, once it is published/m);
  assert.match(run.stdout, /^ {2}tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:8788$/m);
  assert.doesNotMatch(run.stdout + run.stderr, /--https=443|serve --bg 8788/);
  assert.ok(box.written().units.some((name) => name.endsWith('cleared-app.service')));
});

test('ss that prints nothing means nothing listens only when the kernel\'s tables agree; a line that is no listening socket fails closed', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const row = (state) => `   0: 0100007F:2254 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1001        0 555 1 0 100 0 0 10 0\n`;
  // ss says nothing, but this account's table of TCP sockets has a listener (0A): the list cannot be trusted.
  const liar = ports({ listeners: '' });
  mkdirSync(join(liar.procDir, 'net'));
  writeFileSync(join(liar.procDir, 'net', 'tcp'), header + row('0A'));
  const lied = liar.check();
  assert.equal(lied.status, 1);
  assert.match(lied.stderr, /ss printed nothing, but .*net\/tcp has listening sockets/);
  assert.match(lied.stderr, /could not be read, so no port can be proved free/);
  // ss says nothing and the tables have no listener (01 is a connection): nothing listens, and that is accepted.
  const quiet = ports({ listeners: '' });
  mkdirSync(join(quiet.procDir, 'net'));
  writeFileSync(join(quiet.procDir, 'net', 'tcp'), header + row('01'));
  const listed = quiet.call('ports_listeners');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, '');
  assert.equal(quiet.check().status, 0);
  // A line that is no socket of the list (no port, not a port) is an error, the line is named; nothing is skipped.
  for (const bad of ['LISTEN 0 4096 garbage 0.0.0.0:*\n', 'LISTEN 0 4096 0.0.0.0:http 0.0.0.0:*\n', 'LISTEN 0\n']) {
    const run = ports({ listeners: listen('127.0.0.1:8790') + bad }).check();
    assert.equal(run.status, 1, bad);
    assert.match(run.stderr, /ss printed a line that is no listening socket: LISTEN/, bad);
    assert.match(run.stderr, /could not be read, so no port can be proved free/, bad);
  }
});

test('a holder whose cgroup names no user unit (a container, WSL) is refused, and the refusal says to stop that unit or pass a free port', () => {
  const box = ports({ listeners: listen('127.0.0.1:8788', 'users:(("node",pid=4343,fd=21))') });
  mkdirSync(join(box.procDir, '4343'));
  writeFileSync(join(box.procDir, '4343', 'cgroup'), '0::/init.scope\n');
  const run = box.check();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /held by node \(pid 4343\)/);
  assert.match(run.stderr, /In a container or WSL, where the cgroup names no user unit of this account/);
  assert.match(run.stderr, /stop that unit first, or pass a free port/);
});

test('the warning about a tailscale serve on 80 or 443 names the right remedy for its port, and covers the IPv6 tailnet range as well as 100.64.0.0/10', () => {
  const { call } = ports();
  const warned = (listeners) => ports({ listeners }).check({ bind: '100.64.0.1' });
  let run = warned(listen('100.64.0.1:80'));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /WARNING: something listens on 100\.64\.0\.1:80, a Tailscale address .*'tailscale serve --http=80 off'/);
  assert.doesNotMatch(run.stderr, /--https=80/);
  run = warned(listen('[fd7a:115c:a1e0::1]:443'));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /WARNING: something listens on \[fd7a:115c:a1e0::1\]:443, .*'tailscale serve --https=443 off'/);
  run = warned(listen('100.100.1.1:443'));
  assert.match(run.stderr, /WARNING: something listens on 100\.100\.1\.1:443/, 'the middle of 100.64.0.0/10 too');
  // Not a tailnet address, and not 80 or 443: no warning.
  run = warned(listen('192.168.1.5:443') + listen('[2001:db8::1]:80') + listen('[fd7a:115c:a1e0::1]:8443'));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(call('ports_tailnet', '[fd7a:115c:a1e0:0:1::1]').status, 0);
  assert.equal(call('ports_tailnet', '100.128.0.1').status, 1, 'just outside 100.64.0.0/10');
  assert.equal(call('ports_tailnet', '[fd7a:115c:a1e1::1]').status, 1);
});

test('the docs say to publish on 8443 or 10000, never on 443, and the installer says the same', () => {
  const app = readFileSync(join(ORCH_HOME, 'docs', 'app.md'), 'utf8');
  assert.doesNotMatch(app, /HTTPS port that is not 443/);
  assert.match(app, /HTTPS port 8443 \(or 10000[^)]*\), never 443/);
  const run = ports().check({ origin: 'https://box.tail1234.ts.net' });
  assert.match(run.stderr, /Publish the app on HTTPS port 8443 \(or 10000\), never 443, for example: tailscale serve --bg --https=8443/);
});

// The port of [app] public_origin is the one tailscale serve is told to publish: it is checked as in use too, and a
// re-run, where tailscaled holds it already, still passes. tailscaled runs as root: ss names it only to root.
const SERVED_8443 = JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { 'box.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } } });
const ORIGIN = 'https://box.tail1234.ts.net:8443';

test('the port of public_origin held by another process is refused, named, with nothing to accept it', () => {
  const box = ports({ listeners: listen('100.64.0.1:8443', 'users:(("caddy",pid=4545,fd=7))'), serve: SERVED_8443 });
  const run = box.check({ origin: ORIGIN });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /the port of \[app\] public_origin \(https:\/\/box\.tail1234\.ts\.net:8443\) is 8443, the port tailscale serve is told to publish, and 100\.64\.0\.1:8443 is already held by caddy \(pid 4545\), which is not tailscaled/);
  assert.match(run.stderr, /sudo ss -ltnp "sport = :8443"/);
  assert.match(run.stderr, /choose another one for public_origin \(8443 or 10000\)/);
  // A holder of another account off the tailnet is not tailscale serve, whatever its status says.
  const wildcard = ports({ listeners: listen('0.0.0.0:8443'), serve: SERVED_8443 }).check({ origin: ORIGIN });
  assert.equal(wildcard.status, 1);
  assert.match(wildcard.stderr, /0\.0\.0\.0:8443 is already held by a process of another account, which this account cannot name without root; not a Tailscale address, so not tailscale serve/);
  // Found by its socket, without ss: named by /proc/<pid>/comm.
  const proc = ports({ noSs: true });
  mkdirSync(join(proc.procDir, 'net'));
  writeFileSync(join(proc.procDir, 'net', 'tcp'), '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    + `   0: 01004064:20FB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 991 1 0 100 0 0 10 0\n`);
  mkdirSync(join(proc.procDir, '4646', 'fd'), { recursive: true });
  symlinkSync('socket:[991]', join(proc.procDir, '4646', 'fd', '3'));
  writeFileSync(join(proc.procDir, '4646', 'comm'), 'nginx\n');
  const named = proc.check({ origin: ORIGIN });
  assert.equal(named.status, 1);
  assert.match(named.stderr, /100\.64\.0\.1:8443 is already held by nginx \(pid 4646\), which is not tailscaled/);
  // The command the installer prints is never reached then: the check above stops it first (see the installer test).
  writeFileSync(join(proc.procDir, '4646', 'comm'), 'tailscaled\n');
  assert.equal(proc.check({ origin: ORIGIN }).status, 0, 'the same socket, held by tailscaled, is accepted');
});

test('a re-run accepts the port of public_origin when tailscaled holds it: named by ss, or of another account on the tailnet and listed by tailscale serve status', () => {
  const own = ports({ listeners: listen('100.64.0.1:8443', 'users:(("tailscaled",pid=951,fd=40))') }).check({ origin: ORIGIN });
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.stderr, '');
  // As on a real machine: tailscaled is root's, ss names no process; serve status lists the port. v4 and v6 tailnet addresses.
  const rootHeld = listen('100.64.0.1:8443') + listen('[fd7a:115c:a1e0::eb2c:b102]:8443');
  const served = ports({ listeners: rootHeld, serve: SERVED_8443 }).check({ origin: ORIGIN });
  assert.equal(served.status, 0, served.stderr);
  assert.match(served.stderr, /note: 100\.64\.0\.1:8443 is held by a process of another account, which this account cannot name without root; 'tailscale serve status' lists port 8443, so it is taken as tailscale serve/);
  assert.equal(ports({ listeners: rootHeld, serve: SERVED_8443 }).call('ports_serve_hint', 'HTTPS://box.tail1234.ts.net:8443', '127.0.0.1', '8788').stdout,
    'tailscale serve --bg --https=8443 http://127.0.0.1:8788\n', 'the scheme is read in any case');
});

test('an unnameable holder of the port of public_origin is refused, with the sudo ss hint, unless tailscale serve status lists that port', () => {
  const held = listen('100.64.0.1:8443');
  for (const [what, serve, said] of [
    ['no tailscale', null, /could not be read to show that it is tailscale serve: an unknown holder/],
    ['tailscale refuses', false, /could not be read to show that it is tailscale serve: an unknown holder/],
    ['not JSON', 'https://box.tail1234.ts.net:8443 (tailnet only)\n', /an unknown holder/],
    ['TCP not an object', '{"TCP": [8443]}', /an unknown holder/],
    ['another port served', JSON.stringify({ TCP: { 10000: { HTTPS: true } } }), /'tailscale serve status' does not list port 8443, so it is not tailscale serve/],
    ['nothing served', '{}', /does not list port 8443/],
  ]) {
    const run = ports({ listeners: held, serve }).check({ origin: ORIGIN });
    assert.equal(run.status, 1, what);
    assert.match(run.stderr, /100\.64\.0\.1:8443 is already held by a process of another account, which this account cannot name without root/, what);
    assert.match(run.stderr, said, what);
    assert.match(run.stderr, /'sudo ss -ltnp "sport = :8443"' names it/, what);
  }
  // A key that only looks like the port, in the Web part, is not the port served.
  const lookalike = ports({ listeners: held, serve: JSON.stringify({ Web: { 'box.tail1234.ts.net:8443': {} } }) }).check({ origin: ORIGIN });
  assert.equal(lookalike.status, 1);
});

test('the notification link of the drop-ins of cleared-wake and cleared-app is checked: 80/443 and what is no http(s) address are refused', () => {
  const service = (lines) => `[Service]\n${lines}\n`;
  const refused = (box, said, what) => {
    const run = box.check({ origin: ORIGIN });
    assert.equal(run.status, 1, what);
    assert.match(run.stderr, said, what);
    return run;
  };
  let box = ports();
  box.dropIn('cleared-wake.service', 'notify.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=HTTPS://box.tail1234.ts.net'));
  const upper = refused(box, /the port of CLEARED_NOTIFY_LINK_BASE, set for cleared-wake\.service in .*cleared-wake\.service\.d \(HTTPS:\/\/box\.tail1234\.ts\.net\) is 443/, 'an uppercase scheme, implicit 443');
  assert.match(upper.stderr, /Use the address of \[app\] public_origin, with its port/);
  box = ports();
  box.dropIn('cleared-wake.service', 'notify.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:8443\nEnvironment=CLEARED_NOTIFY_PUSH_HOSTS=push.example.org'));
  box.dropIn('cleared-app.service', 'notify.conf', service('Environment=CLEARED_NOTIFY_PUSH_HOSTS=push.example.org'));
  assert.equal(box.check({ origin: ORIGIN }).status, 0, 'the drop-in of docs/notifications.md, on 8443');
  // The legacy name, in the app's drop-in, and in this shell.
  box = ports();
  box.dropIn('cleared-app.service', 'old.conf', service('Environment="ORCH_NOTIFY_LINK_BASE=http://box.tail1234.ts.net"'));
  refused(box, /the port of ORCH_NOTIFY_LINK_BASE, set for cleared-app\.service in .* is 80/, 'ORCH_ in a drop-in');
  const shell = ports().check({ origin: ORIGIN, legacy: 'https://box.tail1234.ts.net' });
  assert.equal(shell.status, 1);
  assert.match(shell.stderr, /the port of ORCH_NOTIFY_LINK_BASE in this shell .* is 443/);
  // Not an http(s) address with a host: refused, not ignored (it was a silent "no link", and an implicit 443 went by).
  for (const value of ['ftp://box.tail1234.ts.net:8443', 'box.tail1234.ts.net:8443', 'https://', 'https://me@box.tail1234.ts.net:8443']) {
    box = ports();
    box.dropIn('cleared-wake.service', 'notify.conf', service(`Environment=CLEARED_NOTIFY_LINK_BASE=${value}`));
    refused(box, /CLEARED_NOTIFY_LINK_BASE, set for cleared-wake\.service in .* is ".*", which is not an http\(s\) address with a host/, value);
  }
  assert.match(ports().check({ origin: ORIGIN, link: 'HTTPS://box.tail1234.ts.net' }).stderr, /CLEARED_NOTIFY_LINK_BASE in this shell .* is 443/);
  assert.match(ports().check({ origin: ORIGIN, link: 'mailto:me@example.org' }).stderr, /not an http\(s\) address with a host/);
});

test('the drop-ins are read as systemd reads them, never evaluated: the last assignment wins, comments and other sections are skipped', () => {
  const service = (lines) => `[Service]\n${lines}\n`;
  // Files in the order of their names: 20- comes after 10-, whatever was written first.
  let box = ports();
  box.dropIn('cleared-wake.service', '20-port.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:8443'));
  box.dropIn('cleared-wake.service', '10-old.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net'));
  assert.equal(box.check({ origin: ORIGIN }).status, 0, 'the later file wins');
  box.dropIn('cleared-wake.service', '30-back.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net'));
  assert.equal(box.check({ origin: ORIGIN }).status, 1, 'and a later one again');
  // In one file, the last line; on one line, the last word; an empty Environment= clears what came before.
  box = ports();
  box.dropIn('cleared-wake.service', 'notify.conf', service([
    'Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net',
    'Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:8443',
    '# Environment=CLEARED_NOTIFY_LINK_BASE=https://commented.example',
    '; Environment=ORCH_NOTIFY_LINK_BASE=https://commented.example',
    'Environment=ORCH_NOTIFY_LINK_BASE=https://box.tail1234.ts.net ORCH_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:10000',
    '[Unit]',
    'Environment=CLEARED_NOTIFY_LINK_BASE=https://not-a-service-key.example',
  ].join('\n')));
  box.dropIn('cleared-app.service', 'notify.conf', service('Environment=CLEARED_NOTIFY_LINK_BASE=http://box.tail1234.ts.net\nEnvironment=\nEnvironment="CLEARED_NOTIFY_PUSH_HOSTS=push.example.org"'));
  const run = box.check({ origin: ORIGIN });
  assert.equal(run.status, 0, run.stderr);
  // Nothing in a drop-in is run: a command substitution is a value like any other, refused as no http(s) address.
  box = ports();
  const marker = join(box.dir, 'ran');
  box.dropIn('cleared-wake.service', 'notify.conf', service(`Environment=CLEARED_NOTIFY_LINK_BASE=$(touch ${marker})`));
  assert.equal(box.check({ origin: ORIGIN }).status, 1);
  assert.equal(existsSync(marker), false);
  // A drop-in masked by /dev/null sets nothing; a file that is no drop-in (not *.conf) is not read.
  box = ports();
  mkdirSync(join(box.units, 'cleared-wake.service.d'));
  symlinkSync('/dev/null', join(box.units, 'cleared-wake.service.d', 'notify.conf'));
  writeFileSync(join(box.units, 'cleared-wake.service.d', 'notes.txt'), service('Environment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net'));
  assert.equal(box.check({ origin: ORIGIN }).status, 0);
});

test('a drop-in that cannot be read, or whose quotes do not close, refuses; a drop-in directory that cannot be read is no drop-in', { skip: uid === 0 && 'root reads every file' }, () => {
  let box = ports();
  const file = box.dropIn('cleared-wake.service', 'notify.conf', '[Service]\nEnvironment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:8443\n');
  chmodSync(file, 0);
  let run = box.check({ origin: ORIGIN });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cleared-wake\.service\.d\/notify\.conf cannot be read/);
  assert.match(run.stderr, /the drop-ins of cleared-wake\.service \(.*\) could not be read, so the notification link they set cannot be checked/);
  // A dangling link is a file systemd cannot read either.
  box = ports();
  mkdirSync(join(box.units, 'cleared-app.service.d'));
  symlinkSync(join(box.dir, 'gone.conf'), join(box.units, 'cleared-app.service.d', 'notify.conf'));
  assert.match(box.check({ origin: ORIGIN }).stderr, /cleared-app\.service\.d\/notify\.conf cannot be read/);
  box = ports();
  box.dropIn('cleared-wake.service', 'notify.conf', '[Service]\nEnvironment="CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net:8443\n');
  run = box.check({ origin: ORIGIN });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /notify\.conf: a quote does not close/);
  // The directory itself closed: nothing of it reaches this account, and nothing is refused for it.
  box = ports();
  box.dropIn('cleared-wake.service', 'notify.conf', '[Service]\nEnvironment=CLEARED_NOTIFY_LINK_BASE=https://box.tail1234.ts.net\n');
  chmodSync(join(box.units, 'cleared-wake.service.d'), 0);
  run = box.check({ origin: ORIGIN });
  chmodSync(join(box.units, 'cleared-wake.service.d'), 0o755);
  assert.equal(run.status, 0, run.stderr);
});

test('the installer refuses, writing nothing, when the port of public_origin is held by something else or a drop-in links to 443; a re-run behind tailscale serve goes on', () => {
  const app = 'bind = 127.0.0.1\nport = 8788\npublic_origin = https://box.tail1234.ts.net:8443\n';
  const taken = installer({ app, listeners: listen('0.0.0.0:8443') });
  const run = taken.install({ CLEARED_NOTIFY_LINK_BASE: ORIGIN });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /public_origin .* is 8443, the port tailscale serve is told to publish, and 0\.0\.0\.0:8443 is already held/);
  assert.match(run.stderr, /nothing was written, no unit was touched/);
  assert.doesNotMatch(run.stdout, /tailscale serve --bg/, 'the serve command is never printed for a held port');
  assert.deepEqual(taken.written(), taken.nothing);

  const linked = installer({ app });
  linked.dropIn('cleared-wake.service', 'notify.conf', '[Service]\nEnvironment=CLEARED_NOTIFY_LINK_BASE=HTTPS://box.tail1234.ts.net\n');
  const before = linked.written();
  const refused = linked.install();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /the port of CLEARED_NOTIFY_LINK_BASE, set for cleared-wake\.service in .* is 443/);
  assert.deepEqual(linked.written(), before, 'nothing more than the drop-in that was there');

  const again = installer({ app, listeners: listen('100.64.0.1:8443') + listen('[fd7a:115c:a1e0::1]:8443'), serve: SERVED_8443 });
  again.dropIn('cleared-wake.service', 'notify.conf', `[Service]\nEnvironment=CLEARED_NOTIFY_LINK_BASE=${ORIGIN}\n`);
  const rerun = again.install({ CLEARED_NOTIFY_LINK_BASE: ORIGIN });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /^ {2}tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:8788$/m);
});
