// What the third and last automatic attempt of a plan's ticket is told
// (issue #290): the report its reviewer wrote last, and the output of the
// last test run that failed in one of its sessions, read from the ledger's
// session events. Each cut, the end of a test run kept (where a runner
// says what failed), and cleaned again before it goes into a prompt.
import { lastReport } from '../../flow/prompts.ts';
import { readToolInput, readToolOutput } from '../../session/events.ts';
import type { Store } from '../../store/db.ts';

export const RETRY_TEXT_LIMIT = 4000;

// A command that runs a project's tests or checks.
const TEST_COMMAND = /\b(test|tests|vitest|jest|mocha|pytest|check|typecheck|lint)\b/;

export type RetryContext = {
  readonly review: string | undefined;
  readonly tests: { readonly command: string; readonly output: string } | undefined;
};

const head = (text: string) => (text.length <= RETRY_TEXT_LIMIT ? text : `${text.slice(0, RETRY_TEXT_LIMIT - 2)} …`);
const tail = (text: string) => (text.length <= RETRY_TEXT_LIMIT ? text : `… ${text.slice(text.length - RETRY_TEXT_LIMIT + 2)}`);

export function retryContext(store: Pick<Store, 'events' | 'sessions'>, ticket: string, clean: (text: string) => string): RetryContext {
  const sessions = store.sessions.list({ ticket }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let review: string | undefined;
  let tests: RetryContext['tests'];
  for (const row of sessions) {
    const events = store.events.after(row.id);
    if (row.role === 'reviewer') review = lastReport(events) ?? review;
    if (row.role !== 'author') continue;
    const commands = new Map<string, string>();
    for (const { event } of events) {
      if (event.type === 'TOOL_CALL_ARGS') {
        const input = readToolInput(event);
        if (input?.kind === 'execute') commands.set(event.toolCallId, input.command);
      } else if (event.type === 'TOOL_CALL_RESULT') {
        const command = commands.get(event.toolCallId);
        const output = readToolOutput(event);
        if (command && TEST_COMMAND.test(command) && output.kind === 'execute' && output.isError) tests = { command, output: output.output };
      }
    }
  }
  return {
    review: review === undefined ? undefined : head(clean(review)),
    tests: tests ? { command: clean(tests.command), output: tail(clean(tests.output)) } : undefined,
  };
}
