#!/usr/bin/env node
import { createMemory } from './contract.mjs';
import { loadConf, section } from '../conf.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTracker } from '../tracker/contract.mjs';
import { runAsCommand } from '../conf.mjs';

function main([command, ...args]) {
  const conf = loadConf();
  if (section(conf, 'memory').enabled !== 'true') {
    if (command === 'approve') throw new Error('[memory] enabled = false; no entry was approved');
    return;
  }
  const memory = createMemory({ conf });
  if (command === 'briefing') {
    const [role, ticket, title = '', body = ''] = args;
    process.stdout.write(memory.briefing({ role, ticket: { id: ticket, title, body } }).text);
  } else if (command === 'capture') {
    const [worktree, role, model, ticket, runId] = args;
    memory.captureHandover({ worktree, role, model, ticket, runId });
  } else if (command === 'recover') {
    const [worktree, role, ticket, lane] = args;
    const path = join(worktree, 'HANDOVER.md');
    if (!existsSync(path)) return;
    const previous = memory.db.prepare('SELECT run_id, model FROM runs WHERE lane = ? AND ticket = ? AND role = ? AND model IS NOT NULL ORDER BY started_at DESC LIMIT 1')
      .get(lane, ticket, role);
    if (previous) memory.captureHandover({ worktree, role, model: previous.model, ticket, runId: previous.run_id });
    else throw new Error(`Stale handover has no recorded model; inspect ${path} before reopening the lane`);
  } else if (command === 'approve') {
    const tracker = createTracker(conf);
    createMemory({ conf, tracker }).approve(args[0], { ticket: args[1], commentId: args[2] });
  } else throw new Error('usage: memory/cli.mjs briefing ROLE TICKET TITLE BODY | capture WORKTREE ROLE MODEL TICKET RUN_ID | recover WORKTREE ROLE TICKET LANE | approve ID [TICKET COMMENT_ID]');
}
if (runAsCommand(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`memory: ${error.message}\n`); process.exitCode = 1; }
}
