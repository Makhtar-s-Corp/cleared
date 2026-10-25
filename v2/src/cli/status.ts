// cleared-v2 status: what the v2 service is doing, from its ledger and its
// own /health (docs/v2/milestone-4-plan.md, section 7), kept from v1's
// `cleared status` (B2.1, docs/heartbeat.md).
//   node src/cli/status.ts            (npm run status)            one line per part
//   node src/cli/status.ts --json     (npm run status -- --json)  one JSON object, schema 1
// Exit 0 when nothing is wrong (a notice never counts), 1 with a problem, 2
// when the status cannot be collected. It reads the service's environment
// (CLEARED_STATE_DIR or ORCH_LEDGER, CLEARED_V2_HOST and CLEARED_V2_PORT,
// CLEARED_V2_PROJECT or CLEARED_V2_WORKSPACE, the CLEARED_V2_HEARTBEAT_*
// thresholds) and writes nothing: the ledger is opened read-only, and the
// monitor's addresses are not read.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ConfigError, readConfig } from '../config.ts';
import { loadFlowConfig } from '../flow/config.ts';
import { diagnose, failing } from '../heartbeat/beat.ts';
import { HeartbeatConfigError, readHeartbeatSettings } from '../heartbeat/settings.ts';
import { collectSnapshot } from '../heartbeat/snapshot.ts';
import { renderStatus, statusJson, statusLanguage, statusTranslator } from '../heartbeat/status.ts';
import { formatAddress } from '../server.ts';
import { LedgerPathError, ledgerPath } from '../store/db.ts';

const t = statusTranslator(statusLanguage(process.env));
const args = process.argv.slice(2);
const asJson = args.includes('--json');

// The status cannot be collected: a line, or one schema 1 object with --json,
// with the keys of a status collected, empty.
function fail(message: string): never {
  if (asJson) {
    console.log(JSON.stringify({
      schema: 1, project: null, checkedAt: new Date().toISOString(), ok: false,
      service: null, lastBeat: null, monitor: null, sessions: { running: 0, names: [] }, waiting: null, quota: null, trackers: [], releases: [],
      problems: [{ code: 'status_error', id: 'status', level: 'problem', message: t('problem_status_error', { reason: message }) }], notices: [],
    }, null, 2));
  } else console.error(`cleared-v2: ${message}`);
  process.exit(2);
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

if (args.some((arg) => arg !== '--json')) fail(t('usage'));

let settings;
let path: string;
let address: string;
try {
  settings = readHeartbeatSettings(process.env);
  path = ledgerPath(process.env);
  const { host, port } = readConfig(process.env);
  address = formatAddress(host, port);
} catch (error) {
  if (error instanceof HeartbeatConfigError || error instanceof LedgerPathError || error instanceof ConfigError) fail(t('error_settings', { reason: error.message }));
  throw error;
}
if (!existsSync(path)) fail(t('error_ledger_missing', { path }));

let project: string | null = null;
try {
  project = loadFlowConfig(process.env)?.project ?? null;
} catch {
  // A workspace badly set up stops the service, not its status: the status says it has no project.
}

let reachable = false;
try {
  reachable = (await fetch(`http://${address}/health`, { signal: AbortSignal.timeout(5000) })).ok;
} catch {
  reachable = false;
}

let db: DatabaseSync | undefined;
let snapshot;
const now = new Date();
try {
  db = new DatabaseSync(path, { readOnly: true });
  snapshot = collectSnapshot(db, { settings, project, now });
} catch (error) {
  fail(t('error_ledger', { reason: reason(error) }));
} finally {
  db?.close();
}

const service = { address, reachable };
const problems = diagnose({ side: 'status', snapshot, settings, now, health: service });
const input = { project, snapshot, problems, service, now };
if (asJson) console.log(JSON.stringify(statusJson(input, t), null, 2));
else for (const line of renderStatus(input, t)) console.log(line);
process.exitCode = failing(problems).length > 0 ? 1 : 0;
