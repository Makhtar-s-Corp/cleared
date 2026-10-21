import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError, parseServices } from '../../src/container/services.ts';

test('postgres:16 becomes a service named postgres with its data on tmpfs and a DATABASE_URL for the session', () => {
  const [postgres, ...rest] = parseServices('postgres:16');
  assert.deepEqual(rest, []);
  assert.deepEqual(postgres, {
    alias: 'postgres',
    image: 'postgres:16',
    env: { POSTGRES_HOST_AUTH_METHOD: 'trust' },
    tmpfs: ['/var/lib/postgresql/data'],
    ready: ['pg_isready', '--quiet', '--host', '127.0.0.1', '--username', 'postgres'],
    sessionEnv: { DATABASE_URL: 'postgres://postgres@postgres:5432/postgres' },
  });
});

test('an alias can be given, and several services are separated by commas', () => {
  const services = parseServices(' db=postgres:16 , postgres:16.4 ');
  assert.deepEqual(services.map((s) => [s.alias, s.image]), [['db', 'postgres:16'], ['postgres', 'postgres:16.4']]);
  assert.equal(services[0]?.sessionEnv.DATABASE_URL, 'postgres://postgres@db:5432/postgres');
  assert.deepEqual(parseServices(''), []);
  assert.deepEqual(parseServices('  '), []);
});

test('an image without a known table of writable paths is refused, so that no unlabelled volume is created', () => {
  assert.throws(() => parseServices('redis:7'), (error: unknown) => error instanceof ServiceError && /postgres/.test(error.message));
  assert.throws(() => parseServices('library/mysql:8'), ServiceError);
  assert.throws(() => parseServices('evil.example/postgres:16'), ServiceError, 'only the official image');
});

test('an image without an explicit tag, a bad alias, a reserved alias or a duplicate is refused', () => {
  for (const value of ['postgres', 'postgres:', 'postgres:latest', 'postgres@sha256:abc', '-x=postgres:16', 'Db=postgres:16', 'egress=postgres:16', 'session=postgres:16', 'postgres:16,postgres:16', 'a b=postgres:16', 'postgres:16 --privileged', 'x=']) {
    assert.throws(() => parseServices(value), ServiceError, value);
  }
});
