#!/usr/bin/env node
import { createMemory } from './contract.mjs';
import { loadConf, section } from '../conf.mjs';
import { createTracker } from '../tracker/contract.mjs';
import { runAsCommand } from '../conf.mjs';

function main([command, ...args]) {
  const conf = loadConf();
  if (section(conf, 'memory').enabled !== 'true') return;
  const memory = createMemory({ conf });
  if (command === 'briefing') {
    const [role, ticket, title = '', body = ''] = args;
    process.stdout.write(memory.briefing({ role, ticket: { id: ticket, title, body } }).text);
  } else if (command === 'capture') {
    const [worktree, role, model, ticket, runId] = args;
    memory.captureHandover({ worktree, role, model, ticket, runId });
  } else if (command === 'approve') {
    const tracker = createTracker(conf);
    createMemory({ conf, tracker }).approve(args[0]);
  } else throw new Error('usage: memory/cli.mjs briefing ROLE TICKET TITLE BODY | capture WORKTREE ROLE MODEL TICKET RUN_ID | approve ID');
}
if (runAsCommand(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`memory: ${error.message}\n`); process.exitCode = 1; }
}
