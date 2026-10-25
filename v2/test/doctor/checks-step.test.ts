// The setup assistant's checks step (docs/v2/milestone-5-plan.md, sections
// 1 and 7, issue #415): POST /api/setup/checks runs the ready section in the
// person's language and answers its lines; the step is done when none
// failed, and the machine's time is the run's. The owner's only. Against the
// fakes of the ready tests, the step built with them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { HttpError } from '../../src/setup/http.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';
import type { StepDeps } from '../../src/setup/step.ts';
import { checksStep } from '../../src/setup/steps/checks.ts';
import STEPS_DEFAULT from '../../src/setup/steps/checks.ts';
import type { ChecksView } from '../../src/doctor/types.ts';
import { FORGE_VALUE, MODEL_VALUE, install, type Install } from './support.ts';

async function serve(made: Install, run: (call: (body: unknown, user?: string) => Promise<{ status: number; text: string; json: any }>, records: SetupRecords) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec(SETUP_STEPS_TABLE);
  const records = new SetupRecords(db);
  const deps = {
    db, records, env: made.env, fromEnvironment: new Set<string>(), fetch: made.github.fetch, now: () => new Date(),
    owner: async (context) => {
      if (context.request.headers['x-test-user'] !== 'owner') throw new HttpError(403, 'the setup is the owner\'s');
      return { id: 'u1', name: 'alex' } as never;
    },
    onStop: () => undefined,
    container: undefined as never,
  } satisfies StepDeps;
  const step = checksStep(() => made.probes());
  const app: App = { registry: defaultRegistry(), tables: [], routes: step.routes?.(deps) ?? [] };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (body, user = 'owner') => {
      const response = await fetch(`${base}/api/setup/checks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text) };
    }, records);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test('the step is filled, may be skipped, and its file is the registry\'s', () => {
  assert.equal(STEPS_DEFAULT.id, 'checks');
  assert.equal(STEPS_DEFAULT.filled, true);
  assert.equal(STEPS_DEFAULT.skippable, true);
});

test('all well: the lines in the asked language, none failed, the step done with the machine\'s time', async () => {
  const made = install();
  await serve(made, async (call, records) => {
    const en = await call({ language: 'en' });
    assert.equal(en.status, 200, en.text);
    const view = en.json as ChecksView;
    assert.equal(view.failed, 0);
    assert.ok(view.lines.length >= 11);
    assert.ok(view.lines.every((line) => line.level === 'ok'), en.text);
    assert.ok(typeof view.tookMs === 'number' && view.tookMs >= 0);
    assert.ok(!en.text.includes(FORGE_VALUE) && !en.text.includes(MODEL_VALUE));
    assert.equal(records.get('checks')?.doneAt !== null, true, 'done');
    const fr = await call({ language: 'fr' });
    assert.notDeepEqual(fr.json.lines.map((l: { text: string }) => l.text), view.lines.map((l) => l.text));
  });
});

test('a failure: counted, said with what to do, and the step not done', async () => {
  const made = install();
  made.env.GH_TOKEN = '';
  await serve(made, async (call, records) => {
    const answer = await call({ language: 'en' });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.failed, 1);
    const forge = answer.json.lines.find((line: { id: string }) => line.id === 'forge');
    assert.equal(forge.level, 'fail');
    assert.ok(forge.todo);
    assert.equal(records.get('checks')?.doneAt ?? null, null, 'not done');
    assert.ok((records.get('checks')?.machineMs ?? -1) >= 0, 'the run counted as the machine\'s time');
  });
});

test('a language other than English or French reads as the app\'s; anyone but the owner is refused', async () => {
  const made = install();
  made.env.CLEARED_V2_APP_LANGUAGE = 'en';
  await serve(made, async (call) => {
    const odd = await call({ language: 'de' });
    assert.equal(odd.status, 200);
    const en = await call({ language: 'en' });
    assert.deepEqual(odd.json.lines.map((l: { text: string }) => l.text), en.json.lines.map((l: { text: string }) => l.text));
    const other = await call({ language: 'en' }, 'someone');
    assert.equal(other.status, 403);
  });
});
