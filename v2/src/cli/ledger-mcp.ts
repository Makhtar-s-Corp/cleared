// cleared-v2 ledger-mcp: the ledger's session history as a read-only MCP
// server over stdio (src/mcp/server.ts), for an agent to search. It finds
// ledger.db as the service does (store/db.ts ledgerPath) and opens it read
// only; a ledger that does not exist is not created. stdout carries only
// the protocol's messages, so every word for the operator goes to stderr.
// Its language is the app's (CLEARED_V2_APP_LANGUAGE, fr or en).
//   claude mcp add cleared-ledger -e CLEARED_STATE_DIR=<state folder> -- node <checkout>/v2/src/cli/ledger-mcp.ts
import { dirname } from 'node:path';
import { LedgerHistory, openLedgerReadOnly } from '../mcp/history.ts';
import { createRedactor } from '../mcp/redact.ts';
import { createLedgerServer, serveStdio } from '../mcp/server.ts';
import { LedgerPathError, StoreError, ledgerPath } from '../store/db.ts';

function fail(message: string, code: number): never {
  console.error(`cleared-v2: ${message}`);
  process.exit(code);
}

let path: string;
try {
  path = ledgerPath(process.env);
} catch (error) {
  if (error instanceof LedgerPathError) fail(error.message, 64);
  throw error;
}

let db;
try {
  db = openLedgerReadOnly(path);
} catch (error) {
  if (error instanceof StoreError) fail(error.message, 66);
  throw error;
}

const language = process.env.CLEARED_V2_APP_LANGUAGE === 'en' ? 'en' : 'fr';
const history = new LedgerHistory(db, createRedactor({ env: process.env, paths: [dirname(path)] }));
await serveStdio(process.stdin, process.stdout, createLedgerServer({ history, language, log: (line) => console.error(line) }));
db.close();
