// A harness that plays a script: for the tests of the flow (lane 7) and for
// the app's fixtures (lanes 6, 9, 10). It behaves as an adapter must: every
// event goes through the cleaner, then into the event log with its seq, and
// events(after) replays from the log, then follows live.
//
// The script runs as far as it can and stops at a step that waits: a
// permission request or a question waits for answer(), awaitMessage for
// send(). So after `await start()`, `await answer()` or `await send()`,
// everything up to the next wait is stored, host tool calls answered.
//
// For a scripted lead (milestone 2): a hostCall step calls the host tool of
// that name from StartInput.tools with the scripted input, as the runner
// relays a model's call; a context step reports a context share, as the
// runner does after a turn or a tool call.
import { randomUUID } from 'node:crypto';
import { HostToolRefused, NotImplemented, type Answer, type Harness, type HostTool, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserMessage } from '../contract.ts';
import { createCleaner, type Cleaner } from '../clean.ts';
import { toolArgs, toolResult, type AgUiEvent, type CustomValue, type EventLog, type SessionEvent } from '../events.ts';

export type FakeStep =
  | { readonly emit: AgUiEvent }
  | { readonly awaitMessage: true }
  | { readonly permission: CustomValue['cleared.permission_request'] }
  | { readonly question: CustomValue['cleared.question'] }
  | { readonly hostCall: { readonly toolCallId: string; readonly name: string; readonly input: unknown } }
  | { readonly context: CustomValue['cleared.context_usage'] };

export type FakeAdapterOptions = {
  readonly log: EventLog;
  readonly script: readonly FakeStep[];
  readonly harness?: Harness;
  readonly cleaner?: () => Cleaner;               // one per session; default: createCleaner() with no secrets
  readonly newId?: () => SessionId;
  readonly now?: () => Date;
};

type Session = {
  readonly id: SessionId;
  readonly ticket: string;
  readonly project: string;
  readonly cleaner: Cleaner;
  readonly tools: ReadonlyMap<string, HostTool>;
  step: number;
  pending: string | undefined;                    // the request id the script waits for
  turn: string;                                   // the runId of the last RUN_STARTED
  closed: boolean;
  messages: number;
  readonly wake: Set<() => void>;
};

export function createFakeAdapter(options: FakeAdapterOptions): SessionAdapter {
  const { log, script } = options;
  const now = options.now ?? (() => new Date());
  const sessions = new Map<SessionId, Session>();

  function emit(session: Session, event: AgUiEvent): void {
    const cleaned = session.cleaner.clean(event);
    for (const clean of cleaned) log.append({ at: now().toISOString(), sessionId: session.id, ticket: session.ticket, project: session.project, event: clean });
    if (cleaned.length > 0) for (const wake of session.wake) wake();
  }

  function close(session: Session): void {
    session.closed = true;
    for (const wake of session.wake) wake();
  }

  // A host tool call as the runner relays it: the call's events, the
  // handler's answer, and the cleared.host_call record of its outcome.
  async function call(session: Session, step: Extract<FakeStep, { hostCall: unknown }>['hostCall']): Promise<void> {
    const { toolCallId, name, input } = step;
    emit(session, { type: 'TOOL_CALL_START', toolCallId, toolCallName: `mcp__cleared__${name}` });
    emit(session, toolArgs(toolCallId, { kind: 'other' }));
    emit(session, { type: 'TOOL_CALL_END', toolCallId });
    const tool = session.tools.get(name);
    let outcome: 'ok' | 'refused' | 'failed' = 'ok';
    let message: string | undefined;
    if (!tool) {
      outcome = 'failed';
      message = `no host tool is named ${name}`;
    } else {
      try {
        await tool.handle(input, { sessionId: session.id, turn: session.turn });
      } catch (error) {
        outcome = error instanceof HostToolRefused ? 'refused' : 'failed';
        message = error instanceof HostToolRefused ? error.message : 'the host could not run this tool';
      }
    }
    emit(session, toolResult(`${toolCallId}-result`, toolCallId, outcome === 'ok' ? { kind: 'other', ok: true } : { kind: 'other', ok: false, error: message as string }));
    emit(session, { type: 'CUSTOM', name: 'cleared.host_call', value: message === undefined ? { toolCallId, name, input, outcome } : { toolCallId, name, input, outcome, message } });
  }

  // Plays steps until one waits, or until the script ends (which ends the session).
  async function run(session: Session): Promise<void> {
    while (!session.closed) {
      const step = script[session.step];
      if (step === undefined) return close(session);
      if ('awaitMessage' in step) return;
      if ('permission' in step || 'question' in step) {
        const requestId = 'permission' in step ? step.permission.requestId : step.question.requestId;
        if (session.pending === requestId) return;
        session.pending = requestId;
        if ('permission' in step) emit(session, { type: 'CUSTOM', name: 'cleared.permission_request', value: step.permission });
        else emit(session, { type: 'CUSTOM', name: 'cleared.question', value: step.question });
        return;
      }
      if ('hostCall' in step) await call(session, step.hostCall);
      else if ('context' in step) {
        const { percent, totalTokens, maxTokens } = step.context;
        emit(session, { type: 'CUSTOM', name: 'cleared.context_usage', value: step.context });
        emit(session, { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/context', value: { percent, totalTokens, maxTokens } }] });
      } else {
        if (step.emit.type === 'RUN_STARTED') session.turn = step.emit.runId;
        emit(session, step.emit);
      }
      session.step++;
    }
  }

  function handle(session: Session): SessionHandle {
    const open = () => {
      if (session.closed) throw new Error(`session ${session.id} is stopped`);
    };
    return {
      id: session.id,
      async send(message: UserMessage) {
        open();
        const messageId = `${session.id}-user-${++session.messages}`;
        emit(session, { type: 'TEXT_MESSAGE_START', messageId, role: 'user', name: message.by });
        emit(session, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: message.text });
        emit(session, { type: 'TEXT_MESSAGE_END', messageId });
        const step = script[session.step];
        if (step && 'awaitMessage' in step) {
          session.step++;
          await run(session);
        }
      },
      async *events(afterSeq = 0) {
        let seq = afterSeq;
        for (;;) {
          // Listening before reading the log, so an event stored in between is not missed.
          let wake = () => {};
          const waited = new Promise<void>((resolve) => { wake = resolve; });
          session.wake.add(wake);
          try {
            const fresh: SessionEvent[] = log.after(session.id, seq);
            for (const event of fresh) {
              seq = event.seq;
              yield event;
            }
            if (fresh.length > 0) continue;
            if (session.closed) return;
            await waited;
          } finally {
            session.wake.delete(wake);
          }
        }
      },
      async answer(requestId: string, answer: Answer) {
        open();
        if (session.pending !== requestId) throw new Error(`no pending request ${requestId} in session ${session.id}`);
        session.pending = undefined;
        const step = script[session.step];
        if (step && 'question' in step && answer.decision.kind === 'answer' && answer.by !== 'policy') {
          emit(session, { type: 'CUSTOM', name: 'cleared.answered', value: { requestId, by: answer.by } });
        } else {
          const value = answer.rule === undefined
            ? { requestId, decision: answer.decision.kind, by: answer.by }
            : { requestId, decision: answer.decision.kind, by: answer.by, rule: answer.rule };
          emit(session, { type: 'CUSTOM', name: 'cleared.permission_answered', value });
        }
        session.step++;
        await run(session);
      },
      async interrupt() {
        open();
        if (session.pending !== undefined) {
          emit(session, { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: session.pending, decision: 'cancelled', by: 'policy' } });
          session.pending = undefined;
        }
        // The turn ends here; the script goes on at the next message, and a
        // script with no message left ends the session.
        while (script[session.step] !== undefined && !('awaitMessage' in (script[session.step] as FakeStep))) session.step++;
        emit(session, {
          type: 'RUN_FINISHED', threadId: session.id, runId: `${session.id}-interrupted`,
          outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null },
        });
        if (script[session.step] === undefined) close(session);
      },
      async stop() {
        close(session);
      },
      async handover() {
        throw new NotImplemented('handing a session over to another harness comes in milestone 3');
      },
    };
  }

  return {
    harness: options.harness ?? 'claude-code',
    async start(input: StartInput) {
      const session: Session = {
        id: options.newId?.() ?? randomUUID(), ticket: input.ticket, project: input.project,
        cleaner: options.cleaner?.() ?? createCleaner(), tools: new Map((input.tools ?? []).map((tool) => [tool.name, tool])),
        step: 0, pending: undefined, turn: '', closed: false, messages: 0, wake: new Set(),
      };
      sessions.set(session.id, session);
      await run(session);
      return handle(session);
    },
    async resume(id: SessionId) {
      const session = sessions.get(id);
      if (!session) throw new Error(`unknown session ${id}`);
      return handle(session);
    },
  };
}

// One author turn of the demo ticket: the shape of the session screen's
// capture (one read, one edit, one command, a permission request, a message
// from the human), for the app's fixtures and the flow's tests.
export const exampleScript: readonly FakeStep[] = [
  { emit: { type: 'STEP_STARTED', stepName: 'author' } },
  { emit: { type: 'RUN_STARTED', threadId: 'example', runId: 'turn-1' } },
  { emit: { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading the guestbook', phase: 'working', steps: [{ name: 'author', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: null }], files: [], checks: [], usage: {} } } },
  { emit: { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'I will sort the entries by date, newest first, and add a test.' } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: 'a1' } },
  { emit: { type: 'TOOL_CALL_START', toolCallId: 'read-1', toolCallName: 'Read' } },
  { emit: toolArgs('read-1', { kind: 'read', path: 'src/entries.ts' }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: 'read-1' } },
  { emit: toolResult('read-1-result', 'read-1', { kind: 'read', path: 'src/entries.ts', bytes: 1840 }) },
  { emit: { type: 'TOOL_CALL_START', toolCallId: 'edit-1', toolCallName: 'Edit' } },
  { emit: toolArgs('edit-1', { kind: 'edit', path: 'src/entries.ts', added: 3, removed: 1 }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: 'edit-1' } },
  { emit: toolResult('edit-1-result', 'edit-1', { kind: 'edit', ok: true }) },
  { emit: { type: 'TOOL_CALL_START', toolCallId: 'run-1', toolCallName: 'Bash' } },
  { emit: toolArgs('run-1', { kind: 'execute', command: 'npm test', description: 'Run the tests' }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: 'run-1' } },
  { emit: toolResult('run-1-result', 'run-1', { kind: 'execute', output: '# tests 6\n# pass 6\n# fail 0\n', cut: 0, isError: false }) },
  { emit: { type: 'TOOL_CALL_START', toolCallId: 'run-2', toolCallName: 'Bash' } },
  { emit: toolArgs('run-2', { kind: 'execute', command: 'touch test/fixtures/entries.json', description: 'Create the fixture file' }) },
  { permission: { requestId: 'request-1', toolCallId: 'run-2', tool: 'Bash', input: { kind: 'execute', command: 'touch test/fixtures/entries.json' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } } },
  { emit: { type: 'TOOL_CALL_END', toolCallId: 'run-2' } },
  { emit: toolResult('run-2-result', 'run-2', { kind: 'execute', output: '', cut: 0, isError: false }) },
  { emit: { type: 'TEXT_MESSAGE_START', messageId: 'a2', role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a2', delta: 'The tests pass. Shall I also show the date of each entry?' } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: 'a2' } },
  { awaitMessage: true },
  { emit: { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: 'Done' }] } },
  { emit: { type: 'RUN_FINISHED', threadId: 'example', runId: 'turn-1', outcome: { type: 'success' }, usage: [{ model: 'claude-opus-5-5', inputTokens: 18200, outputTokens: 2100, cachedInputTokens: 12000 }], result: { stopReason: 'end_turn', total_cost_usd: 0.42 } } },
  { emit: { type: 'STEP_FINISHED', stepName: 'author' } },
];

const contextAt = (percent: number): CustomValue['cleared.context_usage'] =>
  ({ totalTokens: percent * 2000, maxTokens: 200_000, rawMaxTokens: 200_000, percent, isAutoCompactEnabled: true });

// The plan the example lead proposes for the guestbook: five tickets, 2
// after 1 and 3 after 2, the last two small enough for the fast lane (the
// shape of lead-and-plan.png, with the guestbook's content).
export const examplePlanInput = {
  goal: 'goal-1',
  title: 'Make a long guestbook readable',
  summary: 'Pages of 20 entries on desktop, the long list on the phone. Ready by Friday.',
  items: [
    { title: 'Day headings in the list of entries', lane: 'full', size: 'm', after: [], body: 'Group the entries under one heading per day, newest day first.\n\nAcceptance criteria\n- [ ] one heading per day, in the visitor\'s time zone\n- [ ] a test with entries on three days' },
    { title: 'Pages of 20 entries on desktop', lane: 'full', size: 'l', after: [1], body: 'Show 20 entries per page on screens of 1024 px and more, with links to the next and previous pages.\n\nAcceptance criteria\n- [ ] 20 entries per page on desktop\n- [ ] the phone keeps the long list\n- [ ] a test of the second page' },
    { title: 'Page links keep the newest-first order', lane: 'full', size: 's', after: [2], body: 'The next page continues where the previous one ended, newest first, even when an entry is added meanwhile.\n\nAcceptance criteria\n- [ ] no entry is shown twice or skipped across pages\n- [ ] a test that adds an entry between two pages' },
    { title: 'An empty page says “No entries yet”', lane: 'fast', size: 'xs', after: [], body: 'A guestbook with no entry shows “No entries yet” instead of an empty list.\n\nAcceptance criteria\n- [ ] the text on an empty guestbook\n- [ ] a test' },
    { title: 'Glossary: “entry”, “page”', lane: 'fast', size: 'xs', after: [], body: 'Add “entry” and “page” to the project glossary.\n\nAcceptance criteria\n- [ ] both terms in the glossary' },
  ],
} as const;

// A turn of the project lead on a goal (milestone 2): the briefing's
// context, then the owner's goal, a memory search, one question through
// AskUserQuestion, a plan proposed, a commitment, the reply, and a context
// share rising to 45 %. For the lead's tests and the app's lead fixture,
// with host tools of those names in StartInput.tools.
export const exampleLeadScript: readonly FakeStep[] = [
  { emit: { type: 'STATE_SNAPSHOT', snapshot: { status: 'Waiting for the owner', phase: 'working', steps: [], files: [], checks: [], usage: {}, context: { percent: 9, totalTokens: 18_000, maxTokens: 200_000 } } } },
  { context: contextAt(9) },
  { awaitMessage: true },
  { emit: { type: 'RUN_STARTED', threadId: 'lead', runId: 'lead-turn-1' } },
  { hostCall: { toolCallId: 'lead-call-1', name: 'search_memory', input: { query: 'entries order page layout' } } },
  { context: contextAt(12) },
  {
    question: {
      requestId: 'lead-question-1',
      questions: [{
        question: 'Before I plan: on desktop, do you want the entries in pages of 20, or one long list that loads more as you scroll, like on the phone?',
        header: 'Desktop list',
        options: [{ label: 'Pages of 20 (Recommended)' }, { label: 'One long list' }],
      }],
    },
  },
  { context: contextAt(31) },
  { hostCall: { toolCallId: 'lead-call-2', name: 'propose_plan', input: examplePlanInput } },
  { hostCall: { toolCallId: 'lead-call-3', name: 'commit', input: { text: 'When the first ticket of the plan lands, tell the owner how long it took from start to live.' } } },
  { emit: { type: 'TEXT_MESSAGE_START', messageId: 'lead-reply-1', role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'lead-reply-1', delta: 'Understood. I checked the decisions: entries are shown newest first (decision 3), and the page works without JavaScript (decision 1). Here is a plan in five tickets. Two are small enough for the fast lane. I need your go on the plan; you will still approve each release. When the first ticket lands, I will tell you how long it took from start to live.' } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: 'lead-reply-1' } },
  { context: contextAt(45) },
  { emit: { type: 'RUN_FINISHED', threadId: 'lead', runId: 'lead-turn-1', outcome: { type: 'success' }, usage: [{ model: 'claude-opus-5-5', inputTokens: 90_000, outputTokens: 2_400, cachedInputTokens: 70_000 }], result: { stopReason: 'end_turn', total_cost_usd: 0.38 } } },
  { awaitMessage: true },
];
