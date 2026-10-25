// The lead's thread as a CopilotKit agent (copilot/agent.ts). It reads the
// lead's state, its thread and the plans, then follows the lead's stream
// (followLead, in model.ts: a thread message, the state, a plan), and
// publishes the whole as the agent's state, with the thread's lines as
// AG-UI messages. The screen's own gestures (a reply, a plan's approval)
// are folded in with update() as soon as the service answers them.
import type { Message } from '@ag-ui/client';
import type { LeadMessage, LeadState, LeadStreamFrame, NextInboxItem, Plan } from '../../../../src/api/types.ts';
import { batched, ThreadAgent, type Publish } from '../../copilot/agent.ts';
import type { ScreenContext } from '../../lib/screen.ts';
import { followLead, frameChanges, mergeMessages, mergePlan, NO_LEAD, trainLines, type StreamLike, type TrainLine } from './model.ts';

// trains: the release trains, read from the inbox by the screen (readTrains,
// lane 22) once the thread is there and at each tick; none until then.
export type LeadThread = { readonly lead: LeadState; readonly messages: readonly LeadMessage[]; readonly plans: readonly Plan[]; readonly trains: readonly TrainLine[] };

export const LEAD_AGENT = 'lead';

export const isLeadThread = (state: object): state is LeadThread => Array.isArray((state as Partial<LeadThread>).messages) && typeof (state as Partial<LeadThread>).lead === 'object';

export type LeadAgentOptions = {
  readonly api: ScreenContext['api'];
  readonly open: (url: string) => StreamLike;
  readonly later: (run: () => void, ms: number) => void;
  readonly onFrame?: (frame: LeadStreamFrame, before: LeadThread) => void;  // the shell recounts the inbox
};

// The thread's lines as AG-UI messages: the owner's, the lead's, the service's.
function messagesOf(thread: LeadThread): Message[] {
  return thread.messages.map((message) => ({
    id: `lead-${message.seq}`,
    role: message.by === 'owner' ? 'user' as const : message.by === 'lead' ? 'assistant' as const : 'system' as const,
    content: message.question ? message.question.questions.map((q) => q.question).join('\n\n') : message.text,
  }));
}

export class LeadAgent extends ThreadAgent<LeadThread> {
  readonly options: LeadAgentOptions;
  private thread: LeadThread | undefined;
  private publish: Publish<LeadThread> | undefined;

  constructor(options: LeadAgentOptions) {
    super({ agentId: LEAD_AGENT, threadId: LEAD_AGENT, description: 'The lead\'s thread, its state and its plans, from the service' });
    this.options = options;
  }

  // A change the screen knows before the stream says it.
  update(change: (thread: LeadThread) => LeadThread): void {
    if (!this.thread) return;
    this.thread = change(this.thread);
    this.publish?.(this.thread, messagesOf(this.thread));
  }

  // The trains as the inbox says them now; a failed read keeps the last
  // ones, and the same trains do not draw the thread again.
  async readTrains(): Promise<void> {
    const items = await this.options.api<NextInboxItem[]>('/inbox').catch(() => undefined);
    if (!items) return;
    const trains = trainLines(items);
    if (this.thread && JSON.stringify(trains) === JSON.stringify(this.thread.trains)) return;
    this.update((thread) => ({ ...thread, trains }));
  }

  protected override follow(publish: Publish<LeadThread>): () => void {
    const { api } = this.options;
    let stopped = false;
    let stop: (() => void) | undefined;
    this.publish = publish;
    const send = () => { if (this.thread && !stopped) publish(this.thread, messagesOf(this.thread)); };
    const soon = batched(send);
    void (async () => {
      const [lead, messages, plans] = await Promise.all([
        api<LeadState>('/lead').catch(() => NO_LEAD),
        api<LeadMessage[]>('/lead/messages').catch(() => [] as LeadMessage[]),
        api<Plan[]>('/plans').catch(() => [] as Plan[]),
      ]);
      if (stopped) return;
      this.thread = { lead, messages, plans, trains: [] };
      send();
      stop = followLead({
        url: (after) => `/api/service/lead/stream?after=${after}`,
        after: messages.at(-1)?.seq ?? 0,
        open: this.options.open,
        later: this.options.later,
        onFrame: (frame) => {
          const before = this.thread;
          if (!before || stopped || !frameChanges(frame, before)) return;
          this.thread = frame.kind === 'message' ? { ...before, messages: mergeMessages(before.messages, [frame.message]) }
            : frame.kind === 'state' ? { ...before, lead: frame.state }
            : { ...before, plans: mergePlan(before.plans, frame.plan) };
          soon();
          this.options.onFrame?.(frame, before);
        },
      }).stop;
    })();
    return () => {
      stopped = true;
      this.publish = undefined;
      stop?.();
    };
  }
}
