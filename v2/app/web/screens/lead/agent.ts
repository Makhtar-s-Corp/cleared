// The lead's thread as a CopilotKit agent (copilot/agent.ts). It reads the
// lead's state, its thread and the plans, then follows the lead's stream
// (followLead, in model.ts: a thread message, the state, a plan), and
// publishes the whole as the agent's state, with the thread's lines as
// AG-UI messages. The screen's own gestures (a reply, a plan's approval)
// are folded in with update() as soon as the service answers them.
import type { Message } from '@ag-ui/client';
import type { LeadMessage, LeadState, LeadStreamFrame, Plan } from '../../../../src/api/types.ts';
import { batched, ThreadAgent, type Publish } from '../../copilot/agent.ts';
import type { ScreenContext } from '../../lib/screen.ts';
import { followLead, mergeMessages, mergePlan, NO_LEAD, type StreamLike } from './model.ts';

export type LeadThread = { readonly lead: LeadState; readonly messages: readonly LeadMessage[]; readonly plans: readonly Plan[] };

export const LEAD_AGENT = 'lead';

export const isLeadThread = (state: object): state is LeadThread => Array.isArray((state as Partial<LeadThread>).messages) && typeof (state as Partial<LeadThread>).lead === 'object';

export type LeadAgentOptions = {
  readonly api: ScreenContext['api'];
  readonly open: (url: string) => StreamLike;
  readonly later: (run: () => void, ms: number) => void;
  readonly onFrame?: (frame: LeadStreamFrame) => void;                     // the shell recounts the inbox
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
      this.thread = { lead, messages, plans };
      send();
      stop = followLead({
        url: (after) => `/api/service/lead/stream?after=${after}`,
        after: messages.at(-1)?.seq ?? 0,
        open: this.options.open,
        later: this.options.later,
        onFrame: (frame) => {
          const before = this.thread;
          if (!before || stopped) return;
          this.thread = frame.kind === 'message' ? { ...before, messages: mergeMessages(before.messages, [frame.message]) }
            : frame.kind === 'state' ? { ...before, lead: frame.state }
            : { ...before, plans: mergePlan(before.plans, frame.plan) };
          soon();
          this.options.onFrame?.(frame);
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
