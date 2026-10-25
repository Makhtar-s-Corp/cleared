// The sessions module (lane 7, flow): the harness adapters of
// session/adapters/index.ts as the sessionAdapters slot, and the session
// routes of the service's API (api/types.ts): list, detail, the event
// stream, messages, answers and interrupt; a session's preview, its trial
// environment (milestone 2, decision 20: container/preview.ts); and the
// questions to the code, each answered by a reader session, with the asks
// table (decision 28: reader/).
import { Docker } from '../container/docker.ts';
import { previewRoutes } from '../container/preview.ts';
import { FlowConfigError } from '../flow/config.ts';
import { runtime } from '../flow/runtime.ts';
import { readerRoutes } from '../reader/routes.ts';
import { ReaderConfigError, createReaderRuntime } from '../reader/runtime.ts';
import { ASK_TABLES } from '../reader/store.ts';
import type { Module } from './registry.ts';

export const readerRuntime = createReaderRuntime({ flow: runtime });

const sessions: Module = {
  tables: [...ASK_TABLES],
  routes: [
    ...runtime.routes((path) => path.startsWith('/api/sessions')),
    ...previewRoutes({ proof: () => runtime.proof(), target: (session) => runtime.previewTarget(session), docker: () => new Docker() }),
    ...readerRoutes({ reader: (registry) => readerRuntime.reader(registry), proof: () => runtime.proof() }),
  ],
  provide: ({ store }) => {
    try {
      runtime.attach({ store });
      readerRuntime.attach({ store });
    } catch (error) {
      // A project that is named but badly set up stops the service, as a bad port does.
      if (!(error instanceof FlowConfigError) && !(error instanceof ReaderConfigError)) throw error;
      console.error(`cleared-v2: ${error.message}`);
      process.exit(64);
    }
    return { sessionAdapters: runtime.adapters() };
  },
};

export default sessions;
