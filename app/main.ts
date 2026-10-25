#!/usr/bin/env node
// `cleared app`: starts the read-only Cockpit server.
//
//   cleared app [--demo] [--port N] [--bind ADDRESS] [--link]
//   cleared app passkey        says that passkeys are gone (the session confirms the gestures) and exits 2
//
// --link prints the address to open on a phone (the token after the # sign is
// never sent to the server in a request line); --demo serves invented data.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConf, loadConfForCommand, projectDir, section, expandHome } from '../lib/conf.ts';
import type { Conf } from '../lib/conf.ts';
import { appServer } from './server.ts';
import { checkRanges, ensureToken, TAILSCALE } from './lib/access.ts';
import { addEvent, ledgerPath, openLedger } from '../lib/ledger.ts';
import { createActions } from './lib/actions.ts';
import { defaultDir, privateDir } from './lib/credentials.ts';
import { runWriter } from './lib/run-writer.ts';
import { createNotifications } from './lib/notifications.ts';
import { notifySettings } from '../lib/notify/contract.ts';
import { notifyStore } from '../lib/notify/store.ts';
import { demoSource } from './sources/demo.ts';
import { liveSource } from './sources/live.ts';
import { message } from '../lib/i18n.ts';

const args = process.argv.slice(2);
const passkeyCommand = args[0] === 'passkey';
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const known = ['--demo', '--port', '--bind', '--link'];
if (!passkeyCommand && args.some((a, i) => a.startsWith('--') && !known.includes(a)) ) { console.error('usage: cleared app [--demo] [--port N] [--bind ADDRESS] [--link]'); process.exit(64); }

const demo = flag('--demo');
// The demo reads no setting: only its empty sections are ever looked at.
const conf = demo ? { sections: {} } as Conf : loadConfForCommand();
const settings = section(conf, 'app');
// Passkeys are gone (decisions log, 2026-10-25): the command says so, in the owner's language, and starts nothing.
if (passkeyCommand) { console.error(message('cli_app_passkey_gone', section(conf, 'owner').language || 'en')); process.exit(2); }
const port = Number(value('--port') || settings.port || 8788);
const publicHttps = /^https:\/\//.test(settings.public_origin || '');
// Behind a TLS proxy on this machine (tailscale serve) the app listens on this machine only: the proxy's address is what says the connection is encrypted.
const bind = publicHttps ? (settings.bind || '127.0.0.1') : (value('--bind') || settings.bind || '127.0.0.1');
const tokenFile = expandHome(settings.token_file || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'app-token'));
let ranges: string[];
try { ranges = checkRanges(settings.ranges ? settings.ranges.split(/[\s,]+/).filter(Boolean) : [...TAILSCALE, '127.0.0.0/8', '::1/128']); }
catch (error) { console.error(`cleared app: ${(error as Error).message}`); process.exit(2); }
const hosts = (settings.hosts ?? '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('cleared app: invalid port'); process.exit(64); }

const origin = settings.public_origin || '';
const credentialsDir = expandHome(settings.human_credentials_dir || defaultDir());
const project = demo ? undefined : projectDir();

let token: string;
try { token = ensureToken(tokenFile, { project: demo ? undefined : projectDir() }); }
catch (error) { console.error(`cleared app: ${(error as Error).message}`); process.exit(2); }

if (flag('--link')) { console.log(`http://${bind}:${port}/login#${token}`); process.exit(0); }

// The demonstration speaks the language the owner chose too ([owner] language), English by default.
const ownerLanguage = () => { try { return section(demo ? loadConf() : conf, 'owner').language || 'en'; } catch { return 'en'; } };
const language = ownerLanguage();
const source = demo ? demoSource(language) : liveSource({ conf });
const owner = demo ? 'you' : section(conf, 'tracker').owner_id || '';
const record = demo ? () => {} : (event: { ticket?: string | null; detail: string }) => {
  const db = openLedger(ledgerPath());
  try { addEvent(db, { kind: 'app_gesture', source: 'app', ...event }); } finally { db.close(); }
};
let actions;
if (demo) {
  // Invented data: a gesture is accepted and written nowhere.
  actions = createActions({ source, origin, run: async () => ({ ok: true, author: 'you', verified: true }) });
} else {
  try { privateDir(credentialsDir, { project }); } catch (error) { console.error(`cleared app: gestures disabled until the human credentials directory exists: ${(error as Error).message}`); }
  actions = createActions({ source, origin, record, run: (request) => runWriter(request) });
}
// A browser of the human may ask to be notified, confirmed by the same session, as the gestures are:
// its subscription is kept in the service's private notification directory, made here if missing
// (lib/notify/store.ts). Off in the demo.
let notifications = null;
if (!demo) {
  try { const notify = notifySettings(conf); notifications = createNotifications({ settings: notify, store: notifyStore(notify.secretsDir, { project, create: true }), origin, record, confirm: actions }); }
  catch (error) { console.error(`cleared app: notifications off: ${(error as Error).message}`); }
}
const server = appServer({ source, token, ranges, language, hosts, actions, notifications, origin, owner });
server.listen(port, bind, () => {
  // The token is never written here.
  console.log(`cleared app on http://${bind}:${port}/ for ${ranges.join(', ')} only; token file ${demo ? 'present' : 'outside the project'}`);
});
