// The state of a session as the session screen shows it, folded from its
// stored events: the steps with their times, the files changed with counts,
// the checks, the usage and the status phrase. The phase comes from the
// flow, which knows what the session waits for.
import { readToolInput, readToolOutput, type SessionEvent, type SessionPhase, type SessionState, type StepName, type ToolInput, type Usage } from '../session/events.ts';

const PHRASES: Record<SessionPhase, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting_human: 'Paused, waiting for you',
  reviewing: 'Reviewing',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

const CHECK = /\b(test|typecheck|lint|check)\b/i;

function toolPhrase(input: ToolInput): string | undefined {
  switch (input.kind) {
    case 'execute': return input.description || `Running ${input.command}`;
    case 'read': return `Reading ${input.path}`;
    case 'edit': return `Editing ${input.path}`;
    case 'search': return `Searching for ${input.pattern}`;
    default: return undefined;
  }
}

export function foldState(events: readonly SessionEvent[], phase: SessionPhase): SessionState {
  const steps: { name: StepName; startedAt: string; finishedAt: string | null }[] = [];
  const files = new Map<string, { path: string; added: number; removed: number }>();
  const checks: { name: string; state: 'pending' | 'passed' | 'failed' }[] = [];
  const checkOf = new Map<string, number>();
  const open = new Map<string, ToolInput | undefined>();   // tool calls with no result yet
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  const seen = { inputTokens: false, outputTokens: false, cachedInputTokens: false, cacheWriteInputTokens: false };
  let model: string | undefined;

  for (const { at, event } of events) {
    switch (event.type) {
      case 'STEP_STARTED':
        steps.push({ name: event.stepName, startedAt: at, finishedAt: null });
        break;
      case 'STEP_FINISHED': {
        const step = [...steps].reverse().find((s) => s.name === event.stepName && s.finishedAt === null);
        if (step) step.finishedAt = at;
        break;
      }
      case 'TOOL_CALL_START':
        open.set(event.toolCallId, undefined);
        break;
      case 'TOOL_CALL_ARGS': {
        const input = readToolInput(event);
        open.set(event.toolCallId, input);
        if (input?.kind === 'edit') {
          const file = files.get(input.path) ?? { path: input.path, added: 0, removed: 0 };
          file.added += input.added;
          file.removed += input.removed;
          files.set(input.path, file);
        }
        if (input?.kind === 'execute' && CHECK.test(input.command)) {
          checkOf.set(event.toolCallId, checks.length);
          checks.push({ name: input.command, state: 'pending' });
        }
        break;
      }
      case 'TOOL_CALL_RESULT': {
        open.delete(event.toolCallId);
        const at_ = checkOf.get(event.toolCallId);
        const output = readToolOutput(event);
        if (at_ !== undefined && output.kind === 'execute') (checks[at_] as { state: string }).state = output.isError ? 'failed' : 'passed';
        break;
      }
      case 'RUN_FINISHED':
        for (const u of event.usage as readonly Usage[]) {
          if (u.model) model = u.model;
          for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'] as const) {
            const value = u[key];
            if (value !== undefined) { usage[key] += value; seen[key] = true; }
          }
        }
        break;
      default:
        break;
    }
  }

  const total: Usage = {
    ...(model ? { model } : {}),
    ...(seen.inputTokens ? { inputTokens: usage.inputTokens } : {}),
    ...(seen.outputTokens ? { outputTokens: usage.outputTokens } : {}),
    ...(seen.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(seen.cacheWriteInputTokens ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
  };
  let status = PHRASES[phase];
  if (phase === 'working' || phase === 'reviewing') {
    const last = [...open.values()].at(-1);
    const phrase = last ? toolPhrase(last) : undefined;
    if (phrase) status = phrase;
  }
  return { status, phase, steps, files: [...files.values()], checks, usage: total };
}
