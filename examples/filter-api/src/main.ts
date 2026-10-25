// Starts the filter API: reads words.txt, then listens.
//   node src/main.ts
import { readConfig } from './config.ts';
import { createApp } from './server.ts';
import { loadWords } from './words.ts';

const config = readConfig();
const words = await loadWords();

const server = createApp(words);
server.listen(config.port, config.host, () => {
  console.log(`filter API listening on ${config.host}:${config.port}, ${words.size} words`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
