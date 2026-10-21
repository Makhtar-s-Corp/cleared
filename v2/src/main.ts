// Starts the v2 service: node src/main.ts (or npm start).
import { ConfigError, readConfig, type Config } from './config.ts';
import { createHealthServer, formatAddress } from './server.ts';

function configOrExit(): Config {
  try {
    return readConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`cleared-v2: ${error.message}`);
    process.exit(64);
  }
}

const { host, port } = configOrExit();
const address = formatAddress(host, port);
const server = createHealthServer();
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`cleared-v2: ${address} is already in use: set CLEARED_V2_PORT to a free port`);
  else console.error(`cleared-v2: ${error.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`cleared-v2: listening on http://${address} (health: /health)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
