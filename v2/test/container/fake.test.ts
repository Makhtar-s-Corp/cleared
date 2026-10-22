// The fake service of a sibling (decision 20 of the milestone 2 plan): built
// from a provider's OpenAPI 3 contract, each operation answers its first
// example, or a 501 with the operation's name when it has none, and
// /__fake/calls counts what it answered. The contract is the filter API's
// (examples/filter-api/contract/openapi.yaml, lane 28), copied as a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ContractError, contractPort, createFake, createFakeServer, readContract } from '../../images/fake/fake.ts';

const FILTER_API = readFileSync(new URL('./fixtures/filter-api.openapi.yaml', import.meta.url), 'utf8');

const ITEMS = `openapi: 3.0.3
info:
  title: Items
  version: 1.0.0
paths:
  /items/{id}:
    get:
      operationId: getItem
      responses:
        "200":
          description: The item.
          content:
            application/json:
              examples:
                first:
                  value:
                    id: 1
                    name: first
                second:
                  value:
                    id: 2
    delete:
      responses:
        "204":
          description: Gone, with no example.
`;

test('each operation of the filter API answers its first example', () => {
  const fake = createFake(readContract(FILTER_API, 'openapi.yaml'));
  assert.deepEqual(fake.handle('POST', '/check'), { status: 200, body: { ok: true, words: [] } });
  assert.deepEqual(fake.handle('GET', '/health'), { status: 200, body: { status: 'ok' } });
});

test('the first entry of `examples` is the answer when there is no `example`, and a path template matches its segments', () => {
  const fake = createFake(readContract(ITEMS, 'items.yaml'));
  assert.deepEqual(fake.handle('GET', '/items/42'), { status: 200, body: { id: 1, name: 'first' } });
  assert.deepEqual(fake.handle('GET', '/items/42?full=1'), { status: 200, body: { id: 1, name: 'first' } });
  assert.equal(fake.handle('GET', '/items').status, 404);
  assert.equal(fake.handle('GET', '/items/42/more').status, 404);
});

test('an operation with no example answers 501 with its name', () => {
  const fake = createFake(readContract(ITEMS, 'items.yaml'));
  const answer = fake.handle('DELETE', '/items/7');
  assert.equal(answer.status, 501);
  assert.deepEqual(answer.body, { error: 'DELETE /items/{id} has no example in the contract: the fake cannot answer it' });
  const named = createFake(readContract(ITEMS.replace('    delete:\n', '    delete:\n      operationId: removeItem\n'), 'items.yaml'));
  assert.deepEqual(named.handle('DELETE', '/items/7').body, { error: 'removeItem has no example in the contract: the fake cannot answer it' });
});

test('an unknown path is a 404 and a known path with another method a 405, neither counted as a call', () => {
  const fake = createFake(readContract(FILTER_API, 'openapi.yaml'));
  assert.equal(fake.handle('GET', '/nothing').status, 404);
  assert.equal(fake.handle('GET', '/check').status, 405);
  assert.deepEqual(fake.handle('GET', '/__fake/calls').body, { total: 0, operations: {} });
});

test('/__fake/calls counts every answered call, per operation, the 501s included', () => {
  const fake = createFake(readContract(ITEMS, 'items.yaml'));
  fake.handle('GET', '/items/1');
  fake.handle('GET', '/items/2');
  fake.handle('DELETE', '/items/2');
  fake.handle('GET', '/nothing');
  assert.deepEqual(fake.handle('GET', '/__fake/calls'), { status: 200, body: { total: 3, operations: { getItem: 2, 'DELETE /items/{id}': 1 } } });
});

test('a JSON contract is read too, and anything but OpenAPI 3 is refused with a reason', () => {
  const json = JSON.stringify({ openapi: '3.1.0', paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { content: { 'application/json': { example: { pong: true } } } } } } } } });
  assert.deepEqual(createFake(readContract(json, 'api.json')).handle('GET', '/ping'), { status: 200, body: { pong: true } });
  assert.throws(() => readContract('swagger: "2.0"\npaths: {}\n', 'old.yaml'), ContractError);
  assert.throws(() => readContract('openapi: 3.0.0\n', 'empty.yaml'), /paths/);
  assert.throws(() => readContract('openapi: 3.0.0\npaths:\n  nothing: {}\n', 'bad.yaml'), /path/);
  assert.throws(() => readContract('openapi: 3.0.0\npaths: {}\nkey: [1]\n', 'subset.yaml'), ContractError);
});

// The YAML subset has no list of mappings, so a contract that names its
// servers is written in JSON.
test('the port is the first server address\'s, when the contract names one', () => {
  const json = JSON.stringify({ openapi: '3.0.3', servers: [{ url: 'http://items:9100/v1' }, { url: 'http://other:9200' }], paths: {} });
  assert.equal(contractPort(readContract(json, 'items.json')), 9100);
  assert.equal(contractPort(readContract(ITEMS, 'items.yaml')), undefined);
  assert.equal(contractPort(readContract(FILTER_API, 'openapi.yaml')), undefined);
});

test('the server answers over HTTP with JSON, on loopback for the test', async (t) => {
  const server = createFakeServer(createFake(readContract(FILTER_API, 'openapi.yaml')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const check = await fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hello"}' });
  assert.equal(check.status, 200);
  assert.match(check.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(await check.json(), { ok: true, words: [] });
  assert.deepEqual(await (await fetch(`${base}/__fake/calls`)).json(), { total: 1, operations: { check: 1 } });
});
