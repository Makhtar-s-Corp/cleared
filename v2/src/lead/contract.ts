// The lead's host tools (docs/v2/milestone-2-plan.md, section 3.2) as data:
// each tool's name, description and input schema, which the runner (lane 4)
// gives the model as mcp__cleared__<name>, and the TypeScript types of the
// inputs and outputs that the engine (lane 5) and the plans (lane 7)
// implement by name. A tool added later is a line here and a handler in its
// owner's file (section 10). Imports are type-only, so this file loads
// anywhere without the rest of the service.
import type { Plan } from '../api/types.ts';
import type { HostCallContext, HostTool, JsonSchema, SessionId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';

// The ticket of a lead session and of the inbox items the lead raises (a
// plan, a question): a word the ticket branch rule accepts, and never a
// ticket of the store. The screens show no ticket id for it.
export const LEAD_TICKET = 'lead';

export const LEAD_TOOL_NAMES = [
  'state', 'ticket', 'session', 'search_memory', 'propose_plan', 'start_ticket', 'stop_session',
  'message_session', 'answer_question', 'commit', 'fulfil', 'tell_owner', 'handover',
] as const;
export type LeadToolName = (typeof LEAD_TOOL_NAMES)[number];

export type PlanItemInput = {
  readonly title: string;                          // at most 120 characters
  readonly body: string;                           // the ticket's description and its "- [ ]" criteria
  readonly lane: 'fast' | 'full';
  readonly size: 'xs' | 's' | 'm' | 'l';
  readonly after: readonly number[];               // the 1-based positions this item waits for
};

export type LeadToolInput = {
  readonly state: Readonly<Record<string, never>>;
  readonly ticket: { readonly id: TicketId };
  readonly session: { readonly id: SessionId };
  readonly search_memory: { readonly query: string };
  readonly propose_plan: { readonly goal: string; readonly title: string; readonly summary: string; readonly items: readonly PlanItemInput[] };
  readonly start_ticket: { readonly id: TicketId; readonly reason: string };
  readonly stop_session: { readonly id: SessionId; readonly reason: string };
  readonly message_session: { readonly id: SessionId; readonly text: string };
  // The plan's `answers` record, as a list: the schema subset has no map.
  readonly answer_question: { readonly session: SessionId; readonly requestId: string; readonly answers: readonly { readonly question: string; readonly answer: string }[] };
  readonly commit: { readonly text: string; readonly ticket?: TicketId; readonly due?: string };   // due: an ISO 8601 time
  readonly fulfil: { readonly id: string; readonly note: string };
  readonly tell_owner: { readonly text: string };
  readonly handover: { readonly summary: string };
};

// What each handler answers. The reading tools answer cleaned text, cut at
// their cap (ANSWER_CAPS); the others a small value the host writes as JSON.
export type LeadToolOutput = {
  readonly state: string;
  readonly ticket: string;
  readonly session: string;
  readonly search_memory: string;
  readonly propose_plan: { readonly plan: string; readonly supersedes: string | null; readonly totals: Plan['totals'] };
  readonly start_ticket: { readonly started: TicketId };
  readonly stop_session: { readonly stopped: SessionId };
  readonly message_session: { readonly sent: true };
  readonly answer_question: { readonly answered: string };
  readonly commit: { readonly id: string };
  readonly fulfil: { readonly id: string; readonly state: 'done' };
  readonly tell_owner: { readonly seq: number };
  readonly handover: { readonly id: string };
};

export type LeadToolDefinition = {
  readonly name: LeadToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema & { readonly type: 'object' };
};

const text = (description: string): JsonSchema => ({ type: 'string', description });
const object = (properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = Object.keys(properties)): JsonSchema & { readonly type: 'object' } =>
  ({ type: 'object', properties, required });

export const LEAD_TOOLS: readonly LeadToolDefinition[] = [
  {
    name: 'state',
    description: 'The compact state of the project: plans with the state of each item, live sessions with what each one waits for, the inbox items waiting by kind, and your open commitments. At most 2 KB.',
    inputSchema: object({}),
  },
  {
    name: 'ticket',
    description: 'One ticket: its title, body, status and last five comments, as text.',
    inputSchema: object({ id: text('The ticket id, for example LOCAL-12.') }),
  },
  {
    name: 'session',
    description: 'One session of a team: its summary and the last twenty lines of its timeline (what it read, edited and ran, without the output).',
    inputSchema: object({ id: text('The session id.') }),
  },
  {
    name: 'search_memory',
    description: 'Search the project memory: approved decisions first, then the glossary and the lessons. Answers ids and contents.',
    inputSchema: object({ query: text('Words to search for.') }),
  },
  {
    name: 'propose_plan',
    description: 'Propose a plan for a goal: 1 to 12 tickets, each with its lane, its size and the positions it waits for. The service computes the estimates and shows the plan to the owner, who approves it. A new proposal for the same goal replaces the one still waiting.',
    inputSchema: object({
      goal: text('The goal id this plan answers.'),
      title: text('The plan title, in a few words.'),
      summary: text('One or two sentences for the owner.'),
      items: {
        type: 'array',
        description: 'The tickets of the plan, in order: the first is position 1.',
        items: object({
          title: text('The ticket title, at most 120 characters.'),
          body: text('The ticket description, then an "Acceptance criteria" list with at least one "- [ ]" line.'),
          lane: { type: 'string', enum: ['fast', 'full'], description: 'fast for a small change the fast lane may take, full otherwise.' },
          size: { type: 'string', enum: ['xs', 's', 'm', 'l'], description: 'The size of the change.' },
          after: { type: 'array', items: { type: 'number' }, description: 'The positions this ticket starts after, once they are live. Empty when it is independent.' },
        }),
      },
    }),
  },
  {
    name: 'start_ticket',
    description: 'Start a ticket of an approved plan that the runner put back or holds. Refused for any other ticket.',
    inputSchema: object({ id: text('The ticket id.'), reason: text('Why it starts again, for the ticket comment.') }),
  },
  {
    name: 'stop_session',
    description: 'Stop a live author or reviewer session. Its ticket goes back to Todo with your reason.',
    inputSchema: object({ id: text('The session id.'), reason: text('Why, for the ticket comment.') }),
  },
  {
    name: 'message_session',
    description: 'Write to a live session of a team, as the lead.',
    inputSchema: object({ id: text('The session id.'), text: text('The message.') }),
  },
  {
    name: 'answer_question',
    description: 'Answer a question a team session asked, only when an approved decision, the ticket or the plan settles it. Refused for a permission request: those wait for the owner.',
    inputSchema: object({
      session: text('The session id of the team that asked.'),
      requestId: text('The request id of the question.'),
      answers: { type: 'array', description: 'One answer per question asked.', items: object({ question: text('The question, as it was asked.'), answer: text('The answer.') }) },
    }),
  },
  {
    name: 'commit',
    description: 'Record something you told the owner you will do, in the same turn as you say it. Returns its id. A due time wakes you when it comes.',
    inputSchema: object({
      text: text('What you will do, in one sentence.'),
      ticket: text('The ticket it is about, if any.'),
      due: text('When it is due, as an ISO 8601 time, if it has a time.'),
    }, ['text']),
  },
  {
    name: 'fulfil',
    description: 'Close one of your open commitments once it is done.',
    inputSchema: object({ id: text('The commitment id.'), note: text('What was done.') }),
  },
  {
    name: 'tell_owner',
    description: 'Write a message in the owner\'s thread from an event turn. In a turn the owner started, your reply is the message, and this tool is refused.',
    inputSchema: object({ text: text('The message, in complete sentences.') }),
  },
  {
    name: 'handover',
    description: 'When asked to hand over: write what the structured record cannot know, what the owner last asked, the tone, and what you were about to do. Accepted once per generation.',
    inputSchema: object({ summary: text('Your account, at most 4 KB.') }),
  },
];

// The largest answer of each reading tool, in bytes (section 4.1): one
// answer stays far below the distance between the handover point and the
// threshold.
export const ANSWER_CAPS: Readonly<Partial<Record<LeadToolName, number>>> = { state: 2048, ticket: 8192, session: 8192, search_memory: 8192 };

// Text cut to at most `limit` bytes of UTF-8, never half a character, with
// a last line saying how many bytes went.
export function capAnswer(answer: string, limit: number): string {
  const bytes = Buffer.byteLength(answer);
  if (bytes <= limit) return answer;
  let kept = '';
  let size = 0;
  for (;;) {
    const line = `\n[cleared: ${bytes - size} bytes cut]`;
    const room = limit - Buffer.byteLength(line);
    let next = kept;
    let nextSize = size;
    for (const char of answer.slice(kept.length)) {
      const width = Buffer.byteLength(char);
      if (nextSize + width > room) break;
      next += char;
      nextSize += width;
    }
    // The count in the line can shrink by a digit once more is kept: settle.
    if (next === kept) return `${kept}${line}`;
    kept = next;
    size = nextSize;
  }
}

export type LeadHandlers = {
  readonly [N in LeadToolName]?: (input: LeadToolInput[N], context: HostCallContext) => Promise<LeadToolOutput[N]>;
};

// The host tools of the handlers given, in the contract's order, with the
// contract's description and schema; a reading tool's answer is cut at its
// cap. The input is the model's, after the SDK checked it against the
// schema: each handler still checks what the lead may do.
export function bindLeadTools(handlers: LeadHandlers): HostTool[] {
  return LEAD_TOOLS.flatMap((definition): HostTool[] => {
    const handler = handlers[definition.name] as ((input: unknown, context: HostCallContext) => Promise<unknown>) | undefined;
    if (!handler) return [];
    const cap = ANSWER_CAPS[definition.name];
    return [{
      ...definition,
      async handle(input, context) {
        const answer = await handler(input, context);
        return cap !== undefined && typeof answer === 'string' ? capAnswer(answer, cap) : answer;
      },
    }];
  });
}
