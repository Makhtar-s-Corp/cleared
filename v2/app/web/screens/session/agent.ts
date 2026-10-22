// The session's timeline as a CopilotKit agent (copilot/agent.ts): it
// follows the service's stream of the session's stored AG-UI events
// (follow, in model.ts), adds each event up in the model, and publishes the
// thread the screen draws, with the session's text as AG-UI messages.
import type { Message } from '@ag-ui/client';
import type { SessionState } from '../../../../src/session/events.ts';
import { batched, ThreadAgent, type Publish } from '../../copilot/agent.ts';
import { applyEvent, emptyModel, follow, threadOf, type SessionModel, type SessionThread, type StreamLike } from './model.ts';

export type SessionAgentOptions = {
  readonly sessionId: string;
  readonly state: SessionState;                           // the session's state as its detail route gave it
  readonly open: (url: string) => StreamLike;             // new EventSource(url), or a test's stand-in
  readonly later: (run: () => void, ms: number) => void;
};

export const sessionAgentId = (sessionId: string) => `session:${sessionId}`;

export const isSessionThread = (state: object): state is SessionThread => Array.isArray((state as Partial<SessionThread>).rows);

// The thread's text as AG-UI messages: the person's and the session's.
function messagesOf(model: SessionModel): Message[] {
  return [...model.texts.values()].filter((row) => row.text.trim()).map((row) => ({ id: row.id, role: row.role, content: row.text }));
}

export class SessionAgent extends ThreadAgent<SessionThread> {
  readonly options: SessionAgentOptions;

  constructor(options: SessionAgentOptions) {
    super({ agentId: sessionAgentId(options.sessionId), threadId: options.sessionId, description: 'The session\'s timeline, from the service\'s stream' });
    this.options = options;
  }

  protected override follow(publish: Publish<SessionThread>): () => void {
    const model = emptyModel();
    model.state = structuredClone(this.options.state);
    const send = () => publish(threadOf(model), messagesOf(model));
    const soon = batched(send);
    const handle = follow({
      url: (after) => `/api/service/sessions/${encodeURIComponent(this.options.sessionId)}/events?after=${after}`,
      after: 0,
      open: this.options.open,
      later: this.options.later,
      onEvent: (event) => { if (applyEvent(model, event)) soon(); },
    });
    send();
    return () => handle.stop();
  }
}
