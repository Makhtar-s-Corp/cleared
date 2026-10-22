import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_HOST, DEFAULT_PORT, readConfig } from '../src/config.ts';

test('defaults: this machine only, port 8795', () => {
  assert.deepEqual(readConfig({}), { host: DEFAULT_HOST, port: DEFAULT_PORT });
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8795);
});

test('HOST and PORT override the defaults', () => {
  assert.deepEqual(readConfig({ HOST: '0.0.0.0', PORT: '9100' }), { host: '0.0.0.0', port: 9100 });
});

test('a port that is not a whole number in range, or is reserved, is refused', () => {
  const refused = ['abc', '0', '65536', '80.5', '-1', '80', '443', '8787', '8788', '8790', '8791', '8792', '8793', '8794'];
  for (const port of refused) assert.throws(() => readConfig({ PORT: port }), ConfigError, port);
});
