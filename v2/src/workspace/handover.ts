// The capture of HANDOVER.md at the end of a session (milestone 1 plan,
// lane 5): lib/memory's captureHandover, as lib/memory/cli.mjs runs it for
// v1. It stores a file with the five headings as a handover entry of the
// ticket, then removes it from the checkout; it records a missing, linked or
// malformed file as handover_missing, so the next briefing says so, and
// keeps a malformed one aside in the state folder.
//
// The handover's lessons are filed by level (milestone 2 plan, decision 25,
// lane 19): each `## Lessons for the ...` section of the stored handover is
// written as a lesson of the author's role in that level's memory, as a
// proposal, which lib/memory never briefs; a level the session has not, and
// lessons under no level, go to the workspace's.
import type { Role } from '../session/contract.ts';
import { LESSON_HEADINGS, ensureLevel, runMemory, type MemoryContext, type MemoryLevel } from './briefing.ts';

export { LESSON_HEADINGS } from './briefing.ts';

export class HandoverError extends Error {
  override name = 'HandoverError';
}

// Cleared's session ids are UUIDs; lib/memory puts the id in a path.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Lessons = { readonly workspace: readonly string[]; readonly service: readonly string[]; readonly contract: readonly string[] };

type Level = keyof typeof LESSON_HEADINGS;
const LEVELS = Object.keys(LESSON_HEADINGS) as Level[];

// The lessons sections of a handover. A heading counts at the start of a
// line and outside a fenced code block, as the line it is; a section runs to
// the next level-two heading. An empty section files nothing.
export function lessonsOf(text: string): Lessons {
  const out: Record<Level, string[]> = { workspace: [], service: [], contract: [] };
  let current: Level | null = null;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (current && body) out[current].push(body);
    current = null;
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!fenced && line.startsWith('## ')) {
      flush();
      current = LEVELS.find((level) => line.trimEnd() === LESSON_HEADINGS[level]) ?? null;
      continue;
    }
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (current) lines.push(line);
  }
  flush();
  return out;
}

export type HandoverInput = MemoryContext & {
  readonly workdir: string;               // the ticket checkout
  readonly role: Role;
  readonly model: string;
  readonly ticket: string;
  readonly sessionId: string;
  readonly service?: MemoryLevel;         // where `## Lessons for the service` goes
  readonly contract?: MemoryLevel;        // where `## Lessons for the contract` goes
};

// The id of the stored entry, or null when there was no valid handover.
export async function captureHandover(input: HandoverInput): Promise<string | null> {
  if (!SESSION_ID.test(input.sessionId)) throw new HandoverError(`"${input.sessionId}" is not a session id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.ticket)) throw new HandoverError(`"${input.ticket}" is not a ticket id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.model)) throw new HandoverError(`"${input.model}" is not a model name`);
  const workspace: MemoryContext = { project: input.project, ...(input.env === undefined ? {} : { env: input.env }) };
  const answer = await runMemory(workspace, {
    command: 'capture',
    handover: { worktree: input.workdir, role: input.role, model: input.model, ticket: input.ticket, runId: input.sessionId },
  }) as { id?: unknown; content?: unknown } | null;
  const id = answer?.id ?? null;
  if (id !== null && typeof id !== 'string') throw new HandoverError('memory: the capture did not answer an entry id');
  if (id === null || typeof answer?.content !== 'string') return id;

  // Taken from the entry lib/memory stored, never from a second read of the file.
  const lessons = lessonsOf(answer.content);
  const targets: [Level, MemoryContext | MemoryLevel][] = [['workspace', workspace], ['service', input.service ?? workspace], ['contract', input.contract ?? workspace]];
  const failed: string[] = [];
  for (const [level, context] of targets) {
    for (const content of lessons[level]) {
      try {
        if ('kind' in context) ensureLevel(context as MemoryLevel);
        await runMemory(context, {
          command: 'lesson',
          entry: { type: 'lesson', scope: `role:${input.role}`, content, source_who: `agent:${input.role}/${input.model}`, source_where: `session:${input.sessionId}` },
        });
      } catch {
        failed.push('kind' in context ? `the ${(context as MemoryLevel).kind} ${(context as MemoryLevel).name}` : 'the workspace');
      }
    }
  }
  if (failed.length) throw new HandoverError(`the handover is stored, but lessons could not be filed in the memory of ${[...new Set(failed)].join(', ')}`);
  return id;
}
