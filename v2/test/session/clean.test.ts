import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { testValuesOf } from '../../src/secrets/live.ts';
import { COMMAND_OUTPUT_LIMIT, GUARD_PATTERNS, cleanText, createCleaner, secretValues, withoutTestValues, type Cleaner } from '../../src/session/clean.ts';
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

test('the cleaner keeps the guard patterns word for word (lib/guard/codex-guard.ts)', () => {
  const guard = readFileSync(new URL('../../../lib/guard/codex-guard.ts', import.meta.url), 'utf8');
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

// The one event the cleaner gives back for one it is handed, or null.
function one(c: Cleaner, e: AgUiEvent): AgUiEvent | null {
  const out = c.clean(e);
  assert.ok(out.length <= 1, `one event expected, got ${JSON.stringify(out)}`);
  return out[0] ?? null;
}

test('a read keeps its path and size, never the content of the file', () => {
  const c = cleaner();
  one(c, event({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Read' }));
  const args = one(c, toolArgs('t1', { kind: 'read', path: 'src/app.ts' }));
  assert.deepEqual(args, toolArgs('t1', { kind: 'read', path: 'src/app.ts' }));
  // The harness hands the file content: only its size is kept.
  const result = one(c, event({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 't1', role: 'tool', content: 'const a = 1;\nconst b = 2;\n' }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(result), { kind: 'read', path: 'src/app.ts', bytes: 26 });
  // Even a well-formed output that carries extra fields loses them.
  const sneaky = one(c, event({ type: 'TOOL_CALL_RESULT', messageId: 'm2', toolCallId: 't1', role: 'tool', content: JSON.stringify({ kind: 'read', path: 'src/app.ts', bytes: 26, text: 'const a = 1;' }) }));
  assert.ok(sneaky && sneaky.type === 'TOOL_CALL_RESULT');
  assert.ok(!JSON.stringify(sneaky).includes('const a'));
});

test('a result whose call is unknown keeps nothing of its content', () => {
  const c = cleaner();
  const result = one(c, event({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 'unknown', role: 'tool', content: 'secret file body' }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(result), { kind: 'other', ok: true });
  // Nor in Cleared's own form: without the call's ARGS, no output and no error stay.
  const shaped = one(c, toolResult('m2', 'unknown-2', { kind: 'execute', output: 'secret file body', cut: 0, isError: true }));
  assert.ok(shaped && shaped.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(shaped), { kind: 'execute', output: '', cut: 0, isError: true });
  const failed = one(c, toolResult('m3', 'unknown-3', { kind: 'edit', ok: false, error: 'secret file body' }));
  assert.ok(failed && failed.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(failed), { kind: 'edit', ok: false });
  const read = one(c, toolResult('m4', 'unknown-4', { kind: 'read', path: 'src/a.ts', bytes: 12 }));
  assert.ok(read && read.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(read), { kind: 'read', path: 'src/a.ts', bytes: 12 });
});

test('fixture events lose the token, the key, the environment variable, the secret value and the service path', () => {
  const c = cleaner();
  one(c, toolArgs('t9', { kind: 'execute', command: 'npm test' }));
  const output = [`token ${apiKey}`, privateKey, envLine, `forge ${forgeValue}`, `state in ${servicePath}/ledger.db`].join('\n');
  const events = [
    c.clean(event({ type: 'TOOL_CALL_RESULT', messageId: 'm9', toolCallId: 't9', role: 'tool', content: output })),
    c.clean(event({ type: 'TEXT_MESSAGE_START', messageId: 'a9', role: 'assistant' })),
    c.clean(event({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a9', delta: output })),
    c.clean(event({ type: 'TEXT_MESSAGE_END', messageId: 'a9' })),
    c.clean(event({ type: 'RUN_ERROR', message: output })),
  ].flat();
  assert.deepEqual(events.map((e) => e.type), ['TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_ERROR']);
  const stored = JSON.stringify(events);
  for (const value of [apiKey, 'PRIVATE KEY', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', 'ghp_', forgeValue, servicePath]) assert.ok(!stored.includes(value), `${value} is still in a stored event`);
  for (const marker of ['API key', 'private key', 'assigned secret', 'secret', 'service path']) assert.ok(stored.includes(`[removed: ${marker}]`), marker);
});

test('a command keeps its command, description and output, cleaned; an edit keeps its counts', () => {
  const c = cleaner();
  const args = one(c, toolArgs('t2', { kind: 'execute', command: `${envLine} npm test`, description: 'Run the tests' }));
  assert.ok(args && args.type === 'TOOL_CALL_ARGS');
  assert.ok(!args.delta.includes('ghp_'));
  const result = one(c, toolResult('m2', 't2', { kind: 'execute', output: `ok 1\n${apiKey}\n`, cut: 0, isError: false }));
  assert.ok(result && result.type === 'TOOL_CALL_RESULT');
  const output = readToolOutput(result);
  assert.equal(output.kind, 'execute');
  if (output.kind === 'execute') assert.equal(output.output, 'ok 1\n[removed: API key]\n');

  const edit = one(c, toolArgs('t3', { kind: 'edit', path: 'src/app.ts', added: 3, removed: 1 }));
  assert.deepEqual(edit, toolArgs('t3', { kind: 'edit', path: 'src/app.ts', added: 3, removed: 1 }));
  const failed = one(c, toolResult('m3', 't3', { kind: 'edit', ok: false, error: `cannot write ${servicePath}/x` }));
  assert.ok(failed && failed.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(failed), { kind: 'edit', ok: false, error: 'cannot write [removed: service path]/x' });
});

test(`command output is cut at COMMAND_OUTPUT_LIMIT (${COMMAND_OUTPUT_LIMIT} characters), keeping its start and its end`, () => {
  assert.equal(COMMAND_OUTPUT_LIMIT, 4096);
  const c = cleaner();
  one(c, toolArgs('t4', { kind: 'execute', command: 'npm test' }));
  const run = (output: string): ToolOutput => {
    const result = one(c, event({ type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't4', role: 'tool', content: output }));
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
  const start = one(c, { type: 'REASONING_START', messageId: 'r1', content: 'thinking about secrets' } as unknown as AgUiEvent);
  assert.deepEqual(start, { type: 'REASONING_START', messageId: 'r1' });
  for (const type of ['RAW', 'REASONING_MESSAGE_CONTENT', 'TEXT_MESSAGE_CHUNK', 'MESSAGES_SNAPSHOT', 'SUBAGENT_STARTED', 'NOT_AN_EVENT']) {
    assert.equal(one(c, { type, delta: 'x' } as unknown as AgUiEvent), null, type);
  }
  assert.equal(one(c, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: `key ${apiKey}`, rawEvent: { apiKey } } as unknown as AgUiEvent), null, 'text waits for the end of its message');
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_END', messageId: 'a1', rawEvent: { apiKey } } as unknown as AgUiEvent), [
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'key [removed: API key]' },
    { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
  ]);
});

test('custom events and state are cleaned in every string they carry', () => {
  const c = cleaner();
  const request = one(c, {
    type: 'CUSTOM',
    name: 'cleared.permission_request',
    value: { requestId: 'q1', toolCallId: 't1', tool: 'Bash', input: { kind: 'execute', command: `echo ${forgeValue}` }, suggestion: { decision: 'ask', rule: 'default', reason: 'nothing matched' } },
  });
  assert.ok(request && !JSON.stringify(request).includes(forgeValue));
  const snapshot = one(c, {
    type: 'STATE_SNAPSHOT',
    snapshot: { status: `reading ${servicePath}`, phase: 'working', steps: [], files: [], checks: [], usage: {} },
  });
  assert.ok(snapshot && !JSON.stringify(snapshot).includes(servicePath));
  assert.equal(one(c, { type: 'CUSTOM', name: 'not.cleared', value: {} } as unknown as AgUiEvent), null, 'only Cleared names are kept');
});

test('a secret split across the deltas of one message is removed: text is cleaned per message (review round 1, finding 4)', () => {
  const c = cleaner();
  const half = Math.floor(apiKey.length / 2);
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }), [{ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }]);
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: `the key is ${apiKey.slice(0, half)}` }), []);
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: `${apiKey.slice(half)} here` }), []);
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_END', messageId: 'a1' }), [
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'the key is [removed: API key] here' },
    { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
  ]);
  // A message without content ends alone; a message the run ends without is closed before the run's end.
  assert.deepEqual(c.clean({ type: 'TEXT_MESSAGE_END', messageId: 'a2' }), [{ type: 'TEXT_MESSAGE_END', messageId: 'a2' }]);
  c.clean({ type: 'TEXT_MESSAGE_START', messageId: 'a3', role: 'assistant' });
  c.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a3', delta: 'cut short' });
  const end = c.clean({ type: 'RUN_ERROR', message: 'the runner died' });
  assert.deepEqual(end.map((e) => e.type), ['TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_ERROR']);
  assert.deepEqual(end[0], { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a3', delta: 'cut short' });
});

test('raw output that happens to be JSON with a kind stays raw output (review round 1, finding 2)', () => {
  const c = cleaner();
  const result = (toolCallId: string, content: string): ToolOutput => {
    const out = one(c, event({ type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId, role: 'tool', content }));
    assert.ok(out && out.type === 'TOOL_CALL_RESULT');
    return readToolOutput(out);
  };
  one(c, toolArgs('k1', { kind: 'execute', command: 'kubectl get deploy -o json' }));
  const manifest = '{"kind":"Deployment","apiVersion":"apps/v1"}';
  assert.deepEqual(result('k1', manifest), { kind: 'execute', output: manifest, cut: 0, isError: false });
  const wrongShape = '{"kind":"execute","output":5}';
  assert.deepEqual(result('k1', wrongShape), { kind: 'execute', output: wrongShape, cut: 0, isError: false });
  const otherKind = '{"kind":"edit","ok":true}';
  assert.deepEqual(result('k1', otherKind), { kind: 'execute', output: otherKind, cut: 0, isError: false });
  one(c, toolArgs('k2', { kind: 'read', path: 'deploy.json' }));
  assert.deepEqual(result('k2', manifest), { kind: 'read', path: 'deploy.json', bytes: Buffer.byteLength(manifest) });
});

test('a malformed RUN_FINISHED is cleaned, never thrown on (review round 1, finding 3)', () => {
  const c = cleaner();
  const bare = one(c, { type: 'RUN_FINISHED' } as unknown as AgUiEvent);
  assert.deepEqual(bare, { type: 'RUN_FINISHED', threadId: '', runId: '', outcome: { type: 'success' }, usage: [], result: { stopReason: 'error', total_cost_usd: null } });
  const odd = one(c, { type: 'RUN_FINISHED', threadId: `t ${apiKey}`, runId: 7, outcome: 'x', usage: [null, 3, { inputTokens: 5, outputTokens: 'many', model: 'm' }], result: { stopReason: 'whatever', total_cost_usd: '1' } } as unknown as AgUiEvent);
  assert.deepEqual(odd, { type: 'RUN_FINISHED', threadId: 't [removed: API key]', runId: '', outcome: { type: 'success' }, usage: [{ inputTokens: 5, model: 'm' }], result: { stopReason: 'error', total_cost_usd: null } });
  const cancelled = one(c, { type: 'RUN_FINISHED', threadId: 's', runId: 'r', result: { stopReason: 'cancelled', total_cost_usd: 0.2 } } as unknown as AgUiEvent);
  assert.deepEqual(cancelled, { type: 'RUN_FINISHED', threadId: 's', runId: 'r', outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: 0.2 } });
  assert.equal(one(c, { type: 'STEP_STARTED', stepName: 'unknown' } as unknown as AgUiEvent), null, 'a step outside the measured ones is dropped');
  assert.deepEqual(one(c, { type: 'TOOL_CALL_START', toolCallId: 9, toolCallName: null } as unknown as AgUiEvent), { type: 'TOOL_CALL_START', toolCallId: '', toolCallName: '' });
});

test('identifiers pass whole, even when their digits read as a phone number: the answer to a request names it by its id', () => {
  // The last group holds ten digits that start with 06, which the phone
  // pattern matches (built from parts, so the guard does not read this file as one).
  const digits = ['06', '1234', '5678'].join('');
  const requestId = `55ddd20b-469d-40d9-b2f0-${digits}e4`;
  const toolCallId = `toolu_${digits}AbCdEfGh`;
  const cleaner = createCleaner({});
  const [request] = cleaner.clean({ type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId, toolCallId, tool: 'Bash', input: { command: 'git commit' } } } as AgUiEvent);
  const value = (request as Extract<AgUiEvent, { type: 'CUSTOM' }>).value as Record<string, unknown>;
  assert.equal(value.requestId, requestId);
  assert.equal(value.toolCallId, toolCallId);
  const [start] = cleaner.clean({ type: 'TOOL_CALL_START', toolCallId, toolCallName: 'Bash' } as AgUiEvent);
  assert.equal((start as { toolCallId: string }).toolCallId, toolCallId);
  // Something that is not an id's shape is still cleaned.
  const [odd] = cleaner.clean({ type: 'TOOL_CALL_START', toolCallId: `call ${apiKey}`, toolCallName: 'Bash' } as AgUiEvent);
  assert.ok(!(odd as { toolCallId: string }).toolCallId.includes(apiKey));
});

// ------------------------------------------------------- the test secrets (C16)
//
// docs/v2/milestone-5-plan.md, decision 12: a test secret's value is given to
// a session, so the cleaner removes it as it removes the environment's
// secrets, from every event, comment and pull request body. The list is the
// secrets module's store (src/secrets/live.ts), read from memory at each text.
// Fake values only, made at run time.

const testValue = (n: number): string => ['sandbox', 'fake', 'value', String(n)].join('-');

function testValues() {
  const state = mkdtempSync(join(tmpdir(), 'cleared-clean-secrets-'));
  test.after(() => rmSync(state, { recursive: true, force: true }));
  return testValuesOf(new DatabaseSync(':memory:'), { CLEARED_V2_STATE_DIR: state });
}

test('a test secret\'s value is removed from an event, a comment and a pull request body', () => {
  const store = testValues();
  store.set('api', 'PAYMENT_SANDBOX_KEY', testValue(1), 'u1');
  assert.ok(secretValues({}).includes(testValue(1)), 'in the cleaner\'s list with the environment\'s');

  const cleaner = createCleaner({ secrets: secretValues({}) });
  const events = [
    ...cleaner.clean({ type: 'TEXT_MESSAGE_START', messageId: 'msg_0123456789', role: 'assistant' } as AgUiEvent),
    ...cleaner.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_0123456789', delta: `The key is ${testValue(1).slice(0, 7)}` } as AgUiEvent),
    ...cleaner.clean({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_0123456789', delta: `${testValue(1).slice(7)}, from the sandbox.` } as AgUiEvent),
    ...cleaner.clean({ type: 'TEXT_MESSAGE_END', messageId: 'msg_0123456789' } as AgUiEvent),
  ];
  const text = JSON.stringify(events);
  assert.ok(!text.includes(testValue(1)), 'not in the event, even split across deltas');
  assert.match(text, /\[removed: secret\]/);

  const comment = cleanText(`The tests passed with ${testValue(1)} as the sandbox's key.`, { secrets: secretValues({}) });
  assert.equal(comment, 'The tests passed with [removed: secret] as the sandbox\'s key.');

  const body = withoutTestValues(`## Done\nRan the payment tests against ${testValue(1)}.\n\nCommits:\n- Use ${testValue(1)} in the fixture\n`);
  assert.ok(!body.includes(testValue(1)));
  assert.equal(body.split('[removed: secret]').length, 3, 'every occurrence');
  assert.equal(withoutTestValues('No value here, and an address a@b.example stays.'), 'No value here, and an address a@b.example stays.', 'only the test values: the body keeps everything else as it was');
});

test('a replaced or removed test value is still removed: a session started before the change holds it', () => {
  const store = testValues();
  store.set('api', 'PAYMENT_SANDBOX_KEY', testValue(2), 'u1');
  store.set('api', 'PAYMENT_SANDBOX_KEY', testValue(3), 'u1');
  store.remove('api', 'PAYMENT_SANDBOX_KEY', 'u1');
  const out = cleanText(`old ${testValue(2)} new ${testValue(3)}`, { secrets: secretValues({}) });
  assert.equal(out, 'old [removed: secret] new [removed: secret]');
});
