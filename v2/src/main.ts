// Starts the v2 service: node src/main.ts (or npm start).
// It opens ledger.db, creates the modules' tables, assembles the nine
// modules (src/modules/) and serves their routes, with /health from
// server.ts. A lane fills its module; it does not edit this file (lead and
// notify were added once, by milestone 2's first lane: decision 14;
// knowledge once, by the replan's lane 24: decision 27).
import { createServer } from 'node:http';
import { ConfigError, readConfig, type Config } from './config.ts';
import approval from './modules/approval.ts';
import flow from './modules/flow.ts';
import inbox from './modules/inbox.ts';
import knowledge from './modules/knowledge.ts';
import lead from './modules/lead.ts';
import notify from './modules/notify.ts';
import { assemble, dispatch, type App } from './modules/registry.ts';
import sessions from './modules/sessions.ts';
import tickets from './modules/tickets.ts';
import users from './modules/users.ts';
import { formatAddress, handle } from './server.ts';
import { LedgerPathError, StoreError, applyTables, ledgerPath, openStore, type Store } from './store/db.ts';

function orExit<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof LedgerPathError || error instanceof StoreError)) throw error;
    console.error(`cleared-v2: ${error.message}`);
    process.exit(64);
  }
}

const { host, port }: Config = orExit(() => readConfig());
const store: Store = orExit(() => openStore(ledgerPath()));
const modules = { sessions, users, tickets, flow, approval, inbox, lead, notify, knowledge };
applyTables(store.db, Object.values(modules).flatMap((module) => module.tables));
const app: App = assemble(modules, { store });

const address = formatAddress(host, port);
const server = createServer((request, response) => dispatch(app, request, response, handle));
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`cleared-v2: ${address} is already in use: set CLEARED_V2_PORT to a free port`);
  else console.error(`cleared-v2: ${error.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`cleared-v2: listening on http://${address} (health: /health)`);
});

// server.close waits for every open connection to end, and the event
// streams (GET /api/sessions/:id/events, lane 7) never end on their own.
// So the service ends them itself: an app reconnects with the last seq it
// has (Last-Event-ID) and misses nothing. A second signal while stopping
// does nothing: the store is closed once.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
