import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_HOST, DEFAULT_PORT, RESERVED_PORTS, readConfig } from '../src/config.ts';

test('without settings the service listens on this machine only, on 8791', () => {
  assert.deepEqual(readConfig({}), { host: '127.0.0.1', port: 8791 });
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8791);
});

test('the default port is none of the reserved ports', () => {
  assert.ok(!RESERVED_PORTS.has(DEFAULT_PORT));
  for (const port of [80, 443, 8787, 8788, 8790]) assert.ok(RESERVED_PORTS.has(port), String(port));
});

test('host and port come from CLEARED_V2_HOST and CLEARED_V2_PORT', () => {
  assert.deepEqual(readConfig({ CLEARED_V2_HOST: '::1', CLEARED_V2_PORT: '9100' }), { host: '::1', port: 9100 });
  assert.deepEqual(readConfig({ CLEARED_V2_HOST: ' ', CLEARED_V2_PORT: '' }), { host: '127.0.0.1', port: 8791 }, 'blank values mean the defaults');
});

test('a reserved, out of range or malformed port is refused', () => {
  for (const value of ['80', '443', '8787', '8788', '8790']) {
    assert.throws(() => readConfig({ CLEARED_V2_PORT: value }), (error: unknown) => error instanceof ConfigError && /is reserved/.test(error.message), value);
  }
  for (const value of ['0', '65536', '-1', '8791.5', '1e3', 'abc', '0x1f90']) {
    assert.throws(() => readConfig({ CLEARED_V2_PORT: value }), ConfigError, value);
  }
});
