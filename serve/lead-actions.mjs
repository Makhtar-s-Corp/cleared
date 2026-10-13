#!/usr/bin/env node
// Narrow service-account entrypoint for the project lead's existing non-release
// scripts. Sudoers must allow this file only, with the script path fixed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConf, projectDir } from '../lib/conf.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.env.PATH = `${join(homedir(), '.local/bin')}:/usr/local/bin:/usr/bin:/bin`; 
const conf = loadConf();
const agent = conf.sections.security?.agent_user;
if (agent) {
  const line = execFileSync('getent', ['passwd', agent], { encoding: 'utf8' }).trim().split(':');
  if (String(process.env.SUDO_UID) !== line[2] || process.getuid() === Number(line[2])) throw new Error('Lead action caller is not the configured agent account');
} else if (process.env.ORCH_LEAD_LOCAL !== '1') throw new Error('Local lead action requires the service-account client');
const [action, ...args] = process.argv.slice(2);
const ticket = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(value);
const lane = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,100}$/.test(value);
const short = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const pr = (value) => /^[1-9][0-9]*$/.test(value || '');
let file, command, options = [], input;
const bodyActions = new Set(['comment', 'tell', 'digest', 'create']);
if (bodyActions.has(action)) {
  input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 20000) throw new Error('Lead action body is too long');
  }
  if (!input.trim()) throw new Error('Lead action body is empty');
  const temp = mkdtempSync(join(tmpdir(), 'cleared-lead-action-'));
  file = join(temp, 'body.md');
  writeFileSync(file, input, { mode: 0o600 });
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
switch (action) {
  case 'review':
    if (!pr(args[0]) || !ticket(args[1]) || args.length !== 2) throw new Error('usage: review PR TICKET');
    command = 'review-pr.sh'; options = [args[0], args[1]]; break;
  case 'comment':
    if (!ticket(args[0]) || args.length !== 1) throw new Error('usage: comment TICKET');
    command = 'tracker.sh'; options = ['comment', args[0], file]; break;
  case 'create':
    if (args.length !== 3 || args.some((a) => !short(a))) throw new Error('usage: create PROJECT LABEL TITLE');
    command = 'tracker.sh'; options = ['create', ...args, file]; break;
  case 'tell':
    if (!lane(args[0]) || args.length !== 1) throw new Error('usage: tell LANE');
    command = 'tell-lane.sh'; options = [args[0], file]; break;
  case 'digest':
    if (args.length) throw new Error('usage: digest');
    command = 'digest-note.sh'; options = [file]; break;
  case 'issue':
  case 'comments':
    if (!ticket(args[0]) || args.length !== 1) throw new Error(`usage: ${action} TICKET`);
    command = 'tracker.sh'; options = [action, args[0]]; break;
  case 'waiting':
    if (args.length) throw new Error('usage: waiting');
    command = 'tracker.sh'; options = ['waiting']; break;
  case 'lanes':
    if (args.length) throw new Error('usage: lanes');
    command = 'tell-lane.sh'; options = ['--list']; break;
  case 'ping':
    if (args.length) throw new Error('usage: ping');
    console.log(`service uid ${process.getuid()}`); process.exit(0);
  case 'host':
    if (args.length) throw new Error('usage: host');
    command = 'host-state.sh'; break;
  default: throw new Error('Unknown lead action');
}
const result = spawnSync(join(root, command), options, { cwd: projectDir(), stdio: 'inherit' });
process.exit(result.status ?? 1);
