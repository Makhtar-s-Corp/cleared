#!/usr/bin/env node
// `cleared app`: starts the read-only Cockpit server.
//
//   cleared app [--demo] [--port N] [--bind ADDRESS] [--link]
//   cleared app passkey        (the human's account only) prints the address that registers a passkey on a phone
//
// --link prints the address to open on a phone (the token after the # sign is
// never sent to the server in a request line); --demo serves invented data.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfForCommand, projectDir, section, expandHome } from '../lib/conf.mjs';
import { appServer } from './server.mjs';
import { checkRanges, ensureToken, TAILSCALE } from './lib/access.mjs';
import { execFileSync } from 'node:child_process';
import { addEvent, ledgerPath, openLedger } from '../lib/ledger.mjs';
import { createActions } from './lib/actions.mjs';
import { defaultDir, readPasskeys, writePasskeys, privateDir } from './lib/credentials.mjs';
import { grantServer, requestGrant } from './lib/grant-socket.mjs';
import { runWriter } from './lib/run-writer.mjs';
import { createNotifications } from './lib/notifications.mjs';
import { notifySettings } from '../lib/notify/contract.mjs';
import { notifyStore } from '../lib/notify/store.mjs';
import { demoSource } from './sources/demo.mjs';
import { liveSource } from './sources/live.mjs';

const args = process.argv.slice(2);
const passkeyCommand = args[0] === 'passkey';
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const known = ['--demo', '--port', '--bind', '--link'];
if (!passkeyCommand && args.some((a, i) => a.startsWith('--') && !known.includes(a)) ) { console.error('usage: cleared app [--demo] [--port N] [--bind ADDRESS] [--link]'); process.exit(64); }

const demo = flag('--demo');
const conf = demo ? { sections: {} } : loadConfForCommand();
const settings = section(conf, 'app');
const port = Number(value('--port') || settings.port || 8788);
const publicHttps = /^https:\/\//.test(settings.public_origin || '');
// Behind a TLS proxy on this machine (tailscale serve) the app listens on this machine only: the proxy's address is what says the connection is encrypted.
const bind = publicHttps ? (settings.bind || '127.0.0.1') : (value('--bind') || settings.bind || '127.0.0.1');
const tokenFile = expandHome(settings.token_file || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'app-token'));
let ranges;
try { ranges = checkRanges(settings.ranges ? settings.ranges.split(/[\s,]+/).filter(Boolean) : [...TAILSCALE, '127.0.0.0/8', '::1/128']); }
catch (error) { console.error(`cleared app: ${error.message}`); process.exit(2); }
const hosts = (settings.hosts ?? '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('cleared app: invalid port'); process.exit(64); }

const origin = settings.public_origin || '';
const credentialsDir = expandHome(settings.human_credentials_dir || defaultDir());
const grantPath = settings.grant_socket ? expandHome(settings.grant_socket) : '';
const project = demo ? undefined : projectDir();

if (passkeyCommand) {
  // Only the human's account is given a grant; the app checks the caller's UID itself.
  if (!grantPath) { console.error('cleared app passkey: set [app] grant_socket (and [app] public_origin) first, see docs/app.md'); process.exit(2); }
  try {
    const answer = await requestGrant(grantPath);
    if (!answer.ok) { console.error(`cleared app passkey: ${answer.reason}`); process.exit(1); }
    console.log(`Open this address on the phone, signed in to the app (valid 10 minutes, single use):\n${answer.origin || origin}/register#${answer.grant}`);
  } catch (error) { console.error(`cleared app passkey: the app does not answer on ${grantPath} (${error.message})`); process.exit(1); }
  process.exit(0);
}

let token;
try { token = ensureToken(tokenFile, { project: demo ? undefined : projectDir() }); }
catch (error) { console.error(`cleared app: ${error.message}`); process.exit(2); }

if (flag('--link')) { console.log(`http://${bind}:${port}/login#${token}`); process.exit(0); }

const language = demo ? 'en' : (section(conf, 'owner').language || 'en');
const source = demo ? demoSource() : liveSource({ conf });
// The human's Unix account, the same one the release broker trusts for a manual rollback.
function humanUid() {
  const security = section(conf, 'security');
  const name = security.human_user || (section(conf, 'tracker').adapter === 'local' ? section(conf, 'tracker').owner_id : '');
  // The same rules as the release broker: the human is never the agents' account, and never taken for the app's own account when agents exist.
  const uidOf = (user) => Number(execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim().split(':')[2]);
  const agent = security.agent_user ? uidOf(security.agent_user) : null;
  const human = name ? uidOf(name) : security.allow_shared_uid === 'true' && !security.agent_user ? process.getuid() : null;
  if (human !== null && (!Number.isSafeInteger(human) || human === agent || (agent !== null && human === process.getuid()) || (human === process.getuid() && security.allow_shared_uid !== 'true'))) {
    console.error('cleared app: [security] human_user must differ from agent_user and from the app\'s own account when agent_user is set; no passkey grant will be given');
    return null;
  }
  return human;
}
const owner = demo ? 'you' : section(conf, 'tracker').owner_id || '';
const record = demo ? () => {} : (event) => {
  const db = openLedger(ledgerPath());
  try { addEvent(db, { kind: 'app_gesture', source: 'app', ...event }); } finally { db.close(); }
};
let actions;
if (demo) {
  // Invented data: a gesture is accepted and written nowhere.
  let keys = [];
  actions = createActions({ source, origin, owner, readPasskeys: () => keys, writePasskeys: (list) => { keys = list; }, run: async () => ({ ok: true, author: 'you', verified: true }) });
} else {
  try { privateDir(credentialsDir, { project }); } catch (error) { console.error(`cleared app: gestures disabled until the human credentials directory exists: ${error.message}`); }
  actions = createActions({ source, origin, owner, record, run: (request) => runWriter(request),
    readPasskeys: () => readPasskeys(credentialsDir, { project }), writePasskeys: (list) => writePasskeys(credentialsDir, list, { project }) });
}
// A browser of the human may ask to be notified: its subscription is kept in the service's private
// notification directory, made here if missing (lib/notify/store.mjs). Off in the demo.
let notifications = null;
if (!demo) {
  try { const notify = notifySettings(conf); notifications = createNotifications({ settings: notify, store: notifyStore(notify.secretsDir, { project, create: true }), origin, record }); }
  catch (error) { console.error(`cleared app: notifications off: ${error.message}`); }
}
const grants = !demo && grantPath ? grantServer({ path: grantPath, humanUid: humanUid(), mint: () => actions.mintGrant(), record }) : null;
const server = appServer({ source, token, ranges, language, hosts, actions, notifications, origin, owner });
if (grants) { const close = server.close.bind(server); server.close = (callback) => { grants.close(); return close(callback); }; }
server.listen(port, bind, () => {
  // The token is never written here.
  console.log(`cleared app on http://${bind}:${port}/ for ${ranges.join(', ')} only; token file ${demo ? 'present' : 'outside the project'}`);
});
