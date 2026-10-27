// The notify module (docs/v2/milestone-2-plan.md, decision 14 and section
// 6): the v2 notification dispatcher and its table, v2_notify_queue. When a
// project is set (CLEARED_V2_PROJECT, as the flow), the dispatcher starts
// with the service, ticks at once and every 30 seconds, and needs no request
// to the API. It declares no route: subscribing is the app's
// (app/src/notifications.ts).
// Milestone 4 (issue #392, P239): the service's heartbeat
// (heartbeat/beat.ts), what tells a push monitor the service is alive.
// It starts with the service, a project set or not, beats at once and
// every CLEARED_V2_HEARTBEAT_SECONDS, and stops with it; its tables,
// v2_heartbeat_state and v2_heartbeat_incidents, are this module's.
import type { DatabaseSync } from 'node:sqlite';
import { loadFlowConfig } from '../flow/config.ts';
import { HEARTBEAT_TABLES, Heartbeat } from '../heartbeat/beat.ts';
import { HeartbeatConfigError, readHeartbeatSettings, readMonitor } from '../heartbeat/settings.ts';
import { InboxStore } from '../inbox/store.ts';
import { childSender, Dispatcher, type Sender } from '../notify/dispatcher.ts';
import { NOTIFY_TABLES } from '../notify/queue.ts';
import type { Module } from './registry.ts';

export type NotifyModuleOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly sender?: (env: NodeJS.ProcessEnv) => Sender;
  readonly intervalMs?: number;
  readonly heartbeatMs?: number;                       // the tests' interval; else the settings'
  readonly log?: (line: string) => void;
};

export type NotifyModule = Module & { dispatcher(): Dispatcher | undefined; heartbeat(): Heartbeat | undefined };

// The project and its checkout, to keep the monitor's address files out of
// it; none when the service runs no tickets or its workspace is badly set
// up (the tickets module stops the service then).
function projectOf(env: NodeJS.ProcessEnv): { project: string | null; checkout: string | undefined } {
  try {
    const flow = loadFlowConfig(env);
    return { project: flow?.project ?? null, checkout: flow?.projectDir };
  } catch {
    return { project: null, checkout: undefined };
  }
}

export function createNotifyModule(options: NotifyModuleOptions): NotifyModule {
  let dispatcher: Dispatcher | undefined;
  let heartbeat: Heartbeat | undefined;
  let ledger: DatabaseSync | undefined;
  const log = options.log ?? ((line: string) => console.error(line));
  return {
    tables: [...NOTIFY_TABLES, ...HEARTBEAT_TABLES],
    routes: [],
    provide: ({ store }) => {
      ledger = store.db;
      if (!options.env.CLEARED_V2_PROJECT || dispatcher) return {};
      dispatcher = new Dispatcher({ db: store.db, inbox: new InboxStore(store.db), sender: (options.sender ?? childSender)(options.env) });
      dispatcher.start(options.intervalMs ?? 30_000);
      return {};
    },
    // A bad setting is said in one line, never an address, and leaves the beat off.
    start: () => {
      if (heartbeat || !ledger) return;
      let settings;
      try {
        settings = readHeartbeatSettings(options.env);
      } catch (error) {
        if (!(error instanceof HeartbeatConfigError)) throw error;
        log(`cleared-v2: the heartbeat is off: ${error.message}`);
        return;
      }
      const { project, checkout } = projectOf(options.env);
      heartbeat = new Heartbeat({ db: ledger, settings, monitor: readMonitor(options.env, { checkout }), project, log });
      heartbeat.start(options.heartbeatMs ?? settings.everyMs);
    },
    // The beat that runs is awaited, so that the store does not close under it.
    stop: async () => {
      const ending = heartbeat;
      heartbeat = undefined;
      await ending?.close();
    },
    dispatcher: () => dispatcher,
    heartbeat: () => heartbeat,
  };
}

const notify: NotifyModule = createNotifyModule({ env: process.env });

export default notify;
