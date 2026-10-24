// An agent's question with choices, through the service's own routes (issue
// #269): the author asks "Which database?", the change stream says "inbox"
// and GET /api/inbox lists the question with its options within 5 s of the
// ticket's start; the answer route given one option's label hands that
// answer to the session, which carries on to its release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiRoutes } from '../../src/api/routes.ts';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type ChangeEvent, type QuestionItem } from '../../src/api/types.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { Answer, SessionAdapter } from '../../src/session/contract.ts';
import type { CustomValue } from '../../src/session/events.ts';
import { finished, setup, started, text, until } from './support.ts';

const PROOF = 'q'.repeat(64);
const SHOWN_MS = 5000;
const QUESTION: CustomValue['cleared.question'] = {
  requestId: 'q-db',
  questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres (Recommended)', description: 'The one the tests run' }, { label: 'SQLite' }] }],
};

test('the question is in the inbox with its choices within 5 s, said on the stream; a click\'s answer reaches the session, which carries on', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'One thing to settle.'), { question: QUESTION }, ...text('a2', 'Done.'), finished(0.3)] } });
  // What the session is handed, as the harness would be.
  const given: Answer[] = [];
  const adapter = t.registry.sessionAdapters['claude-code'] as SessionAdapter;
  const start = adapter.start.bind(adapter);
  (adapter as { start: SessionAdapter['start'] }).start = async (input) => {
    const session = await start(input);
    return { ...session, answer: async (requestId, answer) => { given.push(answer); await session.answer(requestId, answer); } };
  };
  const app: App = { registry: t.engine.registry, tables: [], routes: createApiRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signed = { [SERVICE_PROOF_HEADER]: PROOF };
  const controller = new AbortController();
  try {
    const stream = await fetch(`${base}/api/events`, { headers: signed, signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let said = '';
    const kinds = (): string[] => [...said.matchAll(/^data: (.*)$/gm)].map((m) => (JSON.parse(m[1] as string) as ChangeEvent).kind);
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        said += decoder.decode(value, { stream: true });
      }
    })();
    await until(() => said.includes(': stream open'), 'the stream open');

    const from = Date.now();
    await t.engine.start(t.ticket.id, 'u1');
    let item: QuestionItem | undefined;
    await until(async () => {
      const listed = await (await fetch(`${base}/api/inbox`, { headers: signed })).json() as { kind: string; state: string }[];
      item = listed.find((i): i is QuestionItem => i.kind === 'question' && i.state === 'waiting') as QuestionItem | undefined;
      return item !== undefined;
    }, 'the question listed');
    const shown = Date.now() - from;
    assert.ok(shown < SHOWN_MS, `listed after ${shown} ms`);
    await until(() => kinds().includes('inbox'), 'the inbox said on the stream');
    assert.ok(Date.now() - from < SHOWN_MS, 'said on the stream within 5 s');
    assert.equal(item!.requestId, 'q-db');
    assert.deepEqual(item!.questions[0]!.options!.map((o) => o.label), ['Postgres (Recommended)', 'SQLite'], 'the choices, as the harness gave them');
    assert.equal(item!.timeout?.answers?.['Which database?'], 'Postgres (Recommended)', 'the default that its delay\'s end applies');

    // The inbox's click on "SQLite": the session answer route, as answerRequest calls it.
    const session = item!.sessionId;
    const answered = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}/requests/q-db/answer`, {
      method: 'POST', headers: { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: { kind: 'answer', answers: { 'Which database?': 'SQLite' } } }),
    });
    assert.equal(answered.status, 200);
    assert.deepEqual(given, [{ decision: { kind: 'answer', answers: { 'Which database?': 'SQLite' } }, by: 'u1' }], 'the session is handed the label clicked, by the owner');
    assert.equal(t.inbox.items().find((i) => i.kind === 'question')?.state, 'handled');
    const again = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}/requests/q-db/answer`, {
      method: 'POST', headers: { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: { kind: 'answer', answers: { 'Which database?': 'Postgres (Recommended)' } } }),
    });
    assert.ok([404, 409].includes(again.status), `a second click finds nothing waiting (${again.status}), which the inbox reads as settled`);
    assert.equal(given.length, 1);
    await until(() => t.store.events.after(session).some((e) => e.event.type === 'CUSTOM' && e.event.name === 'cleared.answered'), 'the answer in the session\'s journal');
    await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the session carried on to its release');
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
