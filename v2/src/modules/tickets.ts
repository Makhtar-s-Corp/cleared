// The tickets module (lane 8, approval and lock): the TicketStore on the local
// tracker's tables in ledger.db, so ids, states and signatures are the ones
// tracker.sh and merge-pr.sh read. The ticket routes of the API are lane 7's.
// Milestone 2 (lane 14, decision 18): the workspace and its services, as
// tables of this module beside the tracker's, their rows written at the
// start from the configuration, and GET /api/workspace.
import type { DatabaseSync } from 'node:sqlite';
import { approvalEnvironment } from '../approval/service.ts';
import { FlowConfigError, loadFlowConfig } from '../flow/config.ts';
import { runtime } from '../flow/runtime.ts';
import { TICKET_TABLES, WORKSPACE_TABLES, recordWorkspace } from '../tickets/local-store.ts';
import type { Module } from './registry.ts';

// Writes the configured workspace's rows; nothing when the service is not
// set up to run tickets. The one-service workspace of the milestone 1
// variables is written on the first start after the migration, with the old
// project value as its id.
export function recordWorkspaceOf(db: DatabaseSync, env: NodeJS.ProcessEnv, now: () => string = () => new Date().toISOString()): void {
  const workspace = loadFlowConfig(env)?.workspace;
  if (workspace) recordWorkspace(db, workspace, now());
}

const tickets: Module = {
  tables: [...TICKET_TABLES, ...WORKSPACE_TABLES],
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
    return { ticketStore: approvalEnvironment(store.db).ticketStore };
  },
};

export default tickets;
