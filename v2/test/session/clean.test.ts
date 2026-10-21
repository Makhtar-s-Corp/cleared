import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COMMAND_OUTPUT_LIMIT, GUARD_PATTERNS, cleanText, createCleaner, secretValues } from '../../src/session/clean.ts';
import { readToolOutput, toolArgs, toolResult, type AgUiEvent, type ToolOutput } from '../../src/session/events.ts';

// Secret-shaped values are assembled at run time: written whole, they would
// make the repository guard refuse this file, which is what it is for.
const apiKey = ['sk', 'ant', 'api03', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-');
const keyHeader = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const privateKey = [keyHeader, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')].join('\n');
const envLine = 'GITHUB_' + 'TOKEN' + '=' + 'ghp' + '_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2';
const forgeValue = 'f0rge' + '-value-' + '7c41d9e2b8';
const servicePath = '/home/someone/.local/state/cleared/demo';
const databaseValue = 'p4ss' + '-w0rd-long';

const cleaner = () => createCleaner({ secrets: [forgeValue], servicePaths: [servicePath] });

test('the cleaner keeps the guard patterns word for word (lib/guard/codex-guard.mjs)', () => {
  const guard = readFileSync(new URL('../../../lib/guard/codex-guard.mjs', import.meta.url), 'utf8');
  assert.ok(GUARD_PATTERNS.length >= 10);
  for (const [category, pattern] of GUARD_PATTERNS) {
    assert.ok(guard.includes(`/${pattern.source}/${pattern.flags}`), `${category}: /${pattern.source}/${pattern.flags} is not in the guard`);
    assert.ok(guard.includes(`"${category}"`), `${category} is not a category of the guard`);
  }
});

test('a token, a key, an environment variable and the service path are removed from text', () => {
  const text = [
    `using ${apiKey} now`,
    privateKey,
    envLine,
    `forge: ${forgeValue}`,
    `ledger at ${servicePath}/ledger.db`,
    `mail ${['someone', 'gmail.com'].join('@')}`,
  ].join('\n');
  const clean = cleanText(text, { secrets: [forgeValue], servicePaths: [servicePath] });
  for (const value of [apiKey, 'PRIVATE KEY', 'ghp_', forgeValue, servicePath, '/home/someone', 'gmail']) assert.ok(!clean.includes(value), `${value} is still in: ${clean}`);
  assert.match(clean, /\[removed: API key\]/);
  assert.match(clean, /\[removed: private key\]/);
  assert.match(clean, /\[removed: assigned secret\]/);
  assert.match(clean, /\[removed: secret\]/);
  assert.match(clean, /\[removed: service path\]\/ledger\.db/);
  assert.match(clean, /\[removed: email address\]/);
  assert.equal(cleanText('npm test passed: 12 tests', {}), 'npm test passed: 12 tests', 'plain text is unchanged');
  assert.ok(!clean.includes('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'), 'the whole key block goes');
  // A key whose end line was cut off takes the rest of the text with it.
  assert.equal(cleanText(`before\n${keyHeader}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nafter`, {}), 'before\n[removed: private key]');
});

test('the secret values of the environment are the ones named like secrets, long enough to be one', () => {
  const values = secretValues({ CLEARED_FORGE_TOKEN: forgeValue, ANTHROPIC_API_KEY: apiKey, PATH: '/usr/bin:/bin', SHORT_SECRET: 'abc', DB_PASSWORD: databaseValue, HOME: '/home/x' });
  assert.deepEqual([...values].sort(), [apiKey, forgeValue, databaseValue].sort());
});

test('a private term (names, places, amounts) removes the whole value, as the guard fingerprints it', () => {
  const salt = 'test-salt';
  const fingerprint = (term: string) => createHash('sha256').update(salt + term).digest('hex');
  const privateTerms = { salt, fingerprints: new Set([fingerprint('acme meadow'), fingerprint('12345')]) };
  assert.equal(cleanText('Ship it to Acme Meadow today', { privateTerms }), '[removed: private term]');
  assert.equal(cleanText('the total is 12 345 euros', { privateTerms }), '[removed: private term]');
  assert.equal(cleanText('Ship it to the meadow', { privateTerms }), 'Ship it to the meadow');
});

function event(e: AgUiEvent): AgUiEvent {
  return e;
}

test('a read keeps its path and size, never the content of the file', () => {
  const c = cleaner();
  c.clean(event({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Read' }));
  const args = c.clean(toolArgs('t1', { kind: 'read', path: 'src/app.ts' }));
  assert.deepEqual(args, toolArgs('t1', { kind: 'read', path: 'src/app.ts' }));
  // The harness hands the file content: only its size is kept.
  const result = c.clean(event({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 't1', role: 'tool', content: 'const a = 1;\nconst b = 2;\n' }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(result), { kind: 'read', path: 'src/app.ts', bytes: 26 });
  // Even a well-formed output that carries extra fields loses them.
  const sneaky = c.clean(event({ type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 't1', role: 'tool', content: JSON.stringify({ kind: 'read', path: 'src/app.ts', bytes: 26, text: 'const a = 1;' }) }));
  assert.ok(sneaky && sneaky.type === 'TOOL_CALL_RESULT');
  assert.ok(!JSON.stringify(sneaky).includes('const a'));
});

test('a result whose call is unknown keeps nothing of its content', () => {
  const c = cleaner();
  const result = c.clean(event({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 'unknown', role: 'tool', content: 'secret file body' }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(result), { kind: 'other', ok: true });
});

test('a command keeps its command, description and output, cleaned; an edit keeps its counts', () => {
  const c = cleaner();
  const args = c.clean(toolArgs('t2', { kind: 'execute', command: `${envLine} npm test`, description: 'Run the tests' }));
  assert.ok(args && args.type === 'TOOL_CALL_ARGS');
  assert.ok(!args.delta.includes('ghp_'));
  const result = c.clean(toolResult('m2', 't2', { kind: 'execute', output: `ok 1\n${apiKey}\n`, cut: 0, isError: false }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  const output = readToolOutput(result);
  assert.equal(output.kind, 'execute');
  if (output.kind === 'execute') assert.equal(output.output, 'ok 1\n[removed: API key]\n');

  const edit = c.clean(toolArgs('t3', { kind: 'edit', path: 'src/app.ts', added: 3, removed: 1 }));
  assert.deepEqual(edit, toolArgs('t3', { kind: 'edit', path: 'src/app.ts', added: 3, removed: 1 }));
  const failed = c.clean(toolResult('m3', 't3', { kind: 'edit', ok: false, error: `cannot write ${servicePath}/x` }));
  assert.ok(failed && failed.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(failed), { kind: 'edit', ok: false, error: 'cannot write [removed: service path]/x' });
});

test(`command output is cut at COMMAND_OUTPUT_LIMIT (${COMMAND_OUTPUT_LIMIT} characters), keeping its start and its end`, () => {
  assert.equal(COMMAND_OUTPUT_LIMIT, 4096);
  const c = cleaner();
  c.clean(toolArgs('t4', { kind: 'execute', command: 'npm test' }));
  const run = (output: string): ToolOutput => {
    const result = c.clean(event({ type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't4', role: 'tool', content: output }));
    assert.ok(result && result.type === 'TOOL_CALL_RESULT');
    return readToolOutput(result);
  };
  const exact = 'a'.repeat(COMMAND_OUTPUT_LIMIT);
  assert.deepEqual(run(exact), { kind: 'execute', output: exact, cut: 0, isError: false });

  const over = 'h' + 'm'.repeat(COMMAND_OUTPUT_LIMIT - 1) + 'END';
  const cut = run(over);
  assert.equal(cut.kind, 'execute');
  if (cut.kind !== 'execute') return;
  assert.equal(cut.cut, 3);
  assert.ok(cut.output.startsWith('hm'));
  assert.ok(cut.output.endsWith('mEND'));
  assert.match(cut.output, /\n\[cleared: 3 characters cut\]\n/);
  assert.equal(cut.output.replace(/\n\[cleared: 3 characters cut\]\n/, '').length, COMMAND_OUTPUT_LIMIT);
  // A character outside the basic plane is never split in two.
  const wide = '\u{1F600}'.repeat(COMMAND_OUTPUT_LIMIT + 10);
  const kept = run(wide);
  if (kept.kind === 'execute') assert.equal(kept.output.replace(/\n\[cleared: 10 characters cut\]\n/, ''), '\u{1F600}'.repeat(COMMAND_OUTPUT_LIMIT));
});

test('reasoning keeps its ids only; raw and unused events are dropped; rawEvent never stays', () => {
  const c = cleaner();
  const start = c.clean({ type: 'REASONING_START', messageId: 'r1', content: 'thinking about secrets' } as unknown as AgUiEvent);
  assert.deepEqual(start, { type: 'REASONING_START', messageId: 'r1' });
  for (const type of ['RAW', 'REASONING_MESSAGE_CONTENT', 'TEXT_MESSAGE_CHUNK', 'MESSAGES_SNAPSHOT', 'SUBAGENT_STARTED', 'NOT_AN_EVENT']) {
    assert.equal(c.clean({ type, delta: 'x' } as unknown as AgUiEvent), null, type);
  }
  const text = c.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: `key ${apiKey}`, rawEvent: { apiKey } } as unknown as AgUiEvent);
  assert.deepEqual(text, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'key [removed: API key]' });
});

test('custom events and state are cleaned in every string they carry', () => {
  const c = cleaner();
  const request = c.clean({
    type: 'CUSTOM',
    name: 'cleared.permission_request',
    value: { requestId: 'q1', toolCallId: 't1', tool: 'Bash', input: { kind: 'execute', command: `echo ${forgeValue}` }, suggestion: { decision: 'ask', rule: 'default', reason: 'nothing matched' } },
  });
  assert.ok(request && !JSON.stringify(request).includes(forgeValue));
  const snapshot = c.clean({
    type: 'STATE_SNAPSHOT',
    snapshot: { status: `reading ${servicePath}`, phase: 'working', steps: [], files: [], checks: [], usage: {} },
  });
  assert.ok(snapshot && !JSON.stringify(snapshot).includes(servicePath));
  assert.equal(c.clean({ type: 'CUSTOM', name: 'not.cleared', value: {} } as unknown as AgUiEvent), null, 'only Cleared names are kept');
});
