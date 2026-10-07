#!/usr/bin/env node
// What the lanes already at work say to the project lead. A lane does not
// read Linear: it ends its turn with a report, the last message of its own
// terminal, that speaks to the project lead. This reads that last message
// from the session log of each lane. No model.
//
//   lanes.mjs <worktrees.json> [<max age in hours>] [<projects dir>]
//       <worktrees.json>: [{name, path, branch}]
//       prints [{id, lane, branch, at, text}], one per lane whose last
//       message addresses the project lead
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAsCommand } from './conf.mjs';

const TAIL_BYTES = 600_000;
// Younger than this, the turn of the lane may still go on in the next line of
// its log: the message is not a report yet.
const SETTLE_MS = 45_000;
// A report is addressed to the lead when it names it at its beginning.
const ADDRESSED = /chef de projet/i;

function tail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  // The first line may be cut: it is dropped.
  return buffer.toString('utf8').split('\n').slice(size > length ? 1 : 0);
}

// The last thing the lane said, if nothing was asked of it since.
export function lastReport(lines) {
  let last = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain) continue;
    if (entry.type === 'user') {
      const content = entry.message?.content;
      const toolResult = Array.isArray(content) && content.some((block) => block.type === 'tool_result');
      // Someone wrote to the lane after its report: it is at work again.
      if (!toolResult) last = null;
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content ?? [];
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      // A tool call after a text means the turn goes on.
      if (blocks.some((block) => block.type === 'tool_use')) last = null;
      else if (text) last = { id: entry.uuid, at: entry.timestamp, text };
    }
  }
  return last;
}

// `maxHours`: a last message older than that is not a request any more (a
// lane left as it was days ago is not waiting for the lead that takes over).
export function laneReports(worktrees, projects = join(homedir(), '.claude', 'projects'), { maxHours = 6, now = Date.now() } = {}) {
  const reports = [];
  for (const worktree of worktrees) {
    const dir = join(projects, worktree.path.replace(/[^A-Za-z0-9]/g, '-'));
    let logs;
    try { logs = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name)); } catch { continue; }
    if (!logs.length) continue;
    const latest = logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    const report = lastReport(tail(latest));
    const age = report ? now - new Date(report.at) : NaN;
    if (report && age >= SETTLE_MS && age <= maxHours * 3600e3 && ADDRESSED.test(report.text.slice(0, 400))) {
      reports.push({ id: report.id, lane: worktree.name, branch: worktree.branch, at: report.at, text: report.text });
    }
  }
  return reports;
}

if (runAsCommand(import.meta.url)) {
  const worktrees = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const maxHours = Number(process.argv[3]) || 6;
  process.stdout.write(`${JSON.stringify(laneReports(worktrees, process.argv[4], { maxHours }))}\n`);
}
