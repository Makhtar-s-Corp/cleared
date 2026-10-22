// Starts the guestbook: creates its table if missing, then listens.
//   DATABASE_URL=postgres://... node src/main.ts
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config.ts';
import { createFilter } from './filter.ts';
import { createApp } from './server.ts';
import { createStore } from './store.ts';

const config = readConfig();
const store = createStore(config.databaseUrl);

// A database started at the same time as the app takes a few seconds to
// accept connections: try for 30 seconds before giving up.
for (let attempt = 1; ; attempt++) {
  try {
    await store.init();
    break;
  } catch (error) {
    if (attempt === 30) throw error;
    await sleep(1000);
  }
}

const filter = config.filterUrl ? createFilter(config.filterUrl) : undefined;
const server = createApp(store, { ...(filter ? { filter } : {}), breakHealth: config.breakHealth });
server.listen(config.port, config.host, () => {
  console.log(`guestbook listening on ${config.host}:${config.port}${filter ? ', entries checked by the filter API' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      store.close().finally(() => process.exit(0));
    });
  });
}
