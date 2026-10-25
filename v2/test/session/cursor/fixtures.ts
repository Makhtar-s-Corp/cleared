// Cursor `agent -p --output-format stream-json` lines, WRITTEN FROM THE
// DOCUMENTED FORMAT (cursor.com/docs/cli/reference/output-format, read on
// 2026-10-23), NOT RECORDED from a real run: nobody had a Cursor account for
// this lane. They prove the mapper and the adapter against the documented
// shape only. The owner's trial replaces them with a recording
// (docs/adapters.md, Cursor).
export const CHAT = 'b1c2d3e4-1111-4222-8333-444455556666';

export const init = (chat = CHAT) => ({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/workspace', session_id: chat, model: 'Sonnet 4.5', permissionMode: 'default' });
export const userLine = (chat = CHAT) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] }, session_id: chat });
export const says = (text: string, chat = CHAT) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: chat });
export const readStarted = (id: string, path: string, chat = CHAT) => ({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { readToolCall: { args: { path } } }, session_id: chat });
export const readDone = (id: string, path: string, content: string, chat = CHAT) =>
  ({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { readToolCall: { args: { path }, result: { success: { content, isEmpty: false, exceededLimit: false, totalLines: 1, totalChars: content.length } } } }, session_id: chat });
export const writeStarted = (id: string, path: string, fileText: string, chat = CHAT) =>
  ({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { writeToolCall: { args: { path, fileText, toolCallId: id } } }, session_id: chat });
export const writeDone = (id: string, path: string, fileText: string, chat = CHAT) =>
  ({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { writeToolCall: { args: { path, fileText, toolCallId: id }, result: { success: { path, linesCreated: fileText.split('\n').length, fileSize: fileText.length } } } }, session_id: chat });
export const shellStarted = (id: string, command: string, chat = CHAT) =>
  ({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { function: { name: 'shell', arguments: JSON.stringify({ command }) } }, session_id: chat });
export const resultLine = (text: string, chat = CHAT) => ({ type: 'result', subtype: 'success', duration_ms: 1234, duration_api_ms: 1234, is_error: false, result: text, session_id: chat, request_id: 'req-1' });
