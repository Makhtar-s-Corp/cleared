// What the three flow modules share (sessions, flow, inbox): one engine per
// process, built on the first request that needs it from the store the
// modules received, the registry the request carries and the environment.
// Without CLEARED_V2_PROJECT the service is not set up to run tickets: the
// API answers 503 and /health still answers.
import { homedir } from 'node:os';
import { createApiRoutes } from '../api/routes.ts';
import type { Registry, Route } from '../modules/registry.ts';
import { proofPath, readOrCreateProof } from '../modules/users.ts';
import { adapterFactories, type AdapterFactory } from '../session/adapters/index.ts';
import { cleanText, createCleaner, secretValues, type CleanOptions } from '../session/clean.ts';
import type { Harness, SessionAdapter, StartInput } from '../session/contract.ts';
import { ledgerPath, type Store } from '../store/db.ts';
import { InboxStore } from '../inbox/store.ts';
import { loadFlowConfig, type FlowConfig } from './config.ts';
import { realEffects } from './effects.ts';
import { FlowEngine, type FlowEffects } from './engine.ts';

export type Runtime = {
  // Called by the sessions module with the store; reads and checks the configuration.
  attach(deps: { readonly store: Store }): void;
  adapters(): Partial<Record<'claude-code' | 'codex', SessionAdapter>>;
  engine(registry: Registry): FlowEngine | undefined;
  proof(): string;
  routes(match: (path: string) => boolean): Route[];
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
      return Object.fromEntries(Object.entries(options.factories ?? adapterFactories).map(([harness, make]) => [harness, make({ log, cleaner: () => createCleaner(cleanOptions()), policy })]));
    },
    engine: engineOf,
    proof: proofOf,
    routes: (match) => api.filter((route) => match(route.path)),
  };
}

export const runtime: Runtime = createRuntime();
