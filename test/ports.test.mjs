// The ports of the installation (lib/ports.sh, serve/install.sh; issue #112): never 80 or 443, never a port
// something else listens on, checked before anything is written. On 2026-10-17 `tailscale serve` on its
// default port held 443 on the Tailscale address, and after a reboot the machine's public proxy could not
// bind 0.0.0.0:443: production was down for six hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { scratch } from './support.mjs';

const uid = process.getuid();
const cgroup = (unit, user = uid) => `0::/user.slice/user-${user}.slice/user@${user}.service/app.slice/${unit}\n`;

// The helper, sourced as install.sh sources it, with the listeners and the kernel's tables of the test.
function ports({ listeners = '', ssFails = false, noSs = false, proc = null } = {}) {
  const dir = scratch('orch-ports-');
  const ss = join(dir, 'ss');
  writeFileSync(join(dir, 'listeners'), listeners);
  writeFileSync(ss, ssFails ? '#!/bin/sh\necho "Cannot open netlink socket: Permission denied" >&2\nexit 1\n' : `#!/bin/sh\ncat '${join(dir, 'listeners')}'\n`, { mode: 0o755 });
  const procDir = proc ?? join(dir, 'proc');
  mkdirSync(procDir, { recursive: true });
  const call = (fn, ...args) => spawnSync('bash', ['-c', `set -euo pipefail; . "$1/lib/ports.sh"; ports_ss=$2; ports_proc=$3; shift 3; "$@"`, '_',
    ORCH_HOME, noSs ? join(dir, 'no-such-ss') : ss, procDir, fn, ...args], { encoding: 'utf8' });
  // dashboard port, app port, [app] port, [app] public_origin, link base, Tailscale address
  const check = ({ dashboard = '8787', app = '8788', confPort = '8788', origin = '', link = '', bind = '100.64.0.1' } = {}) =>
    call('ports_install_check', dashboard, app, confPort, origin, link, bind);
  return { dir, procDir, call, check };
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
function installer({ app = 'bind = 127.0.0.1\nport = 8788\n', listeners = '' } = {}) {
  const home = scratch('orch-install-ports-');
  const tool = join(home, 'tool');
  const bin = join(home, 'bin');
  const project = join(home, 'project');
  for (const made of [tool, bin, join(project, '.cleared')]) mkdirSync(made, { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'serve'), tool]);
  writeFileSync(join(tool, 'dashboard.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(tool, 'serve', 'check.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'tailscale'), '#!/usr/bin/env bash\necho 100.64.0.1\n', { mode: 0o755 });
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
  return { install, written, nothing };
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
