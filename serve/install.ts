#!/usr/bin/env node
// Installs the systemd user units of Cleared, with no administrator rights,
// no container and no proxy: the release broker, the wake every minute, and
// the app, served to the Tailscale network only. Run it again from another
// checkout to move every unit there while the wake timer is stopped.
// Before anything is written, every port it binds or tells to publish is
// checked (lib/ports.ts): never 80 or 443, never a port something else
// listens on. No setting turns that off (#112).
//
//   serve/install.ts
//
// The port of serve/install.sh (docs/v2/milestone-4-plan.md, step c), without
// the steps of the three system accounts mode, which v2 drops: no sudo probe
// of the agents' account and no bubblewrap.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { installCheck, isHttps, onPath, serveHint } from '../lib/ports.ts';
import { confGetFrom, confSoft, die, main, ORCH_HOME, projectEnv, say, scratchDir } from '../lib/script.ts';

const run = (program: string, args: readonly string[], options: { readonly cwd?: string } = {}) => {
  const done = spawnSync(program, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) });
  return { status: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
};

await main(() => {
  const { repo, state } = projectEnv();
  const home = process.env.HOME || homedir();
  const appPort = process.env.CLEARED_APP_PORT || '8788';
  const tailscale = run('tailscale', ['ip', '-4']);
  const bind = tailscale.stdout.split('\n')[0] ?? '';
  if (tailscale.stderr) process.stderr.write(tailscale.stderr);
  if (!bind) die('the Tailscale address of this machine could not be read');
  // The project this copy works on is written where every command finds it: in
  // the units (a service has no terminal to inherit it from) and in the one
  // line a terminal reads (~/.config/cleared/project). One project for the
  // machine, and it must have been named: a tool that is a repository of its
  // own would otherwise work on itself.
  const named = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'cleared', 'project');
  let project: string;
  try { project = realpathSync(repo); if (!statSync(project).isDirectory()) throw new Error('no folder'); } catch { die(`the project (${repo}) is not a folder of this machine`); }
  if (run('git', ['-C', project, 'rev-parse', '--is-inside-work-tree' /* git-env: the service account on its own checkout, as install.sh read it */]).status !== 0) die(`the project (${project}) is not a git checkout`);
  if (project === realpathSync(ORCH_HOME) && !existsSync(join(project, '.cleared'))) {
    die('no project is named: this copy of the tool would work on itself. Run this with ORCH_REPO=<main checkout of the project>');
  }
  let known = '';
  try { known = (readFileSync(named, 'utf8').split('\n')[0] ?? '').trim(); } catch { known = ''; }
  if (known && known !== project) die(`this machine already works on ${known} (${named}): one project for a machine. To move it, remove that file, then run this again`);
  // What goes into a unit is written as it is: a path systemd or sed would
  // read another way is refused, not written half right.
  for (const path of [ORCH_HOME, project, state]) {
    if (/[ |&%"'\\\n]/.test(path)) die(`"${path}" cannot be written in a unit as it is (a blank, |, &, %, a quote or a backslash): move it`);
  }
  const head = run('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD' /* git-env: the service account on its own checkout, as install.sh read it */]);
  const guardRef = process.env.ORCH_GUARD_REF || (head.status === 0 ? head.stdout.trim() : '') || 'origin/main';
  const settings = scratchDir('cleared-install-');
  try {
    const committed = run('git', ['-C', project, 'show', `${guardRef}:.cleared/agents.conf` /* git-env: the service account on its own checkout, as install.sh read it */]);
    if (committed.status !== 0) die(`the committed project configuration (.cleared/agents.conf at ${guardRef}) could not be read; no services were installed`);
    const file = join(settings.path, 'agents.conf');
    writeFileSync(file, committed.stdout);
    if (!confGetFrom('guard', 'salt', file)) {
      say('Add [guard] salt = <random value> to the project agents.conf and commit it; the installer will not write it.');
      const terms = confGetFrom('guard', 'terms', file) ?? '';
      const allowed = confGetFrom('guard', 'allowed', file) ?? '';
      if ((terms && terms !== 'none') || (allowed && allowed !== 'none')) die('fingerprint lists are configured but their salt is not committed; no services were installed');
    }
  } finally {
    settings.remove();
  }
  const units = join(home, '.config', 'systemd', 'user');
  if (process.env.CLEARED_INSTALL_FROM_WAKE !== '1') {
    if (run('systemctl', ['--user', 'is-enabled', 'cleared-wake.timer']).stdout.startsWith('enabled')) {
      die('a Cleared wake timer is already active; disable it and wait for cleared-wake.service to finish before installing');
    }
    if (run('systemctl', ['--user', 'is-active', '--quiet', 'cleared-wake.timer']).status === 0) die('a Cleared wake timer is already active; stop it before installing');
    const wake = run('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', 'cleared-wake.service']);
    if (wake.status !== 0) die('the Cleared wake state could not be read; no services were installed');
    const now = wake.stdout.replace(/\n+$/, '');
    if (now !== 'inactive' && now !== 'failed') die(`a Cleared wake is already active (${now}); wait for cleared-wake.service to finish before installing`);
  }
  // The ports, before the first write: the app's, [app] port, the port of
  // [app] public_origin (the one tailscale serve publishes, 443 when none is
  // written) and of the notifications' link (this shell's, and the drop-ins'
  // of cleared-wake.service and cleared-app.service). 80 and 443 are refused
  // outright, a port held by anything but this installation's own unit (or,
  // for public_origin, tailscale serve) too, and so is a machine whose
  // listening ports cannot be read.
  const origin = confSoft('app', 'public_origin');
  const confPort = confSoft('app', 'port');
  if (!installCheck({ appPort, confPort, origin, link: process.env.CLEARED_NOTIFY_LINK_BASE || '', bind, units, legacyLink: process.env.ORCH_NOTIFY_LINK_BASE || '' })) {
    die('a port check failed (above): nothing was written, no unit was touched');
  }
  // Behind tailscale serve (an https public_origin) the app listens on [app] bind, this machine only by default (app/main.ts).
  const appAddress = isHttps(origin) ? (confSoft('app', 'bind') || '127.0.0.1') : bind;
  const goWrite = (path: string) => chmodSync(path, statSync(path).mode & ~0o022);
  mkdirSync(dirname(named), { recursive: true });
  writeFileSync(named, `${project}\n`);
  goWrite(named);
  // The service's own pointer, independent of an XDG_CONFIG_HOME of the caller.
  const serviceNamed = join(home, '.config', 'cleared', 'project');
  mkdirSync(dirname(serviceNamed), { recursive: true });
  goWrite(dirname(serviceNamed));
  if (named !== serviceNamed) {
    writeFileSync(serviceNamed, `${project}\n`);
    goWrite(serviceNamed);
  }
  writeFileSync(join(home, '.config', 'cleared', 'state'), `${state}\n`);
  goWrite(join(home, '.config', 'cleared', 'state'));
  mkdirSync(units, { recursive: true });
  mkdirSync(state, { recursive: true });
  // The service keeps its state private.
  const agentUser = confSoft('security', 'agent_user');
  if (!onPath('python3')) die('Install Python 3 for the local socket peer-UID check');
  chmodSync(state, statSync(state).mode & ~0o002);
  const here = join(ORCH_HOME, 'serve');
  for (const unit of readdirSync(here).filter((name) => /^cleared-.*\.(service|timer)$/.test(name)).sort()) {
    const text = readFileSync(join(here, unit), 'utf8')
      .replaceAll('@APP_PORT@', appPort).replaceAll('@BIND@', bind).replaceAll('@ORCH_HOME@', ORCH_HOME).replaceAll('@ORCH_REPO@', project);
    writeFileSync(join(units, basename(unit)), text);
  }
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'cleared-release-broker.service', 'cleared-wake.timer', 'cleared-app.service'], ['--user', 'restart', 'cleared-release-broker.service', 'cleared-app.service']]) {
    const done = spawnSync('systemctl', args, { stdio: 'inherit' });
    if (done.status !== 0) return done.status ?? 1;
  }
  const hint = serveHint(origin, appAddress, appPort);
  if (hint) {
    process.stdout.write(`Cleared app: ${origin}/login, once it is published on the Tailscale network, if not done yet (never on 443: docs/app.md):\n`);
    process.stdout.write(`  ${hint}\n`);
  } else process.stdout.write(`Cleared app: http://${bind}:${appPort}/login\n`);
  process.stdout.write(`Access token: run '${ORCH_HOME}/cleared app --bind ${bind} --link' on this machine to print the sign-in address; the token file stays outside the project.\n`);
  if (!agentUser) process.stdout.write('release lock is not a security boundary: agents run as the service account\n');
  // The units do not read this shell: the link is set by a drop-in on cleared-wake.service (docs/notifications.md, Service environment).
  if (!process.env.CLEARED_NOTIFY_LINK_BASE) say('WARNING: CLEARED_NOTIFY_LINK_BASE is not set in this shell: notifications will have no link, and Web Push will report no_subject, until a drop-in sets it for cleared-wake.service (docs/notifications.md, Service environment).');
  return 0;
});
