// The briefing of a lead generation (docs/v2/milestone-2-plan.md, section
// 4.2), written as CLAUDE.md in the lead's workdir, which the runner appends
// to the system prompt: the lead's rules first, as the only instructions;
// then, under lib/memory's reference line and quoted line by line, the open
// commitments from the table, the last handover record (the lead's account,
// the structured parts the service wrote, the thread's last messages) and
// the lead's memory. Everything below the line came from a model, the owner
// or a team, and carries across generations: it is data, so a heading or an
// instruction in it opens nothing.
//
// Also the effects behind it: the lead's workdir, a fresh clone of the base
// at each generation, and lib/memory in a child process (lib/conf.mjs copies
// every CLEARED_* variable into ORCH_* when it is imported).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeadCommitment, LeadMessage } from '../api/types.ts';
import { ensureExcluded, projectCheckout, ticketBranch, ticketCheckout } from '../workspace/checkout.ts';
import { BriefingError, REFERENCE_LINE, type MemoryEntry } from '../workspace/briefing.ts';
import { forgeEnvironments } from '../workspace/publish.ts';
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

// lib/memory's budget for the lead's part of the briefing, in bytes.
export const MEMORY_BUDGET = 12_000;

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

const MEMORY_HEADINGS: Readonly<Record<string, string>> = { project: 'Project', glossary: 'Glossary', lesson: 'Lessons for the lead', decision: 'Decisions', handover: 'Earlier handover in memory' };

export function renderLeadBriefing(input: LeadBriefingInput): string {
  let text = `${LEAD_RULES}\n## This generation\n\nYou are generation ${input.generation} of the lead, started at ${input.at}. Below are your open commitments, the last handover record and the project's memory. When the lead's own account and the structured parts of the record disagree, the structured parts win: the service wrote them from its tables.\n\n${REFERENCE_LINE}\n`;
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
  text += '\n## Project memory\n';
  if (input.memoryError) text += `The memory could not be read for this generation (${input.memoryError}).\n`;
  else if (input.memory.length === 0) text += 'None.\n';
  else for (const entry of input.memory) text += `\n### ${MEMORY_HEADINGS[entry.type] ?? entry.type}\n${block(entry.content)}`;
  return text;
}

// ---- lib/memory, in a child process -----------------------------------------

const MEMORY_MODULE = new URL('../../../lib/memory/contract.mjs', import.meta.url).href;

// One request on stdin, one JSON answer on stdout. `briefing` is the lead
// role's selection within its budget; `search` the entries that match.
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
  memory(): Promise<readonly MemoryEntry[]>;                           // the lead's memory within MEMORY_BUDGET
  searchMemory(query: string): Promise<readonly MemoryHit[]>;
};

export type LeadEffectsConfig = {
  readonly projectDir: string;          // the service's checkout of the project
  readonly repoUrl: string;
  readonly base: string;
  readonly workdir: string;             // <workdirs>/lead
  readonly env?: NodeJS.ProcessEnv;
};

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
    async memory() {
      const entries = await runLeadMemory(config.projectDir, env, { command: 'briefing', ticket: LEAD_TICKET, budget: MEMORY_BUDGET });
      if (!Array.isArray(entries)) throw new BriefingError('memory: the briefing is not a list of entries');
      return entries as MemoryEntry[];
    },
    async searchMemory(query) {
      const hits = await runLeadMemory(config.projectDir, env, { command: 'search', query, limit: 20 });
      if (!Array.isArray(hits)) throw new BriefingError('memory: the search is not a list of entries');
      return hits as MemoryHit[];
    },
  };
}
