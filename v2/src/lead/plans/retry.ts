// What the third and last automatic attempt of a plan's ticket is told
// (issue #290): the report its reviewer wrote last, and the output of the
// last test run that failed in one of its sessions, read from the ledger's
// session events. Each cut, the end of a test run kept (where a runner
// says what failed), and cleaned again before it goes into a prompt.
import { lastReport } from '../../flow/prompts.ts';
import { readToolInput, readToolOutput } from '../../session/events.ts';
import type { Store } from '../../store/db.ts';

export const RETRY_TEXT_LIMIT = 4000;

// A command that runs a project's tests or checks: the program and its
// first argument decide, not a word anywhere in the line (`cat test/x`
// reads a file). A leading `cd dir &&` and variable assignments are skipped.
const RUNNER = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:test|tests|check|typecheck|lint)(?::[\w:-]+)?|npx\s+(?:--no-install\s+)?(?:vitest|jest|mocha|tsc)|(?:vitest|jest|mocha|pytest|tsc)|python3?\s+-m\s+pytest|node\s+--test|make\s+(?:test|check|lint)|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|bundle\s+exec\s+rspec)(?=\s|$)/;
export function isTestCommand(command: string): boolean {
  let rest = command.trim();
  for (;;) {
    const step = /^(?:cd\s+\S+\s*&&\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/.exec(rest);
    if (!step) break;
    rest = rest.slice(step[0].length);
  }
  return RUNNER.test(rest);
}

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
        if (command && isTestCommand(command) && output.kind === 'execute' && output.isError) tests = { command, output: output.output };
      }
    }
  }
  return {
    review: review === undefined ? undefined : head(clean(review)),
    tests: tests ? { command: clean(tests.command), output: tail(clean(tests.output)) } : undefined,
  };
}
