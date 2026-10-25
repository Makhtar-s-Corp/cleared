// The capture of HANDOVER.md at the end of a session (milestone 1 plan,
// lane 5): lib/memory's captureHandover, as lib/memory/cli.ts runs it for
// v1. It stores a file with the five headings as a handover entry of the
// ticket, then removes it from the checkout; it records a missing, linked or
// malformed file as handover_missing, so the next briefing says so, and
// keeps a malformed one aside in the state folder.
//
// The handover's lessons are filed by level (milestone 2 plan, decision 25,
// lane 19): each `## Lessons for the ...` section of the stored handover is
// written as a lesson of the author's role in that level's memory, as a
// proposal, which lib/memory never briefs; a level the session has not goes
// to the workspace's. A lesson that cannot be filed is logged by its level:
// the handover is stored all the same, and the capture answers its id.
//
// Its knowledge is proposed in the inbox (decision 27, lane 24): once stored,
// the handover is given to the sink the knowledge module sets, which turns
// its lessons and decisions into `knowledge` items. A sink that fails is
// logged, and the capture still answers the handover's id.
import type { Role } from '../session/contract.ts';
import { LESSON_HEADINGS, ensureLevel, runMemory, type MemoryContext, type MemoryLevel } from './briefing.ts';

export { DECISION_HEADINGS, LESSON_HEADINGS } from './briefing.ts';

export class HandoverError extends Error {
  override name = 'HandoverError';
}

// Cleared's session ids are UUIDs; lib/memory puts the id in a path.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Lessons = { readonly workspace: readonly string[]; readonly service: readonly string[]; readonly contract: readonly string[] };

type Level = keyof typeof LESSON_HEADINGS;
const LEVELS = Object.keys(LESSON_HEADINGS) as Level[];

// A fence opens on three or more backticks or tildes, indented by at most
// three spaces, and is closed only by a line of the same character, at least
// as long, with nothing after it (issue 206, item 6).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type Section = { readonly heading: string; readonly body: string };

// The level-two sections of a handover, in order: a heading counts at the
// start of a line and outside a fenced code block, as the line it is; a
// section runs to the next level-two heading. Text before the first heading
// is no section.
export function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence === null && line.startsWith('## ')) {
      if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
      current = { heading: line.trimEnd(), lines: [] };
      continue;
    }
    const match = FENCE.exec(line);
    if (match) {
      const run = match[1] as string;
      if (fence === null) { if (!(run[0] === '`' && (match[2] as string).includes('`'))) fence = run; }
      else if (run[0] === fence[0] && run.length >= fence.length && (match[2] as string).trim() === '') fence = null;
    }
    current?.lines.push(line);
  }
  if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
  return out;
}

// The lessons sections of a handover. An empty section files nothing.
export function lessonsOf(text: string): Lessons {
  const out: Record<Level, string[]> = { workspace: [], service: [], contract: [] };
  for (const section of sectionsOf(text)) {
    const level = LEVELS.find((candidate) => section.heading === LESSON_HEADINGS[candidate]);
    const body = section.body.trim();
    if (level && body) out[level].push(body);
  }
  return out;
}

// What the knowledge module is given of a stored handover: the entry
// lib/memory stored, and the service and the contract the session's lessons
// are filed for, when it has them (their memory level's name).
export type CapturedHandover = {
  readonly ticket: string;
  readonly sessionId: string;
  readonly content: string;
  readonly service?: string;
  readonly contract?: string;
};

export type HandoverSink = (handover: CapturedHandover) => void | Promise<void>;

let sink: HandoverSink | undefined;

// The knowledge module's sink, set when it starts; undefined removes it.
export function setHandoverSink(next: HandoverSink | undefined): void {
  sink = next;
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
  // The same lesson filed twice in one ledger is filed once (issue 206, item 7).
  const filed = new Map<MemoryContext | MemoryLevel, Set<string>>();
  for (const [level, context] of targets) {
    for (const content of lessons[level]) {
      const seen = filed.get(context) ?? new Set<string>();
      filed.set(context, seen);
      if (seen.has(content)) continue;
      seen.add(content);
      try {
        if ('kind' in context) ensureLevel(context as MemoryLevel);
        await runMemory(context, {
          command: 'lesson',
          entry: { type: 'lesson', scope: `role:${input.role}`, content, source_who: `agent:${input.role}/${input.model}`, source_where: `session:${input.sessionId}` },
        });
      } catch (error) {
        const where = 'kind' in context ? `the ${(context as MemoryLevel).kind} ${(context as MemoryLevel).name}` : 'the workspace';
        console.error(`cleared-v2: a lesson of ${input.ticket} could not be filed in the memory of ${where} (${error instanceof Error ? error.name : typeof error})`);
      }
    }
  }
  if (sink) {
    try {
      await sink({
        ticket: input.ticket, sessionId: input.sessionId, content: answer.content,
        ...(input.service ? { service: input.service.name } : {}), ...(input.contract ? { contract: input.contract.name } : {}),
      });
    } catch (error) {
      console.error(`cleared-v2: the knowledge of ${input.ticket}'s handover could not be proposed (${error instanceof Error ? error.name : typeof error})`);
    }
  }
  return id;
}
