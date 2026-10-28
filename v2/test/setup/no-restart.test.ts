// Issues #420 and #437 (lane v2-j6-workspace-reload, matrix B6.5 and M10):
// a service started with no workspace, as the one command starts it, runs
// the assistant's owner and workspace steps, then a first ticket from the
// first-ticket step and one shaped as the Tower sends it, all in the same
// process. Every module that needs the workspace comes up once the
// assistant wrote it, and both tickets carry the workspace's id. The
// modules are main.ts's own; its settings are set before they are imported,
// as the settings file is applied before anything reads a setting. The
// forge is a fake gh over bare copies of the two examples, guestbook and
// filter-api, connected as a workspace of two services; the harness the
// fake one, the mirror's tracker a recorder on loopback, and a docker
// stand-in first on PATH says each call it gets: none is expected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGh } from '../forge/fake-gh.ts';
import { remote, tempDir } from '../workspace/git.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const PASSWORD = 'a long passphrase';
// Built here, so no line of the repository holds a value shaped like a credential.
const CREDENTIAL = ['forge', 'credential', 'of', 'the', 'test'].join('-');

function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(posix.join(root, relative)).sort()) {
      const path = relative ? posix.join(relative, name) : name;
      const stat = lstatSync(posix.join(root, path));
      if (stat.isDirectory()) { if (name !== 'node_modules') walk(path); }
      else if (stat.isFile()) out[path] = readFileSync(posix.join(root, path), 'utf8');
    }
  };
  walk('');
  return out;
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('the assistant, then a first ticket and a Tower ticket, with no restart: each module that needs the workspace comes up, and both tickets carry its id', async () => {
  const state = tempDir('no-restart');
  const readme = files(`${EXAMPLES}guestbook`)['README.md'] as string;
  const repository = (name: string) => ({ repo: `example-org/${name}`, url: remote(files(`${EXAMPLES}${name}`)), base: 'main', private: false, archived: false });
  const gh = fakeGh({ repositories: [repository('guestbook'), repository('filter-api')], pulls: [] });

  // The docker stand-in: every call is written down and refused.
  const stub = join(state, 'stub');
  mkdirSync(stub);
  const dockerLog = join(state, 'docker.log');
  writeFileSync(join(stub, 'docker'), `#!/bin/sh\necho "$*" >> '${dockerLog}'\necho 'docker: not in this test' >&2\nexit 1\n`);
  chmodSync(join(stub, 'docker'), 0o755);

  // The mirror's tracker: a recorder on loopback that answers no issue.
  const asked: string[] = [];
  const tracker = createServer((request: IncomingMessage, response) => {
    asked.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
  });
  await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve));
  const trackerApi = `http://127.0.0.1:${(tracker.address() as AddressInfo).port}`;
  const trackerToken = join(state, 'mirror-token');
  writeFileSync(trackerToken, ['mirror', 'token', 'of', 'the', 'test'].join('-'), { mode: 0o600 });

  // The service's settings, as the one command gives them: a state folder, no workspace, no project.
  for (const name of Object.keys(process.env)) if (/^(CLEARED_|ORCH_|XDG_STATE_HOME$|GITHUB_TOKEN$)/.test(name)) delete process.env[name];
  const script = join(state, 'script.json');
  Object.assign(process.env, {
    HOME: join(state, 'home'),
    CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state,
    PATH: `${stub}:${gh.env.PATH as string}`, GH_TOKEN: CREDENTIAL,
    CLEARED_V2_ADAPTER: 'fake', CLEARED_V2_FAKE_SCRIPT: script,
    CLEARED_V2_QUOTA_MINUTES: '0', CLEARED_V2_MAP_MINUTES: '0', CLEARED_V2_APP_LANGUAGE: 'en',
    CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: trackerToken, CLEARED_V2_MIRROR_GITHUB_API: trackerApi,
  });
  mkdirSync(join(state, 'home'));

  const { firstTicketScript, FIRST_TICKET_LINE } = await import('../../scripts/proof-j5.ts');
  writeFileSync(script, JSON.stringify(firstTicketScript(readme, FIRST_TICKET_LINE.en)));

  // main.ts's modules, in its order, over the state folder's ledger.
  await import('../../src/setup/load.ts');
  const { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } = await import('../../src/api/types.ts');
  const { default: approval } = await import('../../src/modules/approval.ts');
  const { default: flow } = await import('../../src/modules/flow.ts');
  const { default: inbox } = await import('../../src/modules/inbox.ts');
  const { default: knowledge } = await import('../../src/modules/knowledge.ts');
  const { default: lead } = await import('../../src/modules/lead.ts');
  const { default: notify } = await import('../../src/modules/notify.ts');
  const { default: run } = await import('../../src/modules/run.ts');
  const { default: secrets } = await import('../../src/modules/secrets.ts');
  const { default: setup } = await import('../../src/modules/setup.ts');
  const { default: sessions } = await import('../../src/modules/sessions.ts');
  const { default: tickets } = await import('../../src/modules/tickets.ts');
  const { default: users, proofPath, readOrCreateProof } = await import('../../src/modules/users.ts');
  const { assemble, dispatch } = await import('../../src/modules/registry.ts');
  const { handle } = await import('../../src/server.ts');
  const { applyTables, ledgerPath, openStore } = await import('../../src/store/db.ts');
  const { SETUP_CODE_LINE } = await import('../../src/setup/code.ts');
  const { makeOwner } = await import('../../app/src/setup.ts');
  const { LoginThrottle } = await import('../../app/src/users.ts');

  const store = openStore(ledgerPath());
  const modules = { sessions, users, tickets, flow, approval, inbox, lead, notify, knowledge, setup, run, secrets };
  applyTables(store.db, Object.values(modules).flatMap((module) => module.tables));
  const app = assemble(modules, { store });
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { printed.push(String(line)); };
  try { app.start?.(); } finally { console.log = log; }
  const proof = readOrCreateProof(proofPath(ledgerPath()));
  let user = '';
  const call = async (path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [SERVICE_PROOF_HEADER]: proof, [SERVICE_USER_HEADER]: user, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json, text };
  };

  try {
    // Before the assistant: no flow, and what needs the workspace is off.
    assert.equal((await call('/api/workspace')).status, 503);
    assert.equal(knowledge.knowledge(), undefined);
    assert.equal(notify.dispatcher(), undefined);
    assert.equal(approval.trains(), undefined);

    // The owner, from the setup code the start printed, as the app makes it.
    const code = printed.map((line) => SETUP_CODE_LINE.exec(line)?.[1]).find(Boolean);
    assert.ok(code, `the start printed a setup code: ${printed.join(' | ')}`);
    const made = await makeOwner({ db: store.db, params: { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 } }, { code, name: 'alex', password: PASSWORD }, new LoginThrottle(), '127.0.0.1');
    assert.equal(made.status, 201);
    user = (made as { user: string }).user;

    // The workspace step: the list, the proposal, the file from the ticks.
    const listed = await call('/api/setup/workspace');
    assert.equal(listed.status, 200, listed.text);
    const both = ['example-org/guestbook', 'example-org/filter-api'];
    assert.equal((await call('/api/setup/workspace/propose', { repositories: both })).status, 200);
    const confirmed = await call('/api/setup/workspace', { repositories: both, services: ['guestbook', 'filter-api'], links: [], contracts: [] });
    assert.equal(confirmed.status, 200, confirmed.text);

    // The same process now runs the workspace.
    const workspace = await call('/api/workspace');
    assert.equal(workspace.status, 200, workspace.text);
    const project = workspace.json.id as string;
    assert.equal(project, 'guestbook');
    assert.deepEqual(store.db.prepare('SELECT id FROM workspaces').all().map((row) => row.id), [project], 'the workspace\'s rows are written');
    assert.deepEqual(workspace.json.services.map((s: { name: string }) => s.name), ['guestbook', 'filter-api']);
    assert.ok(knowledge.knowledge(), 'the knowledge runs');
    assert.ok(approval.trains(), 'a workspace of two services approves its tickets as trains');
    assert.ok(notify.dispatcher(), 'the notifications are sent');
    await until(() => (asked.length > 0 ? true : undefined), 'the mirror\'s first pass');
    assert.equal((await call('/api/lead')).status, 200, 'the lead runs');

    // The first ticket, from the assistant's step.
    const first = await call('/api/setup/first-ticket', { service: 'guestbook', language: 'en' });
    assert.equal(first.status, 200, first.text);
    const firstId = first.json.ticket.id as string;
    // A ticket typed in the Tower: the project is the workspace's id, as GET /api/workspace names it.
    const typed = await call('/api/tickets', { title: 'Say hello in the footer', project, services: ['guestbook'] });
    assert.equal(typed.status, 201, typed.text);

    const listedTickets = (await call('/api/tickets')).json as { id: string; project: string }[];
    assert.deepEqual(listedTickets.filter((t) => t.id === firstId || t.id === typed.json.id).map((t) => t.project), [project, project]);
    // The first ticket's author proposes its plan, which waits for the owner's Go.
    await until(async () => ((await call('/api/setup/first-ticket?language=en')).json?.ticket?.stage === 'plan' ? true : undefined), 'the session plan in the inbox');
    assert.equal(existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : '', '', 'no docker call');
  } finally {
    await app.stop?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tracker.closeAllConnections();
    await new Promise<void>((resolve) => tracker.close(() => resolve()));
    store.close();
  }
});
