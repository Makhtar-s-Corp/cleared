// Lists the tickets of a ledger.db the way v1 does, with
// lib/tracker/adapters/local.mjs, so a test proves the migrated file is still
// the one tracker.sh and merge-pr.sh read.
//   node v1-list.mjs <ledger.db>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [ledger] = process.argv.slice(2);
const home = new URL('../../../', pathToFileURL(import.meta.filename)).pathname;
const { openLedger } = await import(pathToFileURL(join(home, 'lib/ledger.mjs')).href);
const { LocalTracker } = await import(pathToFileURL(join(home, 'lib/tracker/adapters/local.mjs')).href);
const tracker = new LocalTracker({ db: openLedger(ledger), actor: { kind: 'agents', id: 'cleared-v2' }, approvalDir: join(ledger, '..', 'validations') });
process.stdout.write(`${JSON.stringify(tracker.listTickets())}\n`);
tracker.close();
