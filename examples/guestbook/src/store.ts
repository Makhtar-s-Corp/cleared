// The guestbook's entries in Postgres: one table, created if missing.
import { Pool } from 'pg';

export type Entry = {
  readonly id: number;
  readonly name: string;
  readonly message: string;
  readonly createdAt: Date;
};

export interface Store {
  init(): Promise<void>;
  list(): Promise<Entry[]>;
  add(name: string, message: string): Promise<Entry>;
  // true when the database answers within the timeout; never throws.
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export type StoreOptions = {
  // A schema to work in instead of public (the tests use one each).
  readonly schema?: string;
  // How long a connection or a query may take, in milliseconds.
  readonly timeoutMs?: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

type Row = { id: string; name: string; message: string; created_at: Date };

const toEntry = (row: Row): Entry => ({ id: Number(row.id), name: row.name, message: row.message, createdAt: row.created_at });

export function createStore(connectionString: string, options: StoreOptions = {}): Store {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (options.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.schema)) throw new Error(`not a plain schema name: ${options.schema}`);
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    max: 5,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  // An idle client that loses its connection must not crash the process.
  pool.on('error', () => {});

  return {
    async init() {
      await pool.query(SCHEMA);
    },
    async list() {
      const result = await pool.query<Row>('SELECT id, name, message, created_at FROM entries ORDER BY id ASC');
      return result.rows.map(toEntry);
    },
    async add(name, message) {
      const result = await pool.query<Row>(
        'INSERT INTO entries (name, message) VALUES ($1, $2) RETURNING id, name, message, created_at',
        [name, message],
      );
      const row = result.rows[0];
      if (!row) throw new Error('the insert returned no row');
      return toEntry(row);
    },
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
