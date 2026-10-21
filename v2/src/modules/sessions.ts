// The sessions module (lane 7, flow): the harness adapters of
// session/adapters/index.ts as the sessionAdapters slot, and the session
// routes of the service's API (api/types.ts): list, detail, the event
// stream, messages, answers and interrupt.
import { FlowConfigError } from '../flow/config.ts';
import { runtime } from '../flow/runtime.ts';
import type { Module } from './registry.ts';

const sessions: Module = {
  tables: [],
  routes: runtime.routes((path) => path.startsWith('/api/sessions')),
  provide: ({ store }) => {
    try {
      runtime.attach({ store });
    } catch (error) {
      // A project that is named but badly set up stops the service, as a bad port does.
      if (!(error instanceof FlowConfigError)) throw error;
      console.error(`cleared-v2: ${error.message}`);
      process.exit(64);
    }
    return { sessionAdapters: runtime.adapters() };
  },
};

export default sessions;
