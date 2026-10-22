// The notify module (docs/v2/milestone-2-plan.md, decision 14 and section
// 6): the v2 notification dispatcher and its table, v2_notify_queue. When a
// project is set (CLEARED_V2_PROJECT, as the flow), the dispatcher starts
// with the service, ticks at once and every 30 seconds, and needs no request
// to the API. It declares no route: subscribing is the app's
// (app/src/notifications.ts).
import { InboxStore } from '../inbox/store.ts';
import { childSender, Dispatcher, type Sender } from '../notify/dispatcher.ts';
import { NOTIFY_TABLES } from '../notify/queue.ts';
import type { Module } from './registry.ts';

export type NotifyModuleOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly sender?: (env: NodeJS.ProcessEnv) => Sender;
  readonly intervalMs?: number;
};

export type NotifyModule = Module & { dispatcher(): Dispatcher | undefined };

export function createNotifyModule(options: NotifyModuleOptions): NotifyModule {
  let dispatcher: Dispatcher | undefined;
  return {
    tables: NOTIFY_TABLES,
    routes: [],
    provide: ({ store }) => {
      if (!options.env.CLEARED_V2_PROJECT || dispatcher) return {};
      dispatcher = new Dispatcher({ db: store.db, inbox: new InboxStore(store.db), sender: (options.sender ?? childSender)(options.env) });
      dispatcher.start(options.intervalMs ?? 30_000);
      return {};
    },
    dispatcher: () => dispatcher,
  };
}

const notify: NotifyModule = createNotifyModule({ env: process.env });

export default notify;
