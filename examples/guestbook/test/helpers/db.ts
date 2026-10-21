// The tests that need Postgres run against DATABASE_URL, each in a schema of
// its own that is dropped at the end, so test files can run in parallel on
// one database. Without DATABASE_URL they fail: a skipped database test
// would let `npm test` pass without proving anything.
import { randomBytes } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { createStore, type Store } from '../../src/store.ts';

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is not set: the tests need a Postgres database (README, "Tests")');
  return url;
}

export type TestDatabase = {
  readonly store: Store;
  readonly schema: string;
  drop(): Promise<void>;
};

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function testDatabase(): Promise<TestDatabase> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  await admin((client) => client.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`));
  const store = createStore(databaseUrl(), { schema });
  await store.init();
  return {
    store,
    schema,
    async drop() {
      await store.close();
      await admin((client) => client.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`));
    },
  };
}
