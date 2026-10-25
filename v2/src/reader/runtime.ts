// The reader of the sessions module (docs/v2/milestone-2-plan.md, decision
// 28): built on the first request to an ask route, after the flow's engine,
// as the lead is, from the flow's configuration (the workspace, the
// workdirs, the idle rule) and the registry's adapter. At the service's
// start, the asks the last process left live are stopped and cleaned up.
//
// CLEARED_V2_READER_MODEL names the reader's model (claude-sonnet-5-5 by
// default, the reviewer's: a reader reads as a reviewer does).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadFlowConfig, workspaceOf, type FlowConfig } from '../flow/config.ts';
import type { Runtime } from '../flow/runtime.ts';
import type { Registry } from '../modules/registry.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import type { Store } from '../store/db.ts';
import { ReaderService, recoverAsks, type ReaderEffects } from './service.ts';
import { realReaderEffects } from './workdir.ts';

export const DEFAULT_READER_MODEL = 'claude-sonnet-5-5';

export class ReaderConfigError extends Error {
  override name = 'ReaderConfigError';
}

export function readerModel(env: NodeJS.ProcessEnv): string {
  const model = env.CLEARED_V2_READER_MODEL || DEFAULT_READER_MODEL;
  if (!/^claude-[a-z0-9][a-z0-9.-]{0,62}$/.test(model)) throw new ReaderConfigError(`CLEARED_V2_READER_MODEL is a Claude model id such as ${DEFAULT_READER_MODEL}`);
  return model;
}

export type ReaderRuntime = {
  attach(deps: { readonly store: Store }): void;
  reader(registry: Registry): ReaderService | undefined;
};

export function createReaderRuntime(options: { readonly flow: Pick<Runtime, 'engine'>; readonly env?: NodeJS.ProcessEnv; readonly effects?: (config: FlowConfig) => ReaderEffects }): ReaderRuntime {
  const env = options.env ?? process.env;
  let store: Store | undefined;
  let model = DEFAULT_READER_MODEL;
  let reader: ReaderService | undefined;
  const effectsOf = options.effects ?? ((config: FlowConfig) => realReaderEffects({
    root: join(config.workdirRoot, 'asks'),
    services: workspaceOf(config).services.map((service) => ({ name: service.name, base: service.base, dir: service.dir, path: service.path })),
  }));
  return {
    attach(deps) {
      store = deps.store;
      model = readerModel(env);
      // The flow's attach, which runs first, already stopped the service on a configuration it refuses.
      const config = loadFlowConfig(env);
      if (config) recoverAsks({ store, effects: effectsOf(config), project: config.project, at: new Date().toISOString() });
    },
    reader(registry) {
      if (reader || !store) return reader;
      const flow = options.flow.engine(registry);
      const adapter = registry.sessionAdapters['claude-code'];
      if (!flow || !adapter) return undefined;
      const config = flow.config;
      const servicePaths = [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), config.projectDir, config.workdirRoot].filter((p): p is string => !!p && p !== '/'))];
      reader = new ReaderService({
        store, adapter, effects: effectsOf(config), model, idleMs: config.idleMs,
        workspace: { id: config.project, services: workspaceOf(config).services.map((service) => ({ name: service.name, base: service.base, repo: service.repo, path: service.path })) },
        clean: (text) => cleanText(text, { secrets: secretValues(env), servicePaths }),
      });
      reader.startTimer();
      return reader;
    },
  };
}
