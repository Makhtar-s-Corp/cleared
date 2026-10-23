// cleared-v2 repair-services: the tickets in Todo that name a service the
// workspace's configuration no longer has, and what repairing them does
// (lead/plans/repair.ts). A dry run: it prints and changes nothing.
//   node src/cli/repair-services.ts            (npm run repair-services)
//   node src/cli/repair-services.ts --apply    (npm run repair-services -- --apply) repairs them
//
// It reads the workspace and the ledger as the service does, from the same
// environment (CLEARED_V2_WORKSPACE or CLEARED_V2_PROJECT and its
// variables, CLEARED_STATE_DIR or ORCH_LEDGER). Stop the service before
// --apply; its next start's tick starts the repaired items again.
import { readLockConf } from '../approval/conf.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { repairTicketServices } from '../lead/plans/repair.ts';
import { LedgerPathError, StoreError, ledgerPath, openStore } from '../store/db.ts';

const USAGE = 'usage: cleared-v2 repair-services [--apply]';

function fail(message: string, code: number): never {
  console.error(`cleared-v2: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) fail(USAGE, 64);
const apply = args[0] === '--apply';

let config;
let path: string;
try {
  config = loadFlowConfig(process.env);
  path = ledgerPath();
} catch (error) {
  if (error instanceof FlowConfigError || error instanceof LedgerPathError) fail(error.message, 64);
  throw error;
}
if (!config) fail('no workspace is configured: set CLEARED_V2_WORKSPACE, or CLEARED_V2_PROJECT and its variables, as the service has them', 64);
const workspace = workspaceOf(config);

let store;
try {
  store = openStore(path);
} catch (error) {
  if (error instanceof StoreError) fail(error.message, 64);
  throw error;
}
try {
  const repairs = repairTicketServices(store.db, {
    workspace: { id: workspace.id, services: workspace.services.map((service) => service.name) },
    todo: readLockConf(process.env).states.todo, apply, at: new Date().toISOString(),
  });
  console.log(`cleared-v2: workspace ${workspace.id}, services ${workspace.services.map((service) => service.name).join(', ')}${apply ? '' : ' (dry run: nothing is changed; --apply repairs)'}`);
  if (repairs.length === 0) console.log('cleared-v2: no ticket in Todo names a service the workspace does not have');
  for (const repair of repairs) {
    const what = repair.to
      ? `${apply ? 'now names' : 'would name'} ${repair.to.join(', ')}${repair.item ? `; item ${repair.item.position} of ${repair.item.plan} ${repair.item.from} -> ${repair.item.to}` : ''}`
      : `left alone: ${repair.reason}`;
    console.log(`${repair.ticket}: names ${repair.from.join(', ')}; ${what}`);
  }
} finally {
  store.close();
}
