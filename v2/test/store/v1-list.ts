// Lists the tickets of a ledger.db the way v1 does, with
// lib/tracker/adapters/local.mjs, so a test proves the migrated file is still
// the one tracker.sh and merge-pr.sh read.
//   node v1-list.ts <ledger.db>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

type Tracker = { listTickets(): unknown; close(): void };

const ledger = process.argv[2] as string;
const home = new URL('../../../', pathToFileURL(import.meta.filename)).pathname;
const { openLedger } = await import(pathToFileURL(join(home, 'lib/ledger.mjs')).href) as { openLedger(path: string): unknown };
const { LocalTracker } = await import(pathToFileURL(join(home, 'lib/tracker/adapters/local.mjs')).href) as { LocalTracker: new (options: Record<string, unknown>) => Tracker };
const tracker = new LocalTracker({ db: openLedger(ledger), actor: { kind: 'agents', id: 'cleared-v2' }, approvalDir: join(ledger, '..', 'validations') });
process.stdout.write(`${JSON.stringify(tracker.listTickets())}\n`);
tracker.close();
