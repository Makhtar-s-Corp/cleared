// An approved knowledge entry written into lib/memory (decision 27, lane 24),
// at the level's memory, in a child Node process as every lib/memory call of
// the service is (workspace/briefing.ts says why).
//
// The entry is written as a proposal, then approved, so lib/memory records
// who approved it (its memory_approved event). lib/memory approves only for
// the verified human owner, whom it asks its tracker for: the service has
// verified the owner already (the app's proof, a signed-in user whose name is
// [tracker] owner_id, knowledge/service.ts), so the child's tracker answers
// that owner, and the settings it compares with name the same owner.
//
// The entry is a `decision`: lib/memory briefs approved decisions that share
// words with the ticket (at most five), and never briefs a lesson row, only
// a committed lessons file. A lesson is therefore written as a decision whose
// text says it is a lesson; the skill keeps the two apart.
import { spawn } from 'node:child_process';
import type { MemoryContext } from '../workspace/briefing.ts';

const MEMORY_MODULE = new URL('../../../lib/memory/contract.mjs', import.meta.url).href;
const CONF_MODULE = new URL('../../../lib/conf.mjs', import.meta.url).href;

const WRITE_PROGRAM = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  const { createMemory } = await import(request.module);
  const { loadConf } = await import(request.conf);
  const conf = loadConf();
  conf.sections.tracker = { ...(conf.sections.tracker || {}), owner_id: request.owner };
  const memory = createMemory({ conf, tracker: { whoAmI: () => ({ kind: 'human', id: request.owner }) } });
  try {
    const id = memory.write({ type: 'decision', scope: request.scope, content: request.content, source_who: 'human:' + request.owner, source_where: request.where });
    memory.approve(id, { ticket: request.ticket });
    process.stdout.write(JSON.stringify({ id }));
  } finally { memory.db.close(); }
} catch (error) {
  process.stderr.write(String(error && error.message || error));
  process.exitCode = 1;
}
`;

export type ApprovedEntry = {
  readonly scope: string;                 // project:<name of the level's checkout>
  readonly content: string;
  readonly where: string;                 // the inbox item it was approved from
  readonly owner: string;                 // [tracker] owner_id, the name of the user who approved it
  readonly ticket: string;                // the ticket whose handover proposed it
};

// Writes the entry, approved, into the memory of `context`; answers its id.
export type MemoryWrite = (context: MemoryContext, entry: ApprovedEntry) => Promise<string>;

export class KnowledgeMemoryError extends Error {
  override name = 'KnowledgeMemoryError';
}

export const writeApproved: MemoryWrite = (context, entry) => {
  const env = { ...process.env, ...context.env, CLEARED_REPO: context.project };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', WRITE_PROGRAM], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new KnowledgeMemoryError(`memory: ${stderr.trim() || `exit ${code}`}`));
      try {
        const { id } = JSON.parse(stdout) as { id?: unknown };
        if (typeof id !== 'string') throw new Error('no id');
        resolve(id);
      } catch {
        reject(new KnowledgeMemoryError('memory: the answer is not an entry id'));
      }
    });
    child.stdin.end(JSON.stringify({ module: MEMORY_MODULE, conf: CONF_MODULE, ...entry }));
  });
};
