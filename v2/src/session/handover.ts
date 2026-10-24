// What a session gives up when its work is handed to another harness
// (docs/v2/requirements-matrix.md, B6.3, P150). The targets are the
// contract's two, claude-code and codex; Cursor stays out of every flow
// until the owner's trial (P87). The note is read from the session's own
// journal, so it is the same whichever harness wrote it: the last thing the
// session said, the files it edited, the plan it proposed. The flow cleans
// it before it reaches the target, as it cleans everything it writes to a
// session.
import { posix } from 'node:path';
import { WORKDIR_MOUNT } from '../container/session-runtime.ts';
import { HandoverRefused, type Handover, type Harness, type HandoverTarget, type SessionId } from './contract.ts';
import { readToolInput, readToolOutput, type EventLog, type SessionEvent } from './events.ts';

export const HANDOVER_HARNESSES = ['claude-code', 'codex'] as const;
export const NOTE_MAX = 4000;                                // the last message is cut to this
const FILES_MAX = 40;

// Refuses what a session is not handed to; the session's own harness is
// checked too, since a handover to oneself would only stop it.
export function refuseTarget(from: Harness, to: HandoverTarget): void {
  const allowed: readonly string[] = HANDOVER_HARNESSES;
  if (!allowed.includes(from)) throw new HandoverRefused(`a ${from} session is not handed over: that harness stays out of the flows`);
  if (!allowed.includes(to.harness)) throw new HandoverRefused(`work is not handed to ${String(to.harness)}: only ${HANDOVER_HARNESSES.join(' and ')}`);
  if (from === to.harness) throw new HandoverRefused(`the session already runs on ${from}`);
  if (typeof to.model !== 'string' || to.model.trim() === '') throw new HandoverRefused('a handover names the target\'s model');
}

// A path the session changed, relative to the checkout; undefined outside it.
function inCheckout(path: string): string | undefined {
  const rel = posix.isAbsolute(path) ? posix.relative(WORKDIR_MOUNT, path) : posix.normalize(path);
  return rel === '' || rel === '.' || rel.startsWith('..') || posix.isAbsolute(rel) ? undefined : rel;
}

export function handoverNote(events: readonly SessionEvent[]): string {
  const assistant = new Set<string>();
  const texts = new Map<string, string>();
  const open = new Map<string, string>();
  const files: string[] = [];
  let plan: readonly string[] = [];
  for (const { event } of events) {
    if (event.type === 'TEXT_MESSAGE_START' && event.role === 'assistant') assistant.add(event.messageId);
    else if (event.type === 'TEXT_MESSAGE_CONTENT' && assistant.has(event.messageId)) texts.set(event.messageId, (texts.get(event.messageId) ?? '') + event.delta);
    else if (event.type === 'TOOL_CALL_ARGS') {
      const input = readToolInput(event);
      const path = input?.kind === 'edit' ? inCheckout(input.path) : undefined;
      if (path) open.set(event.toolCallId, path);
    } else if (event.type === 'TOOL_CALL_RESULT') {
      const path = open.get(event.toolCallId);
      if (path === undefined) continue;
      open.delete(event.toolCallId);
      const output = readToolOutput(event);
      const failed = output.kind === 'execute' ? output.isError : 'ok' in output && output.ok === false;
      if (!failed && !files.includes(path)) files.push(path);
    } else if (event.type === 'CUSTOM' && event.name === 'cleared.session_plan') plan = event.value.steps;
  }
  const said = [...texts.values()].reverse().find((text) => text.trim() !== '')?.trim();
  const lines: string[] = [];
  if (plan.length > 0) lines.push('The plan it proposed:', ...plan.map((step, n) => `${n + 1}. ${step}`), '');
  lines.push(said === undefined ? 'It had said nothing yet.' : `The last thing it said:\n${said.length > NOTE_MAX ? `${said.slice(0, NOTE_MAX)}…` : said}`, '');
  lines.push(files.length === 0 ? 'It had changed no file of the checkout yet.' : `The files it changed (read them again before you edit one):\n${files.slice(0, FILES_MAX).map((file) => `- ${file}`).join('\n')}${files.length > FILES_MAX ? `\n- … and ${files.length - FILES_MAX} more` : ''}`);
  return lines.join('\n');
}

// A handle's handover: the target checked, then the note of the journal.
export function handoverOf(log: EventLog, session: SessionId, from: Harness, to: HandoverTarget): Handover {
  refuseTarget(from, to);
  return { session, from, to, note: handoverNote(log.after(session)) };
}
