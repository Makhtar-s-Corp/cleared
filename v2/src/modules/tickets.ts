// The tickets module (lane 8, approval and lock): the TicketStore on the local
// tracker's tables in ledger.db, so ids, states and signatures are the ones
// tracker.ts and merge-pr.ts read. The ticket routes of the API are lane 7's.
// Milestone 2 (lane 14, decision 18): the workspace and its services, as
// tables of this module beside the tracker's, their rows written at the
// start from the configuration, and GET /api/workspace.
// Milestone 4 (issue #381, P230): the mirrors on GitHub Issues and Linear
// (tickets/mirror.ts), started with the service when their settings name a
// token file, and stopped with it; each ticket it writes is said on the
// app's change stream (issue #386, P237). A delegation on a tracker (C3,
// P244) is handed to the lead module's plans, which propose its ticket to
// the owner. A workspace the assistant writes while the service runs (issue
// #420) gets its rows and its mirror once the flow runs on it.
import type { DatabaseSync } from 'node:sqlite';
import { changeHub } from '../api/events.ts';
import { approvalEnvironment } from '../approval/service.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import type { FlowEngine } from '../flow/engine.ts';
import { runtime } from '../flow/runtime.ts';
import { TICKET_TABLES, WORKSPACE_TABLES, recordWorkspace } from '../tickets/local-store.ts';
import type { TicketId } from '../tickets/contract.ts';
import { delegateTo } from '../tickets/delegation.ts';
import { MIRROR_TABLES, MirrorConfigError, createMirror, loadMirrorConfig, type Mirror, type MirrorDelegate } from '../tickets/mirror.ts';
import { leadRuntime, plansOf } from './lead.ts';
import type { Module, Registry } from './registry.ts';

// Writes the configured workspace's rows; nothing when the service is not
// set up to run tickets. The one-service workspace of the milestone 1
// variables is written on the first start after the migration, with the old
// project value as its id.
export function recordWorkspaceOf(db: DatabaseSync, env: NodeJS.ProcessEnv, now: () => string = () => new Date().toISOString()): void {
  const workspace = loadFlowConfig(env)?.workspace;
  if (workspace) recordWorkspace(db, workspace, now());
}

// Whether the settings name a workspace now; a badly set up one stopped the service at provide.
function workspaceNamed(env: NodeJS.ProcessEnv): boolean {
  try { return loadFlowConfig(env) !== undefined; } catch { return false; }
}

// A ticket the mirror wrote, said on the engine's change stream, so that an
// open page refetches it (api/events.ts); nothing without an engine.
export function sayTicketChange(engine: () => FlowEngine | undefined): (ticket: TicketId) => void {
  return (ticket) => {
    const running = engine();
    if (running) changeHub(running).say('ticket', ticket);
  };
}

// The lead's plans, built with the lead on first use: none while the
// service runs no lead, and the mirror then asks again at its next pass.
export function delegationOf(registry: Registry): MirrorDelegate {
  return delegateTo({
    plans: () => plansOf(registry), lead: () => leadRuntime.lead(registry), tickets: registry.ticketStore, flow: () => runtime.engine(registry),
  });
}

let ledger: DatabaseSync | undefined;
let mirror: Mirror | undefined;
let starts = 0;

// The mirror the settings ask for, on the registry's ticket store and the
// flow's engine; none without settings or a project, and a bad setting is
// said in one line (never a token) and leaves the mirror off.
export function startMirror(registry: Registry, db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): Mirror | undefined {
  let config;
  try {
    config = loadMirrorConfig(env);
  } catch (error) {
    if (!(error instanceof MirrorConfigError)) throw error;
    console.error(`cleared-v2: the mirror is off: ${error.message}`);
    return undefined;
  }
  if (!config) return undefined;
  const flow = loadFlowConfig(env);
  if (!flow) {
    console.error('cleared-v2: the mirror is off: it needs the project the service runs (CLEARED_V2_PROJECT)');
    return undefined;
  }
  const made = createMirror(config, {
    db, tickets: registry.ticketStore, project: flow.project,
    services: workspaceOf(flow).services.map((s) => ({ name: s.name, repo: s.repo })),
    flow: () => runtime.engine(registry),
    changed: sayTicketChange(() => runtime.engine(registry)),
    delegate: delegationOf(registry),
  });
  made?.start(config.pollMs);
  return made;
}

const tickets: Module = {
  tables: [...TICKET_TABLES, ...WORKSPACE_TABLES, ...MIRROR_TABLES],
  routes: runtime.routes((path) => path === '/api/workspace'),
  provide: ({ store }) => {
    try {
      recordWorkspaceOf(store.db, process.env);
    } catch (error) {
      // A workspace that is named but badly set up stops the service, as a bad project does.
      if (!(error instanceof FlowConfigError)) throw error;
      console.error(`cleared-v2: ${error.message}`);
      process.exit(64);
    }
    ledger = store.db;
    return { ticketStore: approvalEnvironment(store.db).ticketStore };
  },
  // With no workspace yet, its rows and the mirror wait for the flow's
  // engine, unless the module stopped meanwhile.
  start: (registry) => {
    const started = ++starts;
    const db = ledger;
    if (!db || mirror) return;
    if (workspaceNamed(process.env)) {
      mirror = startMirror(registry, db);
      return;
    }
    runtime.whenEngine(() => {
      if (started !== starts || mirror) return;
      recordWorkspaceOf(db, process.env);
      mirror = startMirror(registry, db);
    });
  },
  // The pass that runs is awaited, so that the store does not close under it.
  stop: async () => {
    starts += 1;
    const ending = mirror;
    mirror = undefined;
    await ending?.close();
  },
};

export default tickets;
