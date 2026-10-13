#!/usr/bin/env node
import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDir, loadConf } from './lib/conf.mjs';
const [operation, ticket, pr, ...flags] = process.argv.slice(2);
if (!['request_release', 'request_rollback', 'status'].includes(operation) || !ticket) {
  console.error('usage: release-request.mjs request_release TICKET PR | request_rollback TICKET [APPROVAL_COMMENT] | status TICKET'); process.exit(64);
}
const path = process.env.CLEARED_RELEASE_SOCKET || loadConf().sections.security?.socket_path || join(tmpdir(), `cleared-release-${process.getuid()}-${createHash('sha256').update(projectDir()).digest('hex').slice(0, 12)}.sock`);
let announcement = '';
if (operation === 'request_release') for await (const chunk of process.stdin) announcement += chunk;
const request = { operation, ticket };
if (process.env.ORCH_FROM_QUEUE === '1') request.from_queue = true;
if (operation === 'request_release') {
  request.pr = Number(pr);
  if (flags.includes('--ask')) {
    request.approval_request = announcement;
    request.announcement = '';
    request.approval_prs = [Number(pr)];
    request.captures = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--ask') continue;
      if (flags[i] === '--pr' && flags[++i]) request.approval_prs.push(Number(flags[i]));
      else if (flags[i] === '--capture' && flags[i + 1] && flags[i + 2]) request.captures.push({ path: flags[++i], caption: flags[++i] });
      else { console.error('Invalid request_release option'); process.exit(64); }
    }
  } else if (flags.length) { console.error('Invalid request_release option'); process.exit(64); }
  else request.announcement = announcement;
}
if (operation === 'request_rollback') {
  for (let i = 0; i < [pr, ...flags].length; i++) {
    const options = [pr, ...flags];
    if (!options[i]) continue;
    if (options[i] === '--approval-comment' && options[i + 1]) request.approval_comment = options[++i];
    else if (options[i] === '--force-with-migrations') request.force_with_migrations = true;
    else { console.error('Invalid request_rollback option'); process.exit(64); }
  }
}
const client = net.connect(path);
let reply = '';
client.on('connect', () => client.end(JSON.stringify(request)));
client.on('data', (chunk) => reply += chunk);
client.on('end', () => {
  try { const result = JSON.parse(reply); const message = result.output || result.reason || JSON.stringify(result); (result.ok ? console.log : console.error)(message); process.exitCode = result.code ?? (result.ok ? 0 : 1); }
  catch { console.error('Invalid release broker reply'); process.exitCode = 1; }
});
client.on('error', (error) => { console.error(`release broker: ${error.message}`); process.exitCode = 1; });
