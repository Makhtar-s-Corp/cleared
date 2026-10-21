import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_HOST, DEFAULT_PORT, readConfig } from '../src/config.ts';

const url = 'postgres://postgres@127.0.0.1:5432/postgres';

test('defaults: this machine only, port 8793', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: url }), { host: DEFAULT_HOST, port: DEFAULT_PORT, databaseUrl: url });
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8793);
});

test('HOST and PORT override the defaults', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: url, HOST: '0.0.0.0', PORT: '9100' }), { host: '0.0.0.0', port: 9100, databaseUrl: url });
});

test('DATABASE_URL is required', () => {
  assert.throws(() => readConfig({}), ConfigError);
  assert.throws(() => readConfig({ DATABASE_URL: '  ' }), ConfigError);
});

test('a port that is not a whole number in range, or is reserved, is refused', () => {
  for (const port of ['abc', '0', '65536', '80.5', '-1', '80', '443', '8787', '8788', '8790']) {
    assert.throws(() => readConfig({ DATABASE_URL: url, PORT: port }), ConfigError, port);
  }
});
