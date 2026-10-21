// The capture of HANDOVER.md at the end of a session (milestone 1 plan,
// lane 5): lib/memory's captureHandover, as lib/memory/cli.mjs runs it for
// v1. It stores a file with the five headings as a handover entry of the
// ticket, then removes it from the checkout; it records a missing, linked or
// malformed file as handover_missing, so the next briefing says so, and
// keeps a malformed one aside in the state folder.
import type { Role } from '../session/contract.ts';
import { runMemory, type MemoryContext } from './briefing.ts';

export class HandoverError extends Error {
  override name = 'HandoverError';
}

// Cleared's session ids are UUIDs; lib/memory puts the id in a path.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type HandoverInput = MemoryContext & {
  readonly workdir: string;               // the ticket checkout
  readonly role: Role;
  readonly model: string;
  readonly ticket: string;
  readonly sessionId: string;
};

// The id of the stored entry, or null when there was no valid handover.
export async function captureHandover(input: HandoverInput): Promise<string | null> {
  if (!SESSION_ID.test(input.sessionId)) throw new HandoverError(`"${input.sessionId}" is not a session id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.ticket)) throw new HandoverError(`"${input.ticket}" is not a ticket id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.model)) throw new HandoverError(`"${input.model}" is not a model name`);
  const id = await runMemory(input, {
    command: 'capture',
    handover: { worktree: input.workdir, role: input.role, model: input.model, ticket: input.ticket, runId: input.sessionId },
  });
  if (id !== null && typeof id !== 'string') throw new HandoverError('memory: the capture did not answer an entry id');
  return id;
}
