// What the plan tests share: a done ticket with the sessions and events the
// estimates read, and a recording stand-in for the lead.
import type { Plan } from '../../../src/api/types.ts';
import type { PlanLead } from '../../../src/lead/plans/runner.ts';
import type { AgUiEvent } from '../../../src/session/events.ts';
import type { Store } from '../../../src/store/db.ts';
import type { TicketStore } from '../../../src/tickets/contract.ts';

let sessions = 0;
const START = Date.parse('2026-10-01T09:00:00.000Z');

// A ticket of the project that went from its author's first turn to its
// release request in `minutes`, `waitMinutes` of which waited for the
// owner, at a total cost of `costUsd`, then to `status` (Done by default).
export async function doneTicket(store: Store, tickets: TicketStore, input: {
  readonly size: string; readonly lane?: 'fast' | 'full'; readonly minutes: number; readonly waitMinutes?: number; readonly costUsd: number;
  readonly status?: string; readonly project?: string;
}): Promise<string> {
  const project = input.project ?? 'guestbook';
  const labels = [`size:${input.size}`, ...(input.lane === 'fast' ? ['Quick'] : [])];
  const ticket = await tickets.create({ title: `A ${input.size} change`, labels, project }, { kind: 'agents', id: 'cleared-v2' });
  await tickets.move(ticket.id, input.status ?? 'Done', { kind: 'agents', id: 'cleared-v2' });
  const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
  const author = `history-${++sessions}`;
  const reviewer = `history-${++sessions}`;
  const wait = input.waitMinutes ?? 0;
  const write = (sessionId: string, minutes: number, event: AgUiEvent) => store.events.append({ at: at(minutes), sessionId, ticket: ticket.id, project, event });
  const finished = (cost: number): AgUiEvent => ({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: cost } });
  for (const [id, role] of [[author, 'author'], [reviewer, 'reviewer']] as const)
    store.sessions.put({ id, project, ticket: ticket.id, role, harness: 'claude-code', model: 'claude-opus-5-5', status: 'done', createdAt: at(0), updatedAt: at(input.minutes) });
  write(author, 0, { type: 'RUN_STARTED', threadId: 't', runId: 'r' });
  if (wait > 0) {
    write(author, 1, { type: 'STEP_STARTED', stepName: 'waiting_human' });
    write(author, 1 + wait, { type: 'STEP_FINISHED', stepName: 'waiting_human' });
  }
  write(author, input.minutes / 2, finished(input.costUsd / 2));
  write(reviewer, input.minutes / 2, { type: 'RUN_STARTED', threadId: 't', runId: 'r' });
  write(reviewer, input.minutes / 2 + 0.5, finished(input.costUsd / 2));
  write(reviewer, input.minutes, { type: 'STEP_FINISHED', stepName: 'release' });
  // The approval comes after the release request: it is not counted.
  write(reviewer, input.minutes, { type: 'STEP_STARTED', stepName: 'approval' });
  write(reviewer, input.minutes + 600, { type: 'STEP_FINISHED', stepName: 'approval' });
  return ticket.id;
}

// The lead as the plans use it, recording what it is told.
export function recordingLead() {
  const lead = {
    events: [] as { text: string; urgent: boolean }[],
    lines: [] as string[],
    planLines: [] as { planId: string; text: string }[],
    frames: [] as Plan[],
    enqueue(text: string, urgent = false) { lead.events.push({ text, urgent }); },
    serviceLine(text: string) { lead.lines.push(text); },
    planLine(planId: string, text: string) { lead.planLines.push({ planId, text }); },
    publishPlan(plan: Plan) { lead.frames.push(plan); },
  };
  return lead satisfies PlanLead;
}
