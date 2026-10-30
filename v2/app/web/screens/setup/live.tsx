// The sessions, seen from the assistant (issues #493 and #495): the assistant
// reads the sessions and the inbox every few seconds, as the other screens read
// them, and says it when a session waits for the person; the steps that start a
// session show its state, its link, its last action and its pull request.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { NextInboxItem as InboxItem, SessionSummary } from '../../../../src/api/types.ts';
import type { SessionEvent } from '../../../../src/session/events.ts';
import type { Translate } from '@/lib/i18n.ts';
import { intentSentence } from '@/lib/intent.ts';
import { requestAsk } from '@/lib/request.ts';
import { duration } from '@/lib/time.ts';

const READ_MS = 4_000;

type Waiting = InboxItem & { readonly sessionId?: string };
export type Watch = { readonly sessions: readonly SessionSummary[]; readonly waiting: readonly Waiting[] };
export const EMPTY_WATCH: Watch = { sessions: [], waiting: [] };

const read = async <T,>(path: string): Promise<T | undefined> => {
  const answer = await fetch(`/api/service${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => undefined);
  return answer?.ok ? await answer.json().catch(() => undefined) as T | undefined : undefined;
};

// How long, never "for now": at least a minute.
const lasting = (from: string, now: Date, t: Translate): string => duration(Math.max(1, Math.floor((now.getTime() - Date.parse(from)) / 60_000)), t);

const ANSWERED: ReadonlySet<string> = new Set(['permission', 'question', 'session_plan']);

// Oldest first: the one that has waited longest is said.
export function waitingOf(items: readonly InboxItem[]): Waiting[] {
  return items.filter((item) => item.state === 'waiting' && ANSWERED.has(item.kind)).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

export function useWatch(on: boolean): Watch {
  const [watch, setWatch] = useState<Watch>(EMPTY_WATCH);
  useEffect(() => {
    if (!on) return;
    let gone = false;
    const once = async () => {
      const [sessions, inbox] = await Promise.all([read<SessionSummary[]>('/sessions'), read<InboxItem[]>('/inbox')]);
      if (!gone) setWatch({ sessions: sessions ?? [], waiting: waitingOf(inbox ?? []) });
    };
    void once();
    const timer = setInterval(() => void once(), READ_MS);
    return () => { gone = true; clearInterval(timer); };
  }, [on]);
  return watch;
}

export const WatchContext = createContext<Watch>(EMPTY_WATCH);

// What a waiting item asks, in the person's words.
export function askOf(item: Waiting, t: Translate): string {
  if (item.kind === 'permission') {
    const permission = item as Extract<InboxItem, { kind: 'permission' }>;
    const description = permission.input.kind === 'execute' ? permission.input.description : undefined;
    return description ? `${description}.`.replace(/\.\.$/, '.') : requestAsk({ input: permission.input, tool: permission.tool }, undefined, t);
  }
  return t(item.kind === 'session_plan' ? 'setup_waiting_plan' : item.kind === 'question' ? 'setup_waiting_question' : 'setup_waiting_other');
}

// The alert a session waiting for the person raises, on every step.
export function WaitingAlert({ t, now = new Date() }: { readonly t: Translate; readonly now?: Date }) {
  const { waiting } = useContext(WatchContext);
  const first = waiting[0];
  if (!first) return null;
  const values = { ticket: first.ticket, age: lasting(first.since, now, t), ask: askOf(first, t), count: waiting.length };
  return (
    <div className="setup-waiting" role="status" data-setup-waiting={first.id}>
      <p><span className="dot" aria-hidden="true" />{t(waiting.length === 1 ? 'setup_waiting_one' : 'setup_waiting_many', values)}</p>
      <a className="btn" href={`/inbox#${encodeURIComponent(first.id)}`}>{t('setup_waiting_open')}</a>
    </div>
  );
}

type LastAction = { readonly kind: 'read' | 'edit'; readonly path: string } | { readonly kind: 'command'; readonly command: string } | { readonly kind: 'other'; readonly tool: string };

// The last tool the session used, from its event stream (the session screen's).
export function lastActionOf(event: SessionEvent, names: Map<string, string>, seen: LastAction | undefined): LastAction | undefined {
  const { event: e } = event;
  if (e.type === 'TOOL_CALL_START') { names.set(e.toolCallId, e.toolCallName); return seen; }
  if (e.type !== 'TOOL_CALL_ARGS') return seen;
  let input: { kind?: string; path?: unknown; command?: unknown };
  try { input = JSON.parse(e.delta) as typeof input; } catch { return seen; }
  if ((input.kind === 'read' || input.kind === 'edit') && typeof input.path === 'string') return { kind: input.kind, path: input.path.replace(/^\/workspace\//, '') };
  if (input.kind === 'execute' && typeof input.command === 'string') return { kind: 'command', command: input.command };
  return { kind: 'other', tool: names.get(e.toolCallId) ?? '' };
}

function useLastAction(session: string | undefined): LastAction | undefined {
  const [last, setLast] = useState<LastAction | undefined>();
  useEffect(() => {
    if (!session || typeof EventSource === 'undefined') return;
    const names = new Map<string, string>();
    const stream = new EventSource(`/api/service/sessions/${encodeURIComponent(session)}/events?after=0`);
    const hear = (message: MessageEvent<string>) => {
      try { setLast((seen) => lastActionOf(JSON.parse(message.data) as SessionEvent, names, seen)); } catch { /* not an event */ }
    };
    stream.addEventListener('TOOL_CALL_START', hear as EventListener);
    stream.addEventListener('TOOL_CALL_ARGS', hear as EventListener);
    return () => stream.close();
  }, [session]);
  return last;
}

const lastLine = (last: LastAction, t: Translate): string => {
  const action = last.kind === 'command' ? intentSentence(last.command, t).toLocaleLowerCase()
    : last.kind === 'other' ? t('setup_live_other', { tool: last.tool })
    : t(last.kind === 'read' ? 'setup_live_read' : 'setup_live_edit', { path: last.path });
  return t('setup_live_last', { action });
};

// A ticket's session, live: its state in a word beside its mark, how long, its
// link, what it did last, its pull request.
export function LiveSession({ t, ticket, pullRequest, now = new Date() }: {
  readonly t: Translate; readonly ticket: string; readonly pullRequest?: { readonly number: number; readonly url: string } | undefined; readonly now?: Date;
}) {
  const { sessions } = useContext(WatchContext);
  const session = useMemo(() => [...sessions].filter((s) => s.ticket === ticket).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0], [sessions, ticket]);
  const last = useLastAction(session?.id);
  const phase = session?.phase;
  const busy = !phase || phase === 'starting' || phase === 'working' || phase === 'reviewing';
  return (
    <div className="setup-live" data-setup-live={phase ?? 'none'} aria-busy={busy}>
      <p className="setup-live-state" role="status" aria-live="polite">
        {busy ? <span className="setup-spinner" aria-hidden="true" /> : <span className={`dot ${phase === 'waiting_human' ? 'awaiting' : phase === 'failed' ? 'danger' : 'ok'}`} aria-hidden="true" />}
        <span className="setup-live-word">{session ? t(`setup_live_${session.phase}`) : t('setup_live_none')}</span>
        <span className="setup-live-ticket">{ticket}</span>
        {session ? <span className="setup-live-age">{t('setup_live_since', { age: lasting(session.startedAt, now, t) })}</span> : null}
      </p>
      {last ? <p className="setup-live-last">{lastLine(last, t)}</p> : null}
      <p className="setup-live-links">
        {session ? <a className="setup-link" href={`/sessions/${encodeURIComponent(session.id)}`} data-setup-session-link>{t('setup_live_open')}</a> : null}
        {pullRequest ? <a className="setup-link" href={pullRequest.url} target="_blank" rel="noreferrer">{t('setup_live_pr')}</a> : null}
      </p>
    </div>
  );
}
