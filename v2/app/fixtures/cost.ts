// A resolved ticket's sessions (P211, issue #327): the tower's landed ticket
// LOCAL-149 with its author's turn and its reviewer's, stored through the
// cleaner in a ledger of their own, so the session screen of a Done ticket
// draws the cost the service's own ticketCost reads from them. Its figures
// are invented: no name, no path, no figure of a real account. The fixture
// source adds it on request only (`resolved`), so the screens and counts
// the other tests pin stay as they are.
import type { SessionSummary } from '../../src/api/types.ts';
import type { AgUiEvent } from '../../src/session/events.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { Player } from './session.ts';

export const RESOLVED_TICKET = 'LOCAL-149';
export const RESOLVED_AUTHOR_ID = 'fixture-149-author';
export const RESOLVED_REVIEWER_ID = 'fixture-149-review';

const MINUTE = 60_000;

const said = (messageId: string, delta: string): AgUiEvent[] => [
  { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
  { type: 'TEXT_MESSAGE_END', messageId },
];
const snapshot = (status: string, step: 'author' | 'review', startedAt: Date, finishedAt: Date | null, usage: Record<string, number | string>): AgUiEvent =>
  ({ type: 'STATE_SNAPSHOT', snapshot: { status, phase: finishedAt ? 'done' : 'working', steps: [{ name: step, startedAt: startedAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null }], files: [], checks: [], usage } });
const finished = (threadId: string, usage: Record<string, number | string>, cost: number): AgUiEvent =>
  ({ type: 'RUN_FINISHED', threadId, runId: 'turn-1', outcome: { type: 'success' }, usage: [usage], result: { stopReason: 'end_turn', total_cost_usd: cost } } as AgUiEvent);

// The author's one turn, 24 minutes; the reviewer's, 8 minutes, from 30 minutes after the author's start.
// Their rows in the sessions table too, through which the service finds a ticket's sessions.
export function resolvedStory(ticket: Ticket): { readonly store: Store; readonly sessions: readonly SessionSummary[] } {
  const store = openStore(':memory:');
  const project = ticket.project ?? 'guestbook';
  const start = new Date(Date.parse(ticket.createdAt) + 4 * MINUTE);
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const authorUsage = { model: 'claude-opus-5-5', inputTokens: 21_800, outputTokens: 2_900, cachedInputTokens: 140_000, cacheWriteInputTokens: 6_000 };
  const reviewerUsage = { model: 'claude-sonnet-5-5', inputTokens: 9_000, outputTokens: 1_200, cachedInputTokens: 52_000 };

  const author = new Player(store, RESOLVED_AUTHOR_ID, RESOLVED_TICKET, project);
  author.play(start,
    { type: 'STEP_STARTED', stepName: 'author' },
    { type: 'RUN_STARTED', threadId: RESOLVED_AUTHOR_ID, runId: 'turn-1' },
    snapshot('Reading the figures cache', 'author', start, null, authorUsage),
  );
  author.play(at(24),
    said('resolved-said-1', 'Two reads that cross now keep the newer figure: the cache compares the version before it writes. A test covers the crossing.'),
    finished(RESOLVED_AUTHOR_ID, authorUsage, 0.84),
    { type: 'STEP_FINISHED', stepName: 'author' },
    snapshot('Done', 'author', start, at(24), authorUsage),
  );

  const reviewer = new Player(store, RESOLVED_REVIEWER_ID, RESOLVED_TICKET, project);
  reviewer.play(at(30),
    { type: 'STEP_STARTED', stepName: 'review' },
    { type: 'RUN_STARTED', threadId: RESOLVED_REVIEWER_ID, runId: 'turn-1' },
    snapshot('Reading the change', 'review', at(30), null, reviewerUsage),
  );
  reviewer.play(at(38),
    said('resolved-said-2', 'Approved: the change keeps the newer figure, and its test fails on the code before it.'),
    finished(RESOLVED_REVIEWER_ID, reviewerUsage, 0.19),
    { type: 'STEP_FINISHED', stepName: 'review' },
    snapshot('Done', 'review', at(30), at(38), reviewerUsage),
  );

  const summary = (id: string, role: 'author' | 'reviewer', model: string, from: Date, to: Date): SessionSummary => {
    store.sessions.put({ id, project, ticket: RESOLVED_TICKET, role, harness: 'claude-code', model, status: 'done', createdAt: from.toISOString(), updatedAt: to.toISOString() });
    return {
      id, project, ticket: RESOLVED_TICKET, role, harness: 'claude-code', model, phase: 'done', status: 'Done',
      startedAt: from.toISOString(), updatedAt: to.toISOString(), lastSeq: store.events.after(id).at(-1)?.seq ?? 0,
    };
  };
  return {
    store,
    sessions: [summary(RESOLVED_AUTHOR_ID, 'author', 'claude-opus-5-5', start, at(24)), summary(RESOLVED_REVIEWER_ID, 'reviewer', 'claude-sonnet-5-5', at(30), at(38))],
  };
}
