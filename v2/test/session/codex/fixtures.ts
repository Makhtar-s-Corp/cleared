// Codex `codex exec --json` lines. thread.started, turn.started, an
// agent_message item and turn.completed with its usage are the shape
// RECORDED on this server on 2026-10-21 (docs/adapters.md, proofs 7 and 8),
// with the numbers changed. The command_execution, file_change, web_search
// and turn.failed lines are WRITTEN FROM THE DOCUMENTED FORMAT (the
// non-interactive mode page and the TypeScript SDK's item types), NOT
// RECORDED: nobody had a Codex session for this lane. The token_count line is
// the shape of a rollout file's line on this server, every value invented.
// The owner's trial replaces the unrecorded ones with a recording
// (docs/adapters.md, Codex).
export const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

export const threadStarted = (thread = THREAD) => ({ type: 'thread.started', thread_id: thread });
export const turnStarted = () => ({ type: 'turn.started' });
export const says = (id: string, text: string) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
export const commandStarted = (id: string, command: string) =>
  ({ type: 'item.started', item: { id, type: 'command_execution', command, aggregated_output: '', status: 'in_progress' } });
export const commandDone = (id: string, command: string, output: string, exitCode = 0) =>
  ({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? 'completed' : 'failed' } });
export const fileChange = (id: string, changes: readonly { path: string; kind: 'add' | 'delete' | 'update' }[]) =>
  ({ type: 'item.completed', item: { id, type: 'file_change', changes, status: 'completed' } });
export const webSearch = (id: string, query: string) => ({ type: 'item.started', item: { id, type: 'web_search', query } });
export const turnCompleted = (usage = { input_tokens: 14010, cached_input_tokens: 11520, cache_write_input_tokens: 0, output_tokens: 25, reasoning_output_tokens: 10 }) =>
  ({ type: 'turn.completed', usage });
export const turnFailed = (message: string) => ({ type: 'turn.failed', error: { message } });

export const tokenCount = (primary: { used: number; resets: number } | null, secondary: { used: number; resets: number } | null) => ({
  timestamp: '2026-10-24T10:00:00.000Z', type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 105 } },
    rate_limits: {
      limit_id: 'invented', limit_name: null,
      primary: primary && { used_percent: primary.used, window_minutes: 10080, resets_at: primary.resets },
      secondary: secondary && { used_percent: secondary.used, window_minutes: 300, resets_at: secondary.resets },
      credits: null, plan_type: 'invented',
    },
  },
});
