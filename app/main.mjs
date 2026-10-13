#!/usr/bin/env node
// `cleared app`: starts the read-only Cockpit server.
//
//   cleared app [--demo] [--port N] [--bind ADDRESS] [--link]
//
// --link prints the address to open on a phone (the token after the # sign is
// never sent to the server in a request line); --demo serves invented data.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConf, projectDir, section, expandHome } from '../lib/conf.mjs';
import { appServer } from './server.mjs';
import { ensureToken, TAILSCALE } from './lib/access.mjs';
import { demoSource } from './sources/demo.mjs';
import { liveSource } from './sources/live.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const known = ['--demo', '--port', '--bind', '--link'];
if (args.some((a, i) => a.startsWith('--') && !known.includes(a)) ) { console.error('usage: cleared app [--demo] [--port N] [--bind ADDRESS] [--link]'); process.exit(64); }

const demo = flag('--demo');
const conf = demo ? { sections: {} } : loadConf();
const settings = section(conf, 'app');
const port = Number(value('--port') ?? settings.port ?? 8788);
const bind = value('--bind') ?? settings.bind ?? '127.0.0.1';
const tokenFile = expandHome(settings.token_file || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'app-token'));
const ranges = settings.ranges ? settings.ranges.split(/[\s,]+/).filter(Boolean) : [...TAILSCALE, '127.0.0.0/8', '::1/128'];
const hosts = (settings.hosts ?? '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('cleared app: invalid port'); process.exit(64); }

let token;
try { token = ensureToken(tokenFile, { project: demo ? undefined : projectDir() }); }
catch (error) { console.error(`cleared app: ${error.message}`); process.exit(2); }

if (flag('--link')) { console.log(`http://${bind}:${port}/login#${token}`); process.exit(0); }

const language = demo ? 'en' : (section(conf, 'owner').language || 'en');
const source = demo ? demoSource() : liveSource({ conf });
appServer({ source, token, ranges, language, hosts }).listen(port, bind, () => {
  // The token is never written here.
  console.log(`cleared app on http://${bind}:${port}/ for ${ranges.join(', ')} only; token file ${demo ? 'present' : 'outside the project'}`);
});
