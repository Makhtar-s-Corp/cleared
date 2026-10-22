// The handlers of the lead's host tools (docs/v2/milestone-2-plan.md,
// section 3.2), all but propose_plan and start_ticket, which lane 7
// registers in modules/lead.ts (LeadExtensions.tools). Each one checks what
// the lead may do and refuses with HostToolRefused, whose message is what
// the model reads; the adapter journals every call as cleared.host_call.
// The reading tools answer cleaned text; bindLeadTools cuts it at its cap.
import type { SessionDetail } from '../api/types.ts';
import type { InboxStore } from '../inbox/store.ts';
import { HostToolRefused, type SessionId, type UserId } from '../session/contract.ts';
import { readToolInput, type SessionEvent } from '../session/events.ts';
import type { MemoryHit } from './briefing.ts';
import type { LeadHandlers, LeadToolInput } from './contract.ts';
import type { LeadStore } from './store.ts';
import type { LeadFlow } from './engine.ts';

// What the handlers need of the engine.
export type LeadToolHost = {
  readonly flow: LeadFlow;
  readonly store: LeadStore;
  readonly inbox: InboxStore;
  searchMemory(query: string): Promise<readonly MemoryHit[]>;
  clean(text: string): string;
  generation(): number;
  turnKind(): 'opening' | 'owner' | 'service' | 'event' | 'handover' | undefined;
  compactState(): string;
  acceptHandover(summary: string): string;                     // the handover's id; throws HostToolRefused after the first
  tellOwner(text: string): number;                             // the thread seq
};

export const MAX_OPEN_COMMITMENTS = 20;
export const MAX_COMMITMENT_CHARS = 300;
const MAX_TEXT = 20_000;
const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing']);

const refuse = (message: string): never => { throw new HostToolRefused(message); };

// A text field of the model's input: the SDK checked the schema, the
// handler still checks what it needs.
function field(input: unknown, key: string, what: string, required = true): string | undefined {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  if (value === undefined || value === null || value === '') {
    if (required) refuse(`Give ${what}.`);
    return undefined;
  }
  if (typeof value !== 'string') return refuse(`${what} is text.`);
  if (value.length > MAX_TEXT) return refuse(`${what} is at most ${MAX_TEXT} characters.`);
  return value;
}

// A session of a team: an author or a reviewer, never the lead itself.
function teamSession(host: LeadToolHost, id: SessionId): SessionDetail {
  const detail = host.flow.sessionDetail(id);
  if (!detail) return refuse(`There is no session ${id}: unknown session.`);
  if (detail.role === 'lead') return refuse('That is a session of the lead, not a team\'s: these tools act on a team\'s session.');
  return detail;
}

// One line of a session's timeline: what it said, read, edited, ran or
// asked, without any output.
function timeline(events: readonly SessionEvent[]): string[] {
  const roles = new Map<string, string>();
  const tools = new Map<string, string>();
  const lines: string[] = [];
  const short = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}...` : text).replace(/\s+/g, ' ');
  for (const { at, event } of events) {
    const when = at.slice(11, 16);
    switch (event.type) {
      case 'TEXT_MESSAGE_START': roles.set(event.messageId, event.role === 'user' ? `${event.name ?? 'cleared'} wrote` : 'said'); break;
      case 'TEXT_MESSAGE_CONTENT': lines.push(`${when} ${roles.get(event.messageId) ?? 'said'}: ${short(event.delta)}`); break;
      case 'TOOL_CALL_START': tools.set(event.toolCallId, event.toolCallName); break;
      case 'TOOL_CALL_ARGS': {
        const input = readToolInput(event);
        const name = tools.get(event.toolCallId) ?? 'a tool';
        const phrase = !input ? `called ${name}`
          : input.kind === 'read' ? `read ${input.path}`
          : input.kind === 'edit' ? `edited ${input.path} (+${input.added} -${input.removed})`
          : input.kind === 'delete' || input.kind === 'move' ? `${input.kind}d ${input.path}`
          : input.kind === 'execute' ? `ran ${short(input.command)}`
          : input.kind === 'search' ? `searched ${short(input.pattern)}`
          : input.kind === 'fetch' ? `fetched ${short(input.target)}`
          : `called ${name}`;
        lines.push(`${when} ${phrase}`);
        break;
      }
      case 'CUSTOM':
        if (event.name === 'cleared.permission_request') lines.push(`${when} asked a permission for ${event.value.tool} (request ${event.value.requestId})`);
        else if (event.name === 'cleared.question') lines.push(`${when} asked a question (request ${event.value.requestId}): ${short(event.value.questions.map((q) => q.question).join(' / '))}`);
        else if (event.name === 'cleared.permission_answered' || event.name === 'cleared.answered') lines.push(`${when} request ${event.value.requestId} answered by ${event.value.by}`);
        else if (event.name === 'cleared.review_verdict') lines.push(`${when} review verdict: ${event.value.verdict}`);
        break;
      case 'RUN_FINISHED': lines.push(`${when} turn ended (${event.result.stopReason})`); break;
      case 'RUN_ERROR': lines.push(`${when} failed: ${short(event.message)}`); break;
      default: break;
    }
  }
  return lines;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function leadHandlers(host: LeadToolHost): LeadHandlers {
  return {
    async state() {
      return host.compactState();
    },

    async ticket(input) {
      const id = field(input, 'id', 'the ticket id') as string;
      const tickets = host.flow.registry.ticketStore;
      const ticket = await tickets.get(id);
      if (!ticket) return refuse(`There is no ticket ${id}: unknown ticket.`);
      const comments = (await tickets.comments(id)).slice(-5);
      const text = [
        `${ticket.id}: ${ticket.title}`,
        `Status: ${ticket.status}`,
        ...(ticket.labels.length ? [`Labels: ${ticket.labels.join(', ')}`] : []),
        '',
        ticket.body || '(no description)',
        '',
        comments.length ? 'Last comments:' : 'No comment.',
        ...comments.map((c) => `- ${c.createdAt} ${c.by.kind === 'human' ? c.by.id : 'cleared'}: ${c.body}`),
      ].join('\n');
      return host.clean(text);
    },

    async session(input) {
      const id = field(input, 'id', 'the session id') as string;
      const detail = host.flow.sessionDetail(id);
      if (!detail) return refuse(`There is no session ${id}: unknown session.`);
      const lines = timeline(host.flow.eventsAfter(id)).slice(-20);
      return host.clean([
        `Session ${detail.id}: ${detail.role} of ${detail.ticket}, ${detail.model}, ${detail.phase}: ${detail.status}`,
        `Started ${detail.startedAt}, last event ${detail.updatedAt}.`,
        'Last lines of its timeline:',
        ...lines.map((line) => `- ${line}`),
      ].join('\n'));
    },

    async search_memory(input) {
      const query = (field(input, 'query', 'words to search for') as string).trim();
      if (!query) return refuse('Give words to search for.');
      const hits = await host.searchMemory(query);
      const rank = (hit: MemoryHit) => (hit.type === 'decision' ? 0 : hit.type === 'glossary' ? 1 : 2);
      const kept = hits.filter((hit) => (hit.type === 'decision' && hit.status === 'approved') || hit.type === 'glossary' || hit.type === 'lesson')
        .map((hit, i) => ({ hit, i })).sort((a, b) => rank(a.hit) - rank(b.hit) || a.i - b.i).map(({ hit }) => hit);
      if (kept.length === 0) return `Nothing in the memory matches "${query}".`;
      return host.clean(kept.map((hit) => `[${hit.id}] (${hit.type})\n${hit.content}`).join('\n\n'));
    },

    async stop_session(input) {
      const id = field(input, 'id', 'the session id') as string;
      const reason = field(input, 'reason', 'the reason') as string;
      const detail = teamSession(host, id);
      if (!LIVE_PHASES.has(detail.phase)) return refuse(`Session ${id} is not running (${detail.phase}).`);
      const stop = host.flow.stopSession;
      if (!stop) return refuse('Cleared cannot stop a session from the lead yet: tell the owner, who can stop it from the session screen.');
      await stop(id, host.clean(reason), 'lead');
      return { stopped: id };
    },

    async message_session(input) {
      const id = field(input, 'id', 'the session id') as string;
      const text = field(input, 'text', 'the message') as string;
      teamSession(host, id);
      try {
        await host.flow.send(id, text, 'lead' as UserId);
      } catch (error) {
        return refuse(`The message was not sent: ${host.clean(error instanceof Error ? error.message : String(error))}`);
      }
      return { sent: true };
    },

    async answer_question(input) {
      const session = field(input, 'session', 'the session id') as string;
      const requestId = field(input, 'requestId', 'the request id') as string;
      teamSession(host, session);
      const item = host.inbox.find(session, requestId);
      if (item?.kind === 'permission') return refuse('That is a permission request: it waits for the owner, who alone answers permissions.');
      if (!item || item.kind !== 'question' || item.state !== 'waiting') return refuse(`There is no question ${requestId} waiting in session ${session}.`);
      const given = (input as Partial<LeadToolInput['answer_question']>).answers;
      if (!Array.isArray(given) || given.length === 0) return refuse('Give one answer per question asked.');
      const asked = new Set(item.questions.map((q) => q.question));
      const answers: Record<string, string> = {};
      for (const entry of given) {
        const question = field(entry, 'question', 'the question') as string;
        const answer = field(entry, 'answer', 'the answer') as string;
        if (!asked.has(question)) return refuse(`"${question}" is not a question this request asked. It asked: ${[...asked].map((q) => `"${q}"`).join(', ')}.`);
        answers[question] = answer;
      }
      try {
        await host.flow.answer(session, requestId, { kind: 'answer', answers }, 'lead' as UserId);
      } catch (error) {
        return refuse(`The answer was not given: ${host.clean(error instanceof Error ? error.message : String(error))}`);
      }
      return { answered: item.id };
    },

    async commit(input) {
      const text = (field(input, 'text', 'what you will do') as string).trim();
      if (!text) return refuse('The commitment is empty.');
      if (text.length > MAX_COMMITMENT_CHARS) return refuse(`A commitment is one sentence of at most ${MAX_COMMITMENT_CHARS} characters.`);
      const ticket = field(input, 'ticket', 'the ticket id', false)?.trim() || null;
      const dueText = field(input, 'due', 'the due time', false)?.trim();
      let due: string | null = null;
      if (dueText) {
        const at = Date.parse(dueText);
        if (!ISO.test(dueText) || Number.isNaN(at)) return refuse(`due must be an ISO 8601 time with its offset, such as 2026-10-23T08:00:00+02:00, not "${dueText}".`);
        due = new Date(at).toISOString();
      }
      if (host.store.openCommitments().length >= MAX_OPEN_COMMITMENTS) return refuse(`You have ${MAX_OPEN_COMMITMENTS} open commitments: fulfil one before you make another.`);
      const commitment = host.store.commit({ text: host.clean(text), ticket, due, generation: host.generation() });
      return { id: commitment.id };
    },

    async fulfil(input) {
      const id = field(input, 'id', 'the commitment id') as string;
      const note = field(input, 'note', 'what was done') as string;
      const done = host.store.fulfil(id.trim(), host.clean(note));
      if (!done) return refuse(`${id} is not open: no open commitment has this id.`);
      return { id: done.id, state: 'done' };
    },

    async tell_owner(input) {
      const text = (field(input, 'text', 'the message') as string).trim();
      if (!text) return refuse('The message is empty.');
      if (host.turnKind() === 'owner' || host.turnKind() === 'service') return refuse('In a turn the owner started, your reply is the message: tell_owner is for the turns Cleared starts.');
      return { seq: host.tellOwner(text) };
    },

    async handover(input) {
      const summary = field(input, 'summary', 'your account') as string;
      return { id: host.acceptHandover(summary) };
    },
  };
}
