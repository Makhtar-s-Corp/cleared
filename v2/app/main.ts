// Starts the v2 app: node app/main.ts (or npm run app).
// It opens ledger.db as the service finds it (users, sign-in sessions),
// reads or makes the proof it shows the service, and serves the app on
// 127.0.0.1:8792 with the live service, or the fixtures
// (CLEARED_V2_APP_SOURCE=fixtures). Settings: src/config.ts. The pages are
// the front end Vite built into dist/ (npm run build; npm run app builds
// first): without it, the app stops at once and says so. Beside it, the
// Browser tab's preview listener on 127.0.0.1:8794 (src/preview.ts,
// CLEARED_V2_PREVIEW_PORT and CLEARED_V2_PREVIEW_ORIGIN), which serves a
// session's trial environment from an origin of its own.
// The settings file is read first (src/setup/load.ts), and on a ledger with
// no account the app answers the setup assistant alone (src/setup.ts,
// docs/v2/milestone-5-plan.md, decision 5).
import '../src/setup/load.ts';
import { createServer } from 'node:http';
import users, { ProofError, SqliteUsers, proofPath, readOrCreateProof } from '../src/modules/users.ts';
import { formatAddress } from '../src/server.ts';
import { SETUP_TABLES } from '../src/setup/tables.ts';
import { LedgerPathError, StoreError, applyTables, ledgerPath, openStore } from '../src/store/db.ts';
import { fixturePreview } from './fixtures/session.ts';
import { fixtureSource } from './fixtures/source.ts';
import { AppConfigError, readAppConfig } from './src/config.ts';
import { PreviewConfigError, createPreviewHandler, readPreviewConfig, servicePreview } from './src/preview.ts';
import { serviceSource } from './src/proxy.ts';
import { BuildMissing, createAppHandler, readBundle } from './src/server.ts';
import { CookieSessions, SESSION_TABLES } from './src/session-cookie.ts';
import { LoginThrottle } from './src/users.ts';

function orExit<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (!(error instanceof AppConfigError || error instanceof PreviewConfigError || error instanceof LedgerPathError || error instanceof StoreError || error instanceof ProofError || error instanceof BuildMissing)) throw error;
    console.error(`cleared-v2-app: ${error.message}`);
    process.exit(64);
  }
}

const config = orExit(() => readAppConfig());
const preview = orExit(() => readPreviewConfig(process.env, { app: config.port, service: Number(new URL(config.serviceUrl).port) }));
orExit(() => readBundle());
const ledger = orExit(() => ledgerPath());
const store = orExit(() => openStore(ledger));
applyTables(store.db, [...users.tables, ...SESSION_TABLES, ...SETUP_TABLES]);
const proof = orExit(() => readOrCreateProof(proofPath(ledger)));
const source = config.source === 'fixtures'
  ? await fixtureSource(config.project ? { project: config.project } : {})
  : serviceSource({ url: config.serviceUrl, proof });
const project = config.project || (config.source === 'fixtures' ? 'Guestbook' : '');

const handler = createAppHandler({
  users: new SqliteUsers(store.db), sessions: new CookieSessions(store.db), throttle: new LoginThrottle(), source,
  language: config.language, project, publicOrigin: config.publicOrigin, previewOrigin: preview.origin, setup: { db: store.db },
});

const address = formatAddress(config.host, config.port);
const server = createServer(handler);
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`cleared-v2-app: ${address} is already in use: set CLEARED_V2_APP_PORT to a free port`);
  else console.error(`cleared-v2-app: ${error.message}`);
  process.exit(1);
});
// The preview listener: no session, the app's proof to the service and nothing else.
const appOrigins = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.publicOrigin ? [config.publicOrigin] : [])];
const previews = createServer(createPreviewHandler({
  upstream: config.source === 'fixtures' ? fixturePreview() : servicePreview({ url: config.serviceUrl, proof }),
  origin: preview.origin, appOrigins,
}));
previews.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`cleared-v2-app: the preview listener's 127.0.0.1:${preview.port} is already in use: set CLEARED_V2_PREVIEW_PORT to a free port`);
  else console.error(`cleared-v2-app: the preview listener: ${error.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`cleared-v2-app: listening on http://${address} (${config.source}${config.source === 'service' ? ` at ${config.serviceUrl}` : ''})`);
  previews.listen(preview.port, preview.host, () => {
    console.log(`cleared-v2-app: previews on http://${preview.host}:${preview.port}${preview.origin === `http://${preview.host}:${preview.port}` ? '' : ` (shown as ${preview.origin})`}`);
  });
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    previews.close();
    previews.closeAllConnections();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
