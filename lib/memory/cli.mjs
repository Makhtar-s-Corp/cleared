#!/usr/bin/env node
import { createMemory } from './contract.mjs';
import { loadConf, section, stateDir } from '../conf.mjs';
import { addEvent } from '../ledger.mjs';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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
  } else if (command === 'recover') {
    const [worktree, role, ticket, lane] = args;
    const path = join(worktree, 'HANDOVER.md');
    if (!existsSync(path)) return;
    const previous = memory.db.prepare('SELECT run_id, model FROM runs WHERE lane = ? AND ticket = ? AND role = ? AND model IS NOT NULL ORDER BY started_at DESC LIMIT 1')
      .get(lane, ticket, role);
    if (previous) memory.captureHandover({ worktree, role, model: previous.model, ticket, runId: previous.run_id });
    else {
      const saved = join(stateDir(), 'runs', `orphan-${Date.now()}`, 'HANDOVER.md');
      mkdirSync(join(saved, '..'), { recursive: true });
      renameSync(path, saved);
      addEvent(memory.db, { kind: 'handover_missing', ticket, detail: `Stale handover with no known model saved at ${saved}` });
    }
  } else if (command === 'approve') {
    const tracker = createTracker(conf);
    createMemory({ conf, tracker }).approve(args[0], { ticket: args[1], commentId: args[2] });
  } else throw new Error('usage: memory/cli.mjs briefing ROLE TICKET TITLE BODY | capture WORKTREE ROLE MODEL TICKET RUN_ID | recover WORKTREE ROLE TICKET LANE | approve ID [TICKET COMMENT_ID]');
}
if (runAsCommand(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`memory: ${error.message}\n`); process.exitCode = 1; }
}
