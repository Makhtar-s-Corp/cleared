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
  readonly state?: SessionState | undefined;               // the session's state as its detail route gave it, if read
  readonly open: (url: string) => StreamLike;             // new EventSource(url), or a test's stand-in
  readonly later: (run: () => void, ms: number) => void;
  readonly streaming?: boolean;                            // whether the stream opens at the start (default true): a feed made closed opens nothing (review of 251, F5)
};

export const sessionAgentId = (sessionId: string) => `session:${sessionId}`;

export const isSessionThread = (state: object): state is SessionThread => Array.isArray((state as Partial<SessionThread>).rows);

// The thread's text as AG-UI messages: the person's and the session's.
function messagesOf(model: SessionModel): Message[] {
  return [...model.texts.values()].filter((row) => row.text.trim()).map((row) => ({ id: row.id, role: row.role, content: row.text }));
}

// The stream can be paused (lane 36): a view kept hidden, or an ended
// session whose events are all read, holds no connection; resumed, it
// reads on from the last event it added up.
export class SessionAgent extends ThreadAgent<SessionThread> {
  readonly options: SessionAgentOptions;
  #open = true;
  #connect: (() => void) | undefined;
  #handle: { stop(): void } | undefined;

  constructor(options: SessionAgentOptions) {
    super({ agentId: sessionAgentId(options.sessionId), threadId: options.sessionId, description: 'The session\'s timeline, from the service\'s stream' });
    this.options = options;
    this.#open = options.streaming ?? true;
  }

  get streaming(): boolean {
    return this.#handle !== undefined;
  }

  setOpen(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    if (open) this.#connect?.();
    else this.#stop();
  }

  #stop(): void {
    this.#handle?.stop();
    this.#handle = undefined;
  }

  protected override follow(publish: Publish<SessionThread>): () => void {
    const model = emptyModel();
    if (this.options.state) model.state = structuredClone(this.options.state);
    const send = () => publish(threadOf(model), messagesOf(model));
    const soon = batched(send);
    this.#connect = () => {
      this.#stop();
      this.#handle = follow({
        url: (after) => `/api/service/sessions/${encodeURIComponent(this.options.sessionId)}/events?after=${after}`,
        after: model.lastSeq,
        open: this.options.open,
        later: this.options.later,
        onEvent: (event) => { if (applyEvent(model, event)) soon(); },
      });
    };
    if (this.#open) this.#connect();
    send();
    return () => {
      this.#stop();
      this.#connect = undefined;
    };
  }
}
