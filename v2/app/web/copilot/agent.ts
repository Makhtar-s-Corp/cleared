// A thread of the app as an AG-UI agent for CopilotKit: the session's
// timeline (screens/session/agent.ts) and the lead's thread
// (screens/lead/agent.ts). CopilotKit connects it (copilotkit.connectAgent)
// and its React hooks hold what it says; the screens draw that.
//
// The agent reads the app's own stream, never a CopilotKit runtime: there is
// none, and no Copilot Cloud. connect() opens one AG-UI run that lasts as
// long as the screen. Each change of the thread is a STATE_SNAPSHOT (what
// the screen draws, as plain data) and a MESSAGES_SNAPSHOT (the thread's
// text as AG-UI messages). Snapshots, not the stored events themselves:
// AG-UI's verifier refuses a stream that starts in the middle of a run or
// carries several runs, which a stored session does after a reconnect.
//
// What the person writes goes through the app's routes (the anti-forgery
// token, the origin check), as before; the stream brings it back.
import './zod.ts';
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { Observable, throwError } from 'rxjs';

export type Publish<S> = (state: S, messages: Message[]) => void;

export abstract class ThreadAgent<S extends object> extends AbstractAgent {
  // Opens the app's stream, publishes every change, and returns what closes it.
  protected abstract follow(publish: Publish<S>): () => void;

  protected override connect(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
      return this.follow((state, messages) => {
        subscriber.next({ type: EventType.STATE_SNAPSHOT, snapshot: state } as BaseEvent);
        subscriber.next({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);
      });
    });
  }

  // Nothing runs the agent: the person's words go through the app's routes.
  override run(): Observable<BaseEvent> {
    return throwError(() => new Error('this thread is written through the app, not run by CopilotKit'));
  }
}

// Calls `run` once per microtask however many changes came in it, so a
// replay of many stored events publishes one snapshot.
export function batched(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; run(); });
  };
}
