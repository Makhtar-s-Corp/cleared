// What the handover tests share (test/flow/handover.test.ts, test/scripts/
// proof-handover.test.ts): the flow's fake Claude adapter, a fake Codex
// adapter beside it, and the take over routes over HTTP, with the owner's
// proof. Codex is the fake adapter with harness 'codex': no account, no
// container, no network but a loopback port the system chooses.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionAdapter, SessionId } from '../../src/session/contract.ts';
import { quickAuthor, REPORT_PASS, reopenScript, reviewerScript, setup, type Setup, type SetupOptions, type Started } from './support.ts';

export const PROOF = 'e'.repeat(64);

export type Rig = Setup & {
  readonly base: string; readonly server: Server;
  readonly codex: { readonly started: Started[]; readonly resumed: SessionId[]; readonly authors: (readonly FakeStep[])[]; readonly reviewers: (readonly FakeStep[])[]; failStart: boolean };
  readonly claudeResumed: SessionId[];
  close(): Promise<void>;
};

// The Codex adapter is the fake with harness 'codex': it plays one script
// per session it starts and reopens a session under its own id.
function codexAdapter(t: Setup, codex: Rig['codex']): SessionAdapter {
  const inputs = new Map<SessionId, Started['input']>();
  return {
    harness: 'codex',
    async start(input) {
      if (codex.failStart) throw new Error('codex is not logged in');
      const script = input.role === 'reviewer' ? codex.reviewers.shift() ?? reviewerScript(REPORT_PASS) : codex.authors.shift() ?? quickAuthor;
      const handle = await createFakeAdapter({ harness: 'codex', log: t.store.events, script }).start(input);
      inputs.set(handle.id, input);
      codex.started.push({ input, id: handle.id });
      return handle;
    },
    async resume(id) {
      codex.resumed.push(id);
      const input = inputs.get(id);
      if (!input) throw new Error(`cannot resume ${id}`);
      return createFakeAdapter({ harness: 'codex', log: t.store.events, script: reopenScript, newId: () => id }).start(input);
    },
  };
}

export async function rig(options: SetupOptions & { codex?: boolean } = {}): Promise<Rig> {
  const t = await setup(options);
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  const codex: Rig['codex'] = { started: [], resumed: [], authors: [], reviewers: [], failStart: false };
  const adapters = t.registry.sessionAdapters as Record<string, SessionAdapter>;
  if (options.codex !== false) adapters.codex = codexAdapter(t, codex);
  const claudeResumed: SessionId[] = [];
  const claude = adapters['claude-code'] as SessionAdapter;
  const resume = claude.resume.bind(claude);
  claude.resume = async (id) => { claudeResumed.push(id); return resume(id); };
  const app: App = { registry: t.engine.registry, tables: [], routes: takeoverRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...t, base, server, codex, claudeResumed,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.engine.close();
    },
  };
}

export const as = (user: string) => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user, 'content-type': 'application/json' });

export async function post(r: Rig, path: string, user = 'u1', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${r.base}${path}`, { method: 'POST', headers: as(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

