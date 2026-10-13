#!/usr/bin/env node
// Agent-side client for the existing lead scripts. Release is never here.
import { spawnSync, execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConf, stateDir } from './lib/conf.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const uid = statSync(stateDir()).uid;
if (uid === process.getuid()) {
  if (loadConf().sections.security?.agent_user) { console.error('lead-command requires the agent account'); process.exit(2); }
  const result = spawnSync(process.execPath, [`${root}serve/lead-actions.mjs`, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ORCH_LEAD_LOCAL: '1' } });
  process.exit(result.status ?? 1);
}
const user = execFileSync('getent', ['passwd', String(uid)], { encoding: 'utf8' }).trim().split(':')[0];
const result = spawnSync('sudo', ['-n', '-u', user, '--', process.execPath, `${root}serve/lead-actions.mjs`, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
