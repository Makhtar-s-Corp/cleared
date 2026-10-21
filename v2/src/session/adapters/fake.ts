// A harness that plays a script: for the tests of the flow (lane 7) and for
// the app's fixtures (lanes 6, 9, 10). It behaves as an adapter must: every
// event goes through the cleaner, then into the event log with its seq, and
// events(after) replays from the log, then follows live.
//
// The script runs as far as it can and stops at a step that waits: a
// permission request waits for answer(), awaitMessage for send(). So after
// `await start()`, `await answer()` or `await send()`, everything up to the
// next wait is stored.
import { randomUUID } from 'node:crypto';
import { NotImplemented, type Answer, type Harness, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserMessage } from '../contract.ts';
import { createCleaner, type Cleaner } from '../clean.ts';
import { toolArgs, toolResult, type AgUiEvent, type CustomValue, type EventLog, type SessionEvent } from '../events.ts';

export type FakeStep =
  | { readonly emit: AgUiEvent }
  | { readonly awaitMessage: true }
  | { readonly permission: CustomValue['cleared.permission_request'] };

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
  step: number;
  pending: string | undefined;                    // the request id the script waits for
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

  // Plays steps until one waits, or until the script ends (which ends the session).
  function run(session: Session): void {
    while (!session.closed) {
      const step = script[session.step];
      if (step === undefined) return close(session);
      if ('awaitMessage' in step) return;
      if ('permission' in step) {
        if (session.pending === step.permission.requestId) return;
        session.pending = step.permission.requestId;
        emit(session, { type: 'CUSTOM', name: 'cleared.permission_request', value: step.permission });
        return;
      }
      emit(session, step.emit);
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
          run(session);
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
        const value = answer.rule === undefined
          ? { requestId, decision: answer.decision.kind, by: answer.by }
          : { requestId, decision: answer.decision.kind, by: answer.by, rule: answer.rule };
        emit(session, { type: 'CUSTOM', name: 'cleared.permission_answered', value });
        session.step++;
        run(session);
      },
      async interrupt() {
        open();
        if (session.pending !== undefined) {
          emit(session, { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: session.pending, decision: 'cancelled', by: 'policy' } });
          session.pending = undefined;
        }
        // The turn ends here; the script goes on at the next message.
        while (script[session.step] !== undefined && !('awaitMessage' in (script[session.step] as FakeStep))) session.step++;
        emit(session, {
          type: 'RUN_FINISHED', threadId: session.id, runId: `${session.id}-interrupted`,
          outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null },
        });
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
        cleaner: options.cleaner?.() ?? createCleaner(), step: 0, pending: undefined, closed: false, messages: 0, wake: new Set(),
      };
      sessions.set(session.id, session);
      run(session);
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
