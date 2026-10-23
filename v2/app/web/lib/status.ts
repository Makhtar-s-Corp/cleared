// A session's status and a ticket's state in the person's language (the
// owner's request of 2026-10-23, lane durations): the service writes a
// session's status as an English phrase ("Stopped", "Reading src/page.ts",
// src/flow/state.ts) and a ticket's state by the tracker's name ("Todo").
// A phase says its own word; the four phrases the service builds for a
// tool are translated by their shape; what the harness wrote of its own
// ("Writing a test for a timeout") is data and stays as written. A ticket
// state of the tracker's defaults (src/tickets/contract.ts, DEFAULT_STATES)
// says its word; a state a workspace named itself stays as named. The
// words are the shell's, which every screen's translator holds.
import type { ApiSessionPhase } from '../../../src/api/types.ts';
import type { Translate } from './i18n.ts';
import { looksLikeCommand } from './intent.ts';

const PHASE_KEY: Readonly<Record<ApiSessionPhase, string>> = {
  starting: 'status_starting', working: 'status_working', waiting_human: 'status_waiting_human', reviewing: 'status_reviewing',
  done: 'status_done', stopped: 'status_stopped', failed: 'status_failed', paused: 'status_paused',
};

// The service's phrases for a tool (src/flow/state.ts, toolPhrase), by
// their English prefix and what follows it: a path, a pattern, a command.
// A harness's own sentence that starts the same ("Reading the diff of...")
// is not one of them.
const TOOL_PHRASES: readonly (readonly [string, string, (rest: string) => boolean])[] = [
  ['Reading ', 'status_reading', (rest) => !/\s/.test(rest)],
  ['Editing ', 'status_editing', (rest) => !/\s/.test(rest)],
  ['Searching for ', 'status_searching', (rest) => rest !== ''],
  ['Running ', 'status_running', looksLikeCommand],
];

// The service's own word for each phase (src/flow/state.ts, PHRASES), which the phase says instead.
const PHASE_WORDS = new Set(['Starting', 'Working', 'Paused, waiting for you', 'Reviewing', 'Done', 'Stopped', 'Failed', 'Paused']);

export function sessionStatus(session: { readonly phase: ApiSessionPhase; readonly status: string }, t: Translate): string {
  const { phase, status } = session;
  if (phase !== 'working' && phase !== 'reviewing') return t(PHASE_KEY[phase]);
  if (status === '' || PHASE_WORDS.has(status)) return t(PHASE_KEY[phase]);
  for (const [prefix, key, fits] of TOOL_PHRASES) {
    const rest = status.slice(prefix.length);
    if (status.startsWith(prefix) && fits(rest)) return t(key, { text: rest });
  }
  return status;
}

const TICKET_KEY: Readonly<Record<string, string>> = {
  Todo: 'ticket_state_todo', 'In Progress': 'ticket_state_progress', 'In Review': 'ticket_state_review',
  'Needs Approval': 'ticket_state_validate', 'Ready to Ship': 'ticket_state_go', Done: 'ticket_state_done',
};

export function ticketState(state: string, t: Translate): string {
  return Object.hasOwn(TICKET_KEY, state) ? t(TICKET_KEY[state] as string) : state;
}
