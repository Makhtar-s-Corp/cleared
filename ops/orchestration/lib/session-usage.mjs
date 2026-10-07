#!/usr/bin/env node
// The tokens of one interactive session, counted from the log the CLI keeps
// of it (the conversation has no machine-readable output of its own). Same
// shape as the usage file of an adapter.
//
//   session-usage.mjs <session id> <model> [<projects dir>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAsCommand } from './conf.mjs';

export function sessionUsage(lines, model = null) {
  // A message is logged once per content block, with the same usage.
  const messages = new Map();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant' || !entry.message?.usage || entry.message.model === '<synthetic>') continue;
    messages.set(entry.message.id ?? messages.size, entry.message);
  }
  const usage = { model, tokens_in: 0, tokens_out: 0, tokens_cache: 0, tokens_cache_write: 0, tokens_total: 0, cost_usd: null };
  for (const message of messages.values()) {
    usage.model = message.model ?? usage.model;
    usage.tokens_in += message.usage.input_tokens ?? 0;
    usage.tokens_out += message.usage.output_tokens ?? 0;
    usage.tokens_cache += message.usage.cache_read_input_tokens ?? 0;
    usage.tokens_cache_write += message.usage.cache_creation_input_tokens ?? 0;
  }
  usage.tokens_total = usage.tokens_in + usage.tokens_out + usage.tokens_cache + usage.tokens_cache_write;
  return usage;
}

if (runAsCommand(import.meta.url)) {
  const [session, model, projects = join(homedir(), '.claude', 'projects')] = process.argv.slice(2);
  let lines = [];
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const path = join(projects, dir, `${session}.jsonl`);
    if (existsSync(path)) { lines = readFileSync(path, 'utf8').split('\n'); break; }
  }
  process.stdout.write(`${JSON.stringify(sessionUsage(lines, model || null))}\n`);
}
