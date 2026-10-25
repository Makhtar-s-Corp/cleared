// The briefing of a lead generation (docs/v2/milestone-2-plan.md, section
// 4.2), written as CLAUDE.md in the lead's workdir, which the runner appends
// to the system prompt: the lead's rules first, as the only instructions;
// then, under lib/memory's reference line and quoted line by line, the
// lead's memory, the open commitments from the table and the last handover
// record (the lead's account, the structured parts the service wrote, the
// thread's last messages); last, the generation's number and start, a line
// of the service's. What is quoted came from a model, the owner or a team,
// and carries across generations: it is data, so a heading or an
// instruction in it opens nothing.
//
// Also the effects behind it: the lead's workdir, a fresh clone of the base
// at each generation, and lib/memory in a child process (lib/conf.ts copies
// every CLEARED_* variable into ORCH_* when it is imported). The lead's
// memory is the workspace's level; after it come the first line of each
// other service's page, read in that service's level (decision 25, lane 19),
// or of the page Cleared generates for a service that commits none (issue #394).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LeadCommitment, LeadMessage } from '../api/types.ts';
import { loadFlowConfig } from '../flow/config.ts';
import { ensureExcluded, projectCheckout, ticketBranch, ticketCheckout } from '../workspace/checkout.ts';
import { BriefingError, REFERENCE_LINE, ensureLevel, levelContext, type MemoryEntry } from '../workspace/briefing.ts';
import { forgeEnvironments } from '../workspace/publish.ts';
import { pageSummary, readProjectPage } from '../workspace/project-page.ts';
import { LEAD_TICKET, capAnswer } from './contract.ts';
import { LEAD_RULES } from './prompts.ts';
import type { HandoverRecord } from './store.ts';

export type { MemoryEntry } from '../workspace/briefing.ts';

// What one search of the memory answers.
export type MemoryHit = { readonly id: string; readonly type: string; readonly status: string; readonly content: string };

// The largest parts of a handover record, in bytes: the lead's account and
// the thread's last messages (the newest kept). The commitments are never
// cut; the commit tool keeps their number and length bounded instead.
export const HANDOVER_LIMITS = { summary: 4096, messages: 6144 } as const;

// lib/memory's budget for the lead's part of the briefing, in bytes. The
// services' lines come out of it, each cut to SERVICE_LINE bytes and all of
// them to SERVICE_LINES.
export const MEMORY_BUDGET = 12_000;
export const SERVICE_LINE = 160;
export const SERVICE_LINES = 2_000;

// One piece of data, each line quoted as lib/memory quotes it.
function block(content: string): string {
  const quoted = content.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\n$/, '').split('\n').map((line) => `    | ${line}`).join('\n');
  return `--- BEGIN MEMORY DATA ---\n${quoted}\n--- END MEMORY DATA ---\n`;
}

export function commitmentLine(c: LeadCommitment): string {
  return `- ${c.id}${c.due ? ` (due ${c.due})` : ''}${c.ticket ? ` [${c.ticket}]` : ''}: ${c.text}`;
}

export function messageLine(m: Pick<LeadMessage, 'seq' | 'at' | 'by' | 'text' | 'kind'>): string {
  const who = m.by === 'owner' ? 'owner' : m.by === 'lead' ? 'lead' : 'cleared';
  return `#${m.seq} ${m.at} ${who}${m.kind === 'question' ? ' asked' : ''}: ${m.text}`;
}

// The newest messages whose lines fit in `limit` bytes, in their order.
function lastFitting(messages: readonly Pick<LeadMessage, 'seq' | 'at' | 'by' | 'text' | 'kind'>[], limit: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const message of [...messages].reverse()) {
    const line = messageLine(message);
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > limit) {
      if (kept.length === 0) kept.push(capAnswer(line, limit));
      break;
    }
    kept.unshift(line);
    size += bytes;
  }
  return kept;
}

export type LeadBriefingInput = {
  readonly generation: number;
  readonly at: string;
  readonly commitments: readonly LeadCommitment[];        // the open ones, from the table
  readonly handover: Pick<HandoverRecord, 'id' | 'generation' | 'at' | 'machine' | 'summary' | 'parts' | 'messages'> | null;
  readonly memory: readonly MemoryEntry[];
  readonly memoryError?: string;
};

const MEMORY_HEADINGS: Readonly<Record<string, string>> = {
  project: 'Project', glossary: 'Glossary', lesson: 'Lessons for the lead', decision: 'Decisions', handover: 'Earlier handover in memory',
  services: "The services' pages, first lines",
};

// Ordered from what changes least to what changes most (issue #335, P219):
// the prompt cache serves a prefix only up to its first changed byte, so
// the rules and the memory come first, and the generation's number and the
// time it started come last, not at the head of the briefing.
export function renderLeadBriefing(input: LeadBriefingInput): string {
  let text = `${LEAD_RULES}\n## Your briefing\n\nBelow are the project's memory, your open commitments, the last handover record, then this generation's number and start. When the lead's own account and the structured parts of the record disagree, the structured parts win: the service wrote them from its tables.\n\n${REFERENCE_LINE}\n`;
  text += '\n## Project memory\n';
  if (input.memoryError) text += `The memory could not be read for this generation (${input.memoryError}).\n`;
  else if (input.memory.length === 0) text += 'None.\n';
  else for (const entry of input.memory) text += `\n### ${MEMORY_HEADINGS[entry.type] ?? entry.type}\n${block(entry.content)}`;
  text += `\n## Open commitments\n${input.commitments.length ? block(input.commitments.map(commitmentLine).join('\n')) : 'None.\n'}`;
  const h = input.handover;
  if (!h) text += '\n## Last handover\nNo handover yet: this is the first generation.\n';
  else {
    text += `\n## Last handover\nGeneration ${h.generation} handed over at ${h.at}, ${h.machine ? 'in an account the service wrote: the lead did not write its own' : 'in its own account'}.\n`;
    text += `\n### The lead's account\n${block(capAnswer(h.summary, HANDOVER_LIMITS.summary))}`;
    text += `\n### The structured record\n${block(h.parts)}`;
    const lines = lastFitting(h.messages, HANDOVER_LIMITS.messages);
    text += `\n### The thread's last messages\n${lines.length ? block(lines.join('\n')) : 'None.\n'}`;
  }
  text += `\n## This generation\nYou are generation ${input.generation} of the lead, started at ${input.at}.\n`;
  return text;
}

// ---- lib/memory, in a child process -----------------------------------------

const MEMORY_MODULE = new URL('../../../lib/memory/contract.ts', import.meta.url).href;

// One request on stdin, one JSON answer on stdout. `briefing` is the lead
// role's selection within its budget; `search` the entries that match;
// `page` the committed page of the checkout, or null.
const MEMORY_PROGRAM = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  const { createMemory } = await import(request.module);
  const memory = createMemory();
  try {
    let result = null;
    if (request.command === 'briefing') result = memory.briefing({ role: 'lead', ticket: { id: request.ticket, title: '', body: '' }, budget: request.budget }).entries.map((e) => ({ type: e.type, content: e.content }));
    else if (request.command === 'search') result = memory.search(request.query, { limit: request.limit }).map((e) => ({ id: e.id, type: e.type, status: e.status, content: e.content }));
    else if (request.command === 'page') result = memory.briefing({ role: 'lead', ticket: { id: request.ticket, title: '', body: '' }, budget: 1000000 }).entries.find((e) => e.type === 'project')?.content ?? null;
    else throw new Error('unknown memory command');
    process.stdout.write(JSON.stringify(result));
  } finally { memory.db.close(); }
} catch (error) {
  process.stderr.write(String(error && error.message || error));
  process.exitCode = 1;
}
`;

function runLeadMemory(project: string, env: NodeJS.ProcessEnv, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', MEMORY_PROGRAM], { env: { ...env, CLEARED_REPO: project }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new BriefingError(`memory: ${stderr.trim().slice(0, 300) || `exit ${code}`}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new BriefingError('memory: the answer is not JSON')); }
      }
    });
    child.stdin.end(JSON.stringify({ module: MEMORY_MODULE, ...request }));
  });
}

// ---- the effects ---------------------------------------------------------------

// What the lead engine does outside the process for a generation.
export type LeadEffects = {
  prepareWorkdir(): Promise<string>;                                   // the lead's workdir, a fresh clone of the base
  writeBriefing(workdir: string, text: string): Promise<void>;         // CLAUDE.md in it
  memory(): Promise<readonly MemoryEntry[]>;                           // the lead's memory within MEMORY_BUDGET, the services' lines last
  searchMemory(query: string): Promise<readonly MemoryHit[]>;
};

export type LeadEffectsConfig = {
  readonly projectDir: string;          // the service's checkout of the project
  readonly repoUrl: string;
  readonly base: string;
  readonly workdir: string;             // <workdirs>/lead
  readonly env?: NodeJS.ProcessEnv;
  // The workspace's services, in its order; by default those the
  // environment's workspace names, none when it cannot be read.
  readonly services?: readonly { readonly name: string; readonly dir: string }[];
};

// A service's line: its name and the first line of its page, a heading's
// marks taken off, cut on a character to SERVICE_LINE bytes.
function serviceLine(name: string, page: string): string | null {
  const first = page.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!first) return null;
  let line = `${name}: ${first}`;
  while (Buffer.byteLength(line) > SERVICE_LINE) line = line.slice(0, -1);
  return line;
}

// The lines while they fit in SERVICE_LINES, then how many did not.
function serviceLines(lines: readonly string[]): string[] {
  if (Buffer.byteLength(lines.join('\n')) <= SERVICE_LINES) return [...lines];
  const kept: string[] = [];
  for (const line of lines) {
    if (Buffer.byteLength([...kept, line, `and ${lines.length - kept.length - 1} more services.`].join('\n')) > SERVICE_LINES) break;
    kept.push(line);
  }
  return [...kept, `and ${lines.length - kept.length} more services.`];
}

export function realLeadEffects(config: LeadEffectsConfig): LeadEffects {
  const env = config.env ?? process.env;
  return {
    // The lead edits nothing, so its clone is made again from the base at
    // each generation: what it reads is the base as the forge has it now.
    async prepareWorkdir() {
      const forge = await forgeEnvironments(config.projectDir, env);
      await projectCheckout({ url: config.repoUrl, dir: config.projectDir, base: config.base, env: forge.git });
      rmSync(config.workdir, { recursive: true, force: true });
      await ticketCheckout({ project: config.projectDir, workdir: config.workdir, base: config.base, branch: ticketBranch(LEAD_TICKET) });
      return config.workdir;
    },
    // Written beside it, then renamed over it, as the ticket's briefing is.
    // The clone is the lead's alone and never pushed, so a CLAUDE.md the
    // project commits is replaced there, not refused.
    async writeBriefing(workdir, text) {
      const path = join(workdir, 'CLAUDE.md');
      let present;
      try { present = lstatSync(path); }
      catch { present = undefined; }
      if (present?.isDirectory()) throw new BriefingError(`${path} is a folder`);
      const aside = join(workdir, `.CLAUDE.md.${randomUUID()}`);
      try {
        writeFileSync(aside, text, { flag: 'wx', mode: 0o644 });
        renameSync(aside, path);
      } finally {
        rmSync(aside, { force: true });
      }
      ensureExcluded(workdir);
    },
    // The other services' lines first, since the workspace's memory gets
    // what they leave of the budget. A service whose checkout is the
    // workspace's (the first) has the workspace's page; one whose checkout
    // is not on this server, or whose page cannot be read, has no line.
    async memory() {
      const listed = config.services ?? (() => {
        try { return loadFlowConfig(env)?.workspace?.services ?? []; } catch { return []; }
      })();
      const others = listed.filter((s) => resolve(s.dir) !== resolve(config.projectDir) && existsSync(s.dir));
      // A service that commits no page has the line of the page Cleared
      // generates for it (issue #394), the workspace's own service too.
      const generated = (name: string) => {
        const summary = pageSummary(readProjectPage(env, name) ?? '');
        return summary ? serviceLine(name, summary) : null;
      };
      const own = listed.find((s) => resolve(s.dir) === resolve(config.projectDir));
      const ownLine = own ? generated(own.name) : null;
      const pages = await Promise.all(others.map(async (s) => {
        try {
          const level = levelContext({ project: config.projectDir, env }, { kind: 'service', name: s.name, project: s.dir });
          ensureLevel(level);
          const page = await runLeadMemory(s.dir, { ...env, ...level.env }, { command: 'page', ticket: LEAD_TICKET });
          return (typeof page === 'string' ? serviceLine(s.name, page) : null) ?? generated(s.name);
        } catch { return generated(s.name); }
      }));
      const found = [ownLine, ...pages].filter((line): line is string => line !== null);
      const listedLines = serviceLines(found);
      const entries = await runLeadMemory(config.projectDir, env, { command: 'briefing', ticket: LEAD_TICKET, budget: MEMORY_BUDGET - Buffer.byteLength(listedLines.join('\n')) });
      if (!Array.isArray(entries)) throw new BriefingError('memory: the briefing is not a list of entries');
      // The workspace's committed page is in its memory already.
      const lines = ownLine && entries.some((entry: MemoryEntry) => entry.type === 'project') ? serviceLines(found.slice(1)) : listedLines;
      const text = lines.join('\n');
      return lines.length ? [...entries as MemoryEntry[], { type: 'services', content: text }] : entries as MemoryEntry[];
    },
    async searchMemory(query) {
      const hits = await runLeadMemory(config.projectDir, env, { command: 'search', query, limit: 20 });
      if (!Array.isArray(hits)) throw new BriefingError('memory: the search is not a list of entries');
      return hits as MemoryHit[];
    },
  };
}
