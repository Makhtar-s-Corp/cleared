// Reads a ledger.db the way v1 does, with lib/tracker/adapters/local.mjs, so
// the tests compare the v2 store with the code the lock really runs.
//   node oracle.ts <ledger.db> <conf file> history|comments|ticket <LOCAL-n>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

type Tracker = { history(ticket: string): unknown; comments(ticket: string): unknown; getTicket(ticket: string): unknown; close(): void };

const [ledger, confFile, command, ticket] = process.argv.slice(2) as [string, string, string, string];
const home = new URL('../../../', pathToFileURL(import.meta.filename)).pathname;
const { parseConf } = await import(pathToFileURL(join(home, 'lib/conf.mjs')).href) as { parseConf(text: string): unknown };
const { openLedger } = await import(pathToFileURL(join(home, 'lib/ledger.mjs')).href) as { openLedger(path: string): unknown };
const { LocalTracker } = await import(pathToFileURL(join(home, 'lib/tracker/adapters/local.mjs')).href) as { LocalTracker: new (options: Record<string, unknown>) => Tracker };
const conf = parseConf(readFileSync(confFile, 'utf8'));
const tracker = new LocalTracker({ conf, db: openLedger(ledger), approvalDir: join(ledger, '..', 'validations') });
const out = command === 'history' ? tracker.history(ticket) : command === 'comments' ? tracker.comments(ticket) : tracker.getTicket(ticket);
process.stdout.write(`${JSON.stringify(out)}\n`);
tracker.close();
