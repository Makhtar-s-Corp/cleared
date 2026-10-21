// Shared by the session screen's tests: the visible text of rendered HTML,
// every string of a value, and a model built from events.
import type { AgUiEvent, SessionEvent } from '../../../src/session/events.ts';
import { applyAll, emptyModel, type SessionModel } from '../../public/screens/session.ts';

// The text between tags, and the attributes a person reads or hears.
export function visibleText(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) out.push(match[1] ?? '');
  for (const run of html.replace(/<[^>]*>/g, '\n').split('\n')) out.push(run);
  return out.map((text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()).filter(Boolean);
}

export function strings(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, into);
  return into;
}

// Events as the service stores them, numbered from `from`, one second apart
// from 09:00:00 of 2026-10-21 local time.
export function stored(events: readonly AgUiEvent[], from = 1, session = 's1'): SessionEvent[] {
  return events.map((event, index) => ({
    seq: from + index, at: new Date(2026, 9, 21, 9, 0, from + index).toISOString(), sessionId: session, ticket: 'LOCAL-161', project: 'guestbook', event,
  }));
}

export function modelOf(events: readonly AgUiEvent[]): SessionModel {
  const model = emptyModel();
  applyAll(model, stored(events));
  return model;
}

export const tool = (id: string, name: string, input: object, result?: object): AgUiEvent[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(input) },
  { type: 'TOOL_CALL_END', toolCallId: id },
  ...(result ? [{ type: 'TOOL_CALL_RESULT', messageId: `${id}-r`, toolCallId: id, content: JSON.stringify(result), role: 'tool' } as AgUiEvent] : []),
];

export const message = (id: string, role: 'assistant' | 'user', delta: string, name?: string): AgUiEvent[] => [
  { type: 'TEXT_MESSAGE_START', messageId: id, role, ...(name ? { name } : {}) },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta },
  { type: 'TEXT_MESSAGE_END', messageId: id },
];
