// What the three flow modules share (sessions, flow, inbox): one engine per
// process, built on the first request that needs it from the store the
// modules received, the registry the request carries and the environment.
// Without CLEARED_V2_PROJECT the service is not set up to run tickets: the
// API answers 503 and /health still answers.
//
// The adapters it makes start each author or reviewer session in its
// workspace (milestone 2 plan, decisions 20 and 27): on its service (the
// first of the workspace until the flow names one), with the other
// services, and its own when it runs, as siblings exported from their base
// branches, and the project's skills; the session's row then gets its
// service and, when its own service runs, the unguessable key of its preview.
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contractPort, readContract } from '../../images/fake/fake.ts';
import type { PreviewTarget } from '../container/preview.ts';
import { planSiblings } from '../container/services.ts';
import { exportBase } from '../workspace/checkout.ts';
import { createApiRoutes } from '../api/routes.ts';
import type { Registry, Route } from '../modules/registry.ts';
import { proofPath, readOrCreateProof } from '../modules/users.ts';
import { adapterFactories, type AdapterFactory } from '../session/adapters/index.ts';
import { cleanText, createCleaner, secretValues, type CleanOptions } from '../session/clean.ts';
import type { Harness, SessionAdapter, StartInput } from '../session/contract.ts';
import { ledgerPath, type Store } from '../store/db.ts';
import { InboxStore } from '../inbox/store.ts';
import { loadFlowConfig, workspaceOf, type FlowConfig } from './config.ts';
import { realEffects } from './effects.ts';
import { FlowEngine, type FlowEffects } from './engine.ts';

export type Runtime = {
  // Called by the sessions module with the store; reads and checks the configuration.
  attach(deps: { readonly store: Store }): void;
  adapters(): Partial<Record<'claude-code' | 'codex', SessionAdapter>>;
  engine(registry: Registry): FlowEngine | undefined;
  proof(): string;
  routes(match: (path: string) => boolean): Route[];
  // The preview of a session: its key and its own run sibling, or
  // undefined when it has none (container/preview.ts).
  previewTarget(session: string): PreviewTarget | undefined;
};

export type RuntimeOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly effects?: (config: FlowConfig) => FlowEffects;
  readonly factories?: Readonly<Partial<Record<Harness, AdapterFactory>>>;
};

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  let store: Store | undefined;
  let config: FlowConfig | undefined;
  let engine: FlowEngine | undefined;
  let proof: string | undefined;

  const cleanOptions = (): CleanOptions => ({
    secrets: secretValues(env),
    servicePaths: [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), config?.projectDir, config?.workdirRoot].filter((p): p is string => !!p && p !== '/'))],
  });

  function engineOf(registry: Registry): FlowEngine | undefined {
    if (engine || !config || !store) return engine;
    engine = new FlowEngine({
      store, inbox: new InboxStore(store.db), registry, config,
      effects: (options.effects ?? ((c) => realEffects(c, { env })))(config),
      clean: (text) => cleanText(text, cleanOptions()),
    });
    engine.startTimer();
    // What the last process left running is stopped and put back (decision 12 of milestone 2).
    const recovering = engine;
    void recovering.recover().catch((error) => console.error(`cleared-v2: the restart recovery failed (${error instanceof Error ? error.name : typeof error})`));
    return engine;
  }

  const proofOf = (): string => (proof ??= readOrCreateProof(proofPath(ledgerPath(env))));

  const stateDir = (): string => env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');

  // What the flow did not say: the session's service, its siblings, the
  // project's skills. A base that cannot be read leaves its sibling, or the
  // skills, out; its error is logged by name only.
  async function inWorkspace(input: StartInput, flow: FlowConfig): Promise<StartInput> {
    const workspace = workspaceOf(flow);
    const service = input.service ?? workspace.services[0]?.name ?? '';
    const own = workspace.services.find((candidate) => candidate.name === service);
    if (!own) throw new Error(`${service} is not a service of the workspace ${workspace.id}`);
    const exported = async (name: string, root: string, only?: string) => {
      const source = workspace.services.find((candidate) => candidate.name === name);
      if (!source) return undefined;
      try {
        return await exportBase({ project: source.dir, base: source.base, root, ...(only === undefined ? {} : { only }) });
      } catch (error) {
        console.error(`cleared-v2: the base of ${name} cannot be read (${error instanceof Error ? error.name : typeof error})`);
        return undefined;
      }
    };
    const siblings = input.siblings ?? await planSiblings({
      services: workspace.services, own: service, ownCheckout: input.workdir,
      // A ticket checkout of another service is a plain folder the flow made.
      checkoutOf: (name) => {
        const dir = join(flow.workdirRoot, input.ticket, name);
        return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined;
      },
      baseOf: (name) => exported(name, join(stateDir(), 'siblings', name)),
      contractPort: (file) => {
        try { return contractPort(readContract(readFileSync(file, 'utf8'), file)); } catch { return undefined; }
      },
    });
    const skills = input.skills ?? (await exported(service, join(stateDir(), 'skills', service), '.claude/skills'))?.dir;
    return { ...input, service, siblings, ...(skills === undefined ? {} : { skills }) };
  }

  function withWorkspace(adapter: SessionAdapter): SessionAdapter {
    return {
      harness: adapter.harness,
      resume: (id) => adapter.resume(id),
      async start(input) {
        if (input.role === 'lead' || !config || !store) return adapter.start(input);
        const prepared = await inWorkspace(input, config);
        const handle = await adapter.start(prepared);
        const preview = prepared.siblings?.some((sibling) => sibling.name === prepared.service && sibling.real) ?? false;
        const at = new Date().toISOString();
        // Before the engine's own put, which keeps both (store/db.ts).
        store.sessions.put({
          id: handle.id, project: input.project, ticket: input.ticket, role: input.role, harness: input.harness, model: input.model,
          status: input.role === 'reviewer' ? 'reviewing' : 'working', createdAt: at, updatedAt: at,
          service: prepared.service ?? null, previewKey: preview ? randomBytes(32).toString('base64url') : null,
        });
        return handle;
      },
    };
  }
  const api = createApiRoutes({ engine: engineOf, proof: proofOf });

  return {
    attach(deps) {
      store = deps.store;
      config = loadFlowConfig(env);
    },
    adapters() {
      if (!store) return {};
      const log = store.events;
      // The adapters are made before the engine (the sessions module provides
      // them): the policy of each evaluation asks the engine once it exists.
      const policy = (input: StartInput) => (engine ? engine.policyFor(input) : input.policy);
      return Object.fromEntries(Object.entries(options.factories ?? adapterFactories).map(([harness, make]) => [harness, withWorkspace(make({ log, cleaner: () => createCleaner(cleanOptions()), policy }))]));
    },
    engine: engineOf,
    proof: proofOf,
    routes: (match) => api.filter((route) => match(route.path)),
    previewTarget(session) {
      const row = store?.sessions.get(session);
      if (!row?.previewKey || !row.service || !config) return undefined;
      const run = workspaceOf(config).services.find((service) => service.name === row.service)?.run;
      return run ? { session: row.id, key: row.previewKey, alias: row.service, port: run.port } : undefined;
    },
  };
}

export const runtime: Runtime = createRuntime();
