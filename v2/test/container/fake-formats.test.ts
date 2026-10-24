// The fake of a service for the other contract formats (owner decision O11,
// matrix M11): JSON Schema, protobuf and events, beside OpenAPI 3. Each is
// read into the same operations as an OpenAPI contract, each answering a
// generated example, so the server, /__fake/calls and the port are the
// fake's own. Loopback and unit, no image, no Docker object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContractError, contractPort, createFake, readContract } from '../../images/fake/fake.ts';
import type { ContractFormat } from '../../src/api/types.ts';

// ---- JSON Schema -----------------------------------------------------------

const ISRC_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Isrc',
  type: 'object',
  required: ['code'],
  properties: {
    code: { type: 'string', examples: ['FR-Z03-26-00001'] },
    kind: { enum: ['recording', 'video'] },
    count: { type: 'integer', minimum: 1 },
    when: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string' } },
    owner: { $ref: '#/$defs/Owner' },
    flag: { const: true },
    level: { type: 'number', default: 3 },
  },
  $defs: {
    Owner: { type: 'object', properties: { name: { type: 'string', example: 'Ada' }, parent: { $ref: '#/$defs/Owner' } } },
    Either: { oneOf: [{ type: 'string', const: 'first' }, { type: 'integer' }] },
    Both: { allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }, { type: 'object', properties: { b: { type: 'boolean' } } }] },
  },
});

test('a JSON Schema answers a generated example: its root on GET /, each of its $defs on GET /<name>', () => {
  const fake = createFake(readContract(ISRC_SCHEMA, 'isrc.schema.json', 'jsonschema'));
  assert.deepEqual(fake.handle('GET', '/'), {
    status: 200,
    body: { code: 'FR-Z03-26-00001', kind: 'recording', count: 1, when: '2026-01-01T00:00:00Z', tags: ['string'], owner: { name: 'Ada' }, flag: true, level: 3 },
  });
  assert.deepEqual(fake.handle('GET', '/Owner'), { status: 200, body: { name: 'Ada' } }, 'a cycle through $ref leaves the recursive property out');
  assert.deepEqual(fake.handle('GET', '/Either').body, 'first');
  assert.deepEqual(fake.handle('GET', '/Both').body, { a: 0, b: false });
  assert.equal(fake.handle('GET', '/Nothing').status, 404);
  assert.equal(fake.handle('POST', '/').status, 405);
  assert.deepEqual(fake.handle('GET', '/__fake/calls'), { status: 200, body: { total: 4, operations: { Isrc: 1, Owner: 1, Either: 1, Both: 1 } } });
});

test('a JSON Schema in the YAML subset is read too, and the generated strings carry no secret shape', () => {
  const yaml = 'type: object\nproperties:\n  token:\n    type: string\n  id:\n    type: string\n    format: uuid\n  mail:\n    type: string\n    format: email\n';
  const body = createFake(readContract(yaml, 'schema.yaml', 'jsonschema')).handle('GET', '/').body;
  assert.deepEqual(body, { token: 'string', id: '00000000-0000-0000-0000-000000000000', mail: 'user@example.com' });
});

test('a JSON Schema is refused with a reason when it is not one, or reads another file', () => {
  assert.throws(() => readContract('"just text"', 'a.json', 'jsonschema'), /not a JSON Schema/);
  assert.throws(() => readContract('[1]', 'a.json', 'jsonschema'), ContractError);
  assert.throws(() => readContract('{"openapi":"3.0.0","paths":{}}', 'a.json', 'jsonschema'), /OpenAPI/);
  assert.throws(() => readContract('{"properties":{"a":{"$ref":"https://example.invalid/a.json"}}}', 'a.json', 'jsonschema'), /\$ref.*local/);
  assert.throws(() => readContract('{"properties":{"a":{"$ref":"#/$defs/Missing"}}}', 'a.json', 'jsonschema'), /Missing/);
  assert.throws(() => readContract('{', 'a.json', 'jsonschema'), /a\.json cannot be read/);
});

// ---- protobuf --------------------------------------------------------------

const ROYALTIES_PROTO = `syntax = "proto3";

// The royalties API.
package royalties.v1;

enum Status {
  STATUS_UNKNOWN = 0;
  STATUS_ACTIVE = 1;
}

message Isrc {
  string code = 1;
  int64 registered_at = 2; /* a 64-bit integer is a string in JSON */
  repeated string aliases = 3;
  map<string, int32> weights = 4;
  Status status = 5;
  Owner.Contact contact = 6;
  bool active = 7;
  bytes raw = 8;
  double ratio = 9;
  oneof holder {
    string person = 10;
    string company = 11;
  }
  Isrc parent = 12;
}

message Owner {
  message Contact {
    string email = 1;
  }
  reserved 2, 3;
  Contact main = 1;
}

message GetIsrcRequest {
  string code = 1;
}

message Empty {}

service Royalties {
  rpc GetIsrc (GetIsrcRequest) returns (Isrc);
  rpc Forget (GetIsrcRequest) returns (Empty) {}
}
`;

test('a protobuf contract answers each rpc at POST /<package>.<Service>/<Method> with the proto3 JSON mapping of its response', () => {
  const fake = createFake(readContract(ROYALTIES_PROTO, 'royalties.proto', 'protobuf'));
  const answer = fake.handle('POST', '/royalties.v1.Royalties/GetIsrc');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    code: 'string', registeredAt: '0', aliases: ['string'], weights: { key: 0 }, status: 'STATUS_UNKNOWN', contact: { email: 'string' },
    active: false, raw: '', ratio: 0, person: 'string',
  });
  assert.deepEqual(fake.handle('POST', '/royalties.v1.Royalties/Forget'), { status: 200, body: {} });
  assert.equal(fake.handle('GET', '/royalties.v1.Royalties/GetIsrc').status, 405);
  assert.equal(fake.handle('POST', '/royalties.v1.Royalties/Nothing').status, 404);
  assert.deepEqual(fake.handle('GET', '/__fake/calls').body, { total: 2, operations: { 'royalties.v1.Royalties/GetIsrc': 1, 'royalties.v1.Royalties/Forget': 1 } });
});

test('a protobuf contract without a package names its services bare, and a nested type resolves from its scope outward', () => {
  const text = 'syntax = "proto3";\nmessage A { message B { string x = 1; } B b = 1; }\nservice S { rpc Go (A) returns (A.B); }\n';
  assert.deepEqual(createFake(readContract(text, 'a.proto', 'protobuf')).handle('POST', '/S/Go'), { status: 200, body: { x: 'string' } });
});

test('protobuf outside the stated subset is refused with its line', () => {
  const head = 'syntax = "proto3";\n';
  assert.throws(() => readContract('syntax = "proto2";\nmessage A {}\n', 'a.proto', 'protobuf'), /a\.proto:1: .*proto3/);
  assert.throws(() => readContract('message A {}\n', 'a.proto', 'protobuf'), /a\.proto:1: .*proto3/);
  assert.throws(() => readContract(`${head}import "other.proto";\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*import/);
  assert.throws(() => readContract(`${head}message A {}\nservice S {\n  rpc Go (A) returns (stream A);\n}\n`, 'a.proto', 'protobuf'), /a\.proto:4: .*stream/);
  assert.throws(() => readContract(`${head}message A {}\nservice S {\n  rpc Go (stream A) returns (A);\n}\n`, 'a.proto', 'protobuf'), /a\.proto:4: .*stream/);
  assert.throws(() => readContract(`${head}message A { string s = 1 [deprecated = true]; }\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*option/);
  assert.throws(() => readContract(`${head}extend A { string s = 1; }\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*extend/);
  assert.throws(() => readContract(`${head}message A { Missing m = 1; }\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*unknown type Missing/);
  assert.throws(() => readContract(`${head}message A {\n  string s = 1;\n`, 'a.proto', 'protobuf'), /a\.proto:\d+: .*end of file/);
  assert.throws(() => readContract(`${head}message A { string s = 1; string t = 1; }\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*field number 1/);
  assert.throws(() => readContract(`${head}message A {}\nmessage A {}\n`, 'a.proto', 'protobuf'), /a\.proto:3: .*A.*twice/);
  assert.throws(() => readContract(`${head}message A { string s = 1; /* open\n`, 'a.proto', 'protobuf'), /a\.proto:2: .*comment/);
});

test('a protobuf contract has no server address, so the fake keeps the default port', () => {
  assert.equal(contractPort(readContract(ROYALTIES_PROTO, 'royalties.proto', 'protobuf')), undefined);
});

// ---- events ----------------------------------------------------------------

const EVENTS_YAML = `asyncapi: 2.6.0
info:
  title: Royalties events
  version: 1.0.0
channels:
  isrc.assigned:
    subscribe:
      message:
        name: IsrcAssigned
        payload:
          type: object
          properties:
            isrc:
              type: string
              example: FR-Z03-26-00001
            at:
              type: string
              format: date-time
  isrc.revoked:
    publish:
      message:
        name: IsrcRevoked
`;

test('an events contract answers each channel\'s payload example on GET /events/<channel> and accepts a publication on POST', () => {
  const fake = createFake(readContract(EVENTS_YAML, 'events.yaml', 'events'));
  assert.deepEqual(fake.handle('GET', '/events/isrc.assigned'), { status: 200, body: { isrc: 'FR-Z03-26-00001', at: '2026-01-01T00:00:00Z' } });
  assert.deepEqual(fake.handle('POST', '/events/isrc.assigned'), { status: 202, body: { accepted: true } });
  const none = fake.handle('GET', '/events/isrc.revoked');
  assert.equal(none.status, 501);
  assert.deepEqual(none.body, { error: 'GET /events/isrc.revoked has no example in the contract: the fake cannot answer it' });
  assert.equal(fake.handle('GET', '/events/other').status, 404);
  assert.deepEqual(fake.handle('GET', '/__fake/calls').body, { total: 3, operations: { 'GET /events/isrc.assigned': 1, 'POST /events/isrc.assigned': 1, 'GET /events/isrc.revoked': 1 } });
});

test('an events message answers its first example, else its payload, a $ref into components included (JSON)', () => {
  const json = JSON.stringify({
    asyncapi: '2.6.0',
    channels: {
      'isrc.assigned': { subscribe: { message: { $ref: '#/components/messages/Assigned' } } },
      'isrc.moved': { subscribe: { message: { examples: [{ payload: { isrc: 'FR-Z03-26-00002' } }], payload: { type: 'object' } } } },
    },
    components: { messages: { Assigned: { payload: { $ref: '#/components/schemas/Assigned' } } }, schemas: { Assigned: { type: 'object', properties: { isrc: { type: 'string' } } } } },
  });
  const fake = createFake(readContract(json, 'events.json', 'events'));
  assert.deepEqual(fake.handle('GET', '/events/isrc.assigned').body, { isrc: 'string' });
  assert.deepEqual(fake.handle('GET', '/events/isrc.moved').body, { isrc: 'FR-Z03-26-00002' });
});

test('an events contract outside the stated subset is refused with a reason', () => {
  assert.throws(() => readContract('asyncapi: 3.0.0\nchannels: {}\n', 'e.yaml', 'events'), /AsyncAPI 2/);
  assert.throws(() => readContract('openapi: 3.0.0\npaths: {}\n', 'e.yaml', 'events'), /AsyncAPI 2/);
  assert.throws(() => readContract('asyncapi: 2.6.0\n', 'e.yaml', 'events'), /channels/);
  assert.throws(() => readContract('asyncapi: 2.6.0\nchannels:\n  royalties/isrc:\n    publish:\n      message:\n        name: X\n', 'e.yaml', 'events'), /channel.*royalties\/isrc/);
  assert.throws(() => readContract('asyncapi: 2.6.0\nchannels:\n  a:\n    subscribe:\n      message:\n        payload:\n          $ref: "https://example.invalid/p.json"\n', 'e.yaml', 'events'), /\$ref.*local/);
});

// ---- the format is the contract's, and OpenAPI stays the default -------------

test('OpenAPI stays the default format, and a contract of another format is not read as OpenAPI', () => {
  const openapi = JSON.stringify({ openapi: '3.0.3', paths: { '/ping': { get: { responses: { '200': { content: { 'application/json': { example: { pong: true } } } } } } } } });
  assert.deepEqual(createFake(readContract(openapi, 'api.json')).handle('GET', '/ping').body, { pong: true });
  assert.deepEqual(createFake(readContract(openapi, 'api.json', 'openapi')).handle('GET', '/ping').body, { pong: true });
  assert.throws(() => readContract(ROYALTIES_PROTO, 'royalties.proto'), ContractError);
  assert.throws(() => readContract(ISRC_SCHEMA, 'x.json', 'swagger' as ContractFormat), /format/);
});

test('the fake and the service API name the same formats', async () => {
  const { CONTRACT_FORMATS } = (await import('../../images/fake/fake.ts')) as { CONTRACT_FORMATS?: readonly string[] };
  const types = readFileSync(new URL('../../src/api/types.ts', import.meta.url), 'utf8');
  const named = /export type ContractFormat = ([^;]+);/.exec(types)?.[1];
  assert.deepEqual(named?.split('|').map((part) => part.trim().replaceAll("'", '')), [...(CONTRACT_FORMATS ?? [])]);
});

// The image copies the modules fake.ts imports, by name: one it forgets is
// a fake that cannot start.
test('the fake image copies every module the fake imports', () => {
  const dir = new URL('../../images/fake/', import.meta.url);
  const copied = new Set([...readFileSync(new URL('Dockerfile', dir), 'utf8').matchAll(/^COPY (\S+\.ts) /gm)].map((m) => m[1] as string));
  const seen = new Set<string>(['fake.ts']);
  for (const file of seen)
    for (const m of readFileSync(new URL(file, dir), 'utf8').matchAll(/from '\.\/([^']+\.ts)'/g)) seen.add(m[1] as string);
  assert.ok(seen.size >= 4, [...seen].join(', '));
  for (const file of seen) assert.ok(copied.has(file), `${file} is imported by the fake and not copied by its Dockerfile`);
});
