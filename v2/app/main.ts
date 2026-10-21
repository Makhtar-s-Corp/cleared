// Starts the v2 app: node app/main.ts (or npm run app).
// It opens ledger.db as the service finds it (users, sign-in sessions),
// reads or makes the proof it shows the service, and serves the app on
// 127.0.0.1:8792 with the live service, or the fixtures
// (CLEARED_V2_APP_SOURCE=fixtures). Settings: src/config.ts.
import { createServer } from 'node:http';
import users, { ProofError, SqliteUsers, proofPath, readOrCreateProof } from '../src/modules/users.ts';
import { formatAddress } from '../src/server.ts';
import { LedgerPathError, StoreError, applyTables, ledgerPath, openStore } from '../src/store/db.ts';
import { fixtureSource } from './fixtures/source.ts';
import { AppConfigError, readAppConfig } from './src/config.ts';
import { serviceSource } from './src/proxy.ts';
import { createAppHandler } from './src/server.ts';
import { CookieSessions, SESSION_TABLES } from './src/session-cookie.ts';
import { LoginThrottle } from './src/users.ts';

function orExit<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (!(error instanceof AppConfigError || error instanceof LedgerPathError || error instanceof StoreError || error instanceof ProofError)) throw error;
    console.error(`cleared-v2-app: ${error.message}`);
    process.exit(64);
  }
}

const config = orExit(() => readAppConfig());
const ledger = orExit(() => ledgerPath());
const store = orExit(() => openStore(ledger));
applyTables(store.db, [...users.tables, ...SESSION_TABLES]);
const proof = orExit(() => readOrCreateProof(proofPath(ledger)));
const source = config.source === 'fixtures'
  ? await fixtureSource(config.project ? { project: config.project } : {})
  : serviceSource({ url: config.serviceUrl, proof });
const project = config.project || (config.source === 'fixtures' ? 'Guestbook' : '');

const handler = createAppHandler({
  users: new SqliteUsers(store.db), sessions: new CookieSessions(store.db), throttle: new LoginThrottle(), source,
  language: config.language, project, publicOrigin: config.publicOrigin,
});

const address = formatAddress(config.host, config.port);
const server = createServer(handler);
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`cleared-v2-app: ${address} is already in use: set CLEARED_V2_APP_PORT to a free port`);
  else console.error(`cleared-v2-app: ${error.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`cleared-v2-app: listening on http://${address} (${config.source}${config.source === 'service' ? ` at ${config.serviceUrl}` : ''})`);
});

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
