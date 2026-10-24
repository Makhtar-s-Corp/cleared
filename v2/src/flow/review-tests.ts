// The reviewer's run of the service's tests (issue #268): the declared test
// command (ProjectSettings.testCommand) is the one command a reviewer runs,
// and its result goes into the verdict and the ticket's thread. It is read
// from the session's events in the ledger, never from what the report says:
// the last call of the turn whose command is the declared one, paired with
// its result.
//
//   passed    the command ran alone and exited 0
//   failed    it ran alone and exited with an error
//   unclear   it ran in a pipe or a list, whose status is not the tests'
//   not_run   the turn has no such call, or its result never came
import { parseList } from '../session/policy.ts';
import { readToolInput, readToolOutput, type CustomValue, type SessionEvent } from '../session/events.ts';

export type TestRun = NonNullable<CustomValue['cleared.review_verdict']['tests']>;

// The lines of the output a verdict and a comment keep.
export const TAIL_LINES = 15;

const same = (words: readonly string[], declared: readonly string[]) => words.length === declared.length && words.every((word, i) => word === declared[i]);

export function testRunOf(events: readonly SessionEvent[], declared: readonly string[] | undefined): TestRun | undefined {
  if (!declared || declared.length === 0) return undefined;
  const command = declared.join(' ');
  const calls = new Map<string, boolean>();                        // the call's id, and whether it ran alone
  let last: TestRun = { command, outcome: 'not_run' };
  for (const { event } of events) {
    if (event.type === 'TOOL_CALL_ARGS') {
      const input = readToolInput(event);
      if (input?.kind !== 'execute') continue;
      const list = parseList(input.command);
      if (!list || !list.some((part) => same(part.words, declared))) continue;
      calls.set(event.toolCallId, list.length === 1);
    } else if (event.type === 'TOOL_CALL_RESULT') {
      const alone = calls.get(event.toolCallId);
      if (alone === undefined) continue;
      calls.delete(event.toolCallId);
      const output = readToolOutput(event);
      if (output.kind !== 'execute') continue;
      const tail = output.output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
      last = { command, outcome: !alone ? 'unclear' : output.isError ? 'failed' : 'passed', tail };
    }
  }
  return last;
}

// The run in one line, for the verdict's announcement and the author's request.
export function testLine(run: TestRun): string {
  const name = `\`${run.command}\``;
  switch (run.outcome) {
    case 'passed': return `Tests: ${name} passed in the reviewer's session.`;
    case 'failed': return `Tests: ${name} failed in the reviewer's session.`;
    case 'unclear': return `Tests: ${name} ran in a pipe or a list in the reviewer's session, so its exit status is not known.`;
    case 'not_run': return `Tests: the reviewer did not run ${name}.`;
  }
}

// The comment on the ticket: the line, and the output's last lines when it ran.
export function testComment(run: TestRun, round: number): string {
  const head = `Review round ${round}. ${testLine(run)}`;
  return run.tail ? `${head}\n\nThe last lines of its output:\n\n\`\`\`\n${run.tail.replaceAll('```', "'''")}\n\`\`\`` : head;
}
