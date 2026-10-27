// cleared-v2 import-v1: brings a v1 ledger's measured tickets into the plans'
// estimates and its approved decisions into the workspace's memory
// (docs/v2/milestone-4-plan.md, section 3). A dry run: it prints and changes
// nothing; the v1 ledger is never written, --apply or not.
//   node src/cli/import-v1.ts --from <v1 ledger.db>            (npm run import-v1 -- --from ...)
//   node src/cli/import-v1.ts --from <v1 ledger.db> --apply    imports
//
// It reads the workspace and v2's ledger as the service does, from the same
// environment (CLEARED_V2_WORKSPACE or CLEARED_V2_PROJECT and its
// variables, CLEARED_STATE_DIR or ORCH_LEDGER, the settings of
// CLEARED_CONF or the checkout's .cleared/agents.conf).
import { resolve } from 'node:path';
import { readLockConf } from '../approval/conf.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { ImportMemoryError, importV1 } from '../import/apply.ts';
import { importTranslator, languageOf, renderReport } from '../import/report.ts';
import { V1ImportError } from '../import/v1.ts';
import { LedgerPathError, StoreError, ledgerPath } from '../store/db.ts';

const language = languageOf(process.env);
const t = importTranslator(language);

function fail(message: string): never {
  console.error(`cleared-v2: ${message}`);
  process.exit(64);
}

const args = process.argv.slice(2);
const at = args.indexOf('--from');
const from = at >= 0 ? args[at + 1] : undefined;
const apply = args.includes('--apply');
if (!from || from.startsWith('--') || args.length !== (apply ? 3 : 2)) fail(t('usage'));

let config;
let ledger: string;
try {
  config = loadFlowConfig(process.env);
  ledger = ledgerPath();
} catch (error) {
  if (error instanceof FlowConfigError || error instanceof LedgerPathError) fail(t('error_settings', { reason: error.message }));
  throw error;
}
if (!config) fail(t('error_no_workspace'));
const workspace = workspaceOf(config);
const ownerId = readLockConf({ CLEARED_REPO: config.projectDir, ...process.env }).ownerId;

try {
  const report = await importV1({ from: resolve(from), ledger, project: workspace.id, checkout: config.projectDir, ownerId, apply, env: process.env });
  for (const line of renderReport(report, t, language)) console.log(line);
} catch (error) {
  if (error instanceof V1ImportError) {
    const key = { not_found: 'error_not_found', not_v1: 'error_not_v1', same_file: 'error_same_file' }[error.code];
    fail(t(key, { path: error.path }));
  }
  if (error instanceof StoreError) fail(t('error_ledger', { reason: error.message }));
  if (error instanceof ImportMemoryError) fail(t('error_memory', { reason: error.message }));
  throw error;
}
