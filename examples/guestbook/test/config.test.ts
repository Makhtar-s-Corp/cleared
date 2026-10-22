import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_HOST, DEFAULT_PORT, PROOF_BREAK_HEALTH, readConfig } from '../src/config.ts';

const url = 'postgres://postgres@127.0.0.1:5432/postgres';

test('defaults: this machine only, port 8793', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: url }), { host: DEFAULT_HOST, port: DEFAULT_PORT, databaseUrl: url, breakHealth: false });
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8793);
});

test('HOST and PORT override the defaults', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: url, HOST: '0.0.0.0', PORT: '9100' }), { host: '0.0.0.0', port: 9100, databaseUrl: url, breakHealth: false });
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

test('FILTER_URL names the filter API: http or https, with no credentials, its trailing slash dropped', () => {
  assert.equal(readConfig({ DATABASE_URL: url, FILTER_URL: 'http://filter-api:8795' }).filterUrl, 'http://filter-api:8795');
  assert.equal(readConfig({ DATABASE_URL: url, FILTER_URL: ' https://filter.example.invalid/api/ ' }).filterUrl, 'https://filter.example.invalid/api');
  assert.equal(readConfig({ DATABASE_URL: url }).filterUrl, undefined, 'unset: no filter');
  assert.equal(readConfig({ DATABASE_URL: url, FILTER_URL: '  ' }).filterUrl, undefined, 'blank: no filter');
  for (const bad of ['filter-api:8795', 'ftp://filter-api', 'http://user:pw@filter-api', 'http://filter-api/?q=1', 'not a url']) {
    assert.throws(() => readConfig({ DATABASE_URL: url, FILTER_URL: bad }), ConfigError, bad);
  }
});

test('PROOF_BREAK_HEALTH is off as committed, and PROOF_BREAK_HEALTH=1 turns it on', () => {
  assert.equal(PROOF_BREAK_HEALTH, false, 'only the proof\'s second ticket turns it on, in a change of its own');
  assert.equal(readConfig({ DATABASE_URL: url, PROOF_BREAK_HEALTH: '1' }).breakHealth, true);
  assert.equal(readConfig({ DATABASE_URL: url, PROOF_BREAK_HEALTH: '0' }).breakHealth, false);
});
