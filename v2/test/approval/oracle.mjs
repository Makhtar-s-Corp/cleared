// Reads a ledger.db the way v1 does, with lib/tracker/adapters/local.mjs, so
// the tests compare the v2 store with the code the lock really runs.
//   node oracle.mjs <ledger.db> <conf file> history|comments|ticket <LOCAL-n>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [ledger, confFile, command, ticket] = process.argv.slice(2);
const home = new URL('../../../', pathToFileURL(import.meta.filename)).pathname;
const { parseConf } = await import(pathToFileURL(join(home, 'lib/conf.mjs')).href);
const { openLedger } = await import(pathToFileURL(join(home, 'lib/ledger.mjs')).href);
const { LocalTracker } = await import(pathToFileURL(join(home, 'lib/tracker/adapters/local.mjs')).href);
const conf = parseConf(readFileSync(confFile, 'utf8'));
const tracker = new LocalTracker({ conf, db: openLedger(ledger), approvalDir: join(ledger, '..', 'validations') });
const out = command === 'history' ? tracker.history(ticket) : command === 'comments' ? tracker.comments(ticket) : tracker.getTicket(ticket);
process.stdout.write(`${JSON.stringify(out)}\n`);
tracker.close();
