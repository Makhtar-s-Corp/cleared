// The contract, contract/openapi.yaml, checked with no dependency: its
// structure against the OpenAPI 3.1 keys Cleared's fake reads, each example
// against its schema, and each example against what the app really answers.
// The fake that stands in for this service in a ticket's trial environment
// is built from these examples, so an example the app would not give back
// would make the fake lie to the guestbook.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server.ts';
import { loadWords } from '../src/words.ts';
import { parseYaml, type Yaml } from './helpers/yaml.ts';

type Node = { [key: string]: Yaml };

const CONTRACT = new URL('../contract/openapi.yaml', import.meta.url);
const contract = parseYaml(readFileSync(CONTRACT, 'utf8'));
const JSON_TYPE = 'application/json';
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const isNode = (value: Yaml | undefined): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

function node(value: Yaml | undefined, where: string): Node {
  assert.ok(isNode(value), `${where} is a mapping`);
  return value;
}

function onlyKeys(value: Node, allowed: readonly string[], where: string): void {
  for (const name of Object.keys(value)) {
    assert.ok(allowed.includes(name) || name.startsWith('x-'), `${where}: "${name}" is not a key of OpenAPI 3.1 here`);
  }
}

const root = node(contract, 'the document');
const paths = node(root.paths, 'paths');
const schemas = node(node(root.components, 'components').schemas, 'components.schemas');

function resolve(schema: Node, where: string): Node {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  assert.equal(typeof ref, 'string', `${where}: $ref`);
  const match = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(ref as string);
  assert.ok(match, `${where}: $ref ${String(ref)} points into components.schemas`);
  return node(schemas[match[1]!], `${where}: ${String(ref)}`);
}

// The JSON Schema keywords the contract uses, checked on a value.
function conforms(value: unknown, raw: Node, where: string): void {
  const schema = resolve(raw, where);
  onlyKeys(schema, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'maxLength', 'minLength', '$ref'], where);
  if (schema.enum !== undefined) assert.ok((schema.enum as Yaml[]).includes(value as Yaml), `${where}: ${JSON.stringify(value)} is one of the enum`);
  switch (schema.type) {
    case 'object': {
      assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${where}: an object`);
      const properties = node(schema.properties ?? {}, `${where}.properties`);
      for (const name of (schema.required ?? []) as string[]) assert.ok(Object.hasOwn(value, name), `${where}: "${name}" is required`);
      for (const [name, item] of Object.entries(value)) {
        const property = properties[name];
        if (property === undefined) {
          assert.equal(schema.additionalProperties, true, `${where}: "${name}" is not a property of the schema`);
          continue;
        }
        conforms(item, node(property, `${where}.${name}`), `${where}.${name}`);
      }
      return;
    }
    case 'array':
      assert.ok(Array.isArray(value), `${where}: an array`);
      for (const [at, item] of value.entries()) conforms(item, node(schema.items, `${where}.items`), `${where}[${at}]`);
      return;
    case 'string':
      assert.equal(typeof value, 'string', `${where}: a string`);
      if (typeof schema.maxLength === 'number') assert.ok((value as string).length <= schema.maxLength, `${where}: within maxLength`);
      return;
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${where}: a boolean`);
      return;
    default:
      assert.fail(`${where}: a type the check does not know: ${String(schema.type)}`);
  }
}

// The examples of a media type, by name: `examples` in order, or `example`
// under the name "example". The fake answers the first one.
function examples(media: Node, where: string): [string, unknown][] {
  onlyKeys(media, ['schema', 'example', 'examples', 'encoding'], where);
  assert.ok(!(media.example !== undefined && media.examples !== undefined), `${where}: example and examples are exclusive`);
  if (media.example !== undefined) return [['example', media.example]];
  const named = node(media.examples, `${where}.examples`);
  const list = Object.entries(named).map(([name, entry]): [string, unknown] => {
    const example = node(entry, `${where}.examples.${name}`);
    onlyKeys(example, ['summary', 'description', 'value', 'externalValue'], `${where}.examples.${name}`);
    assert.ok(Object.hasOwn(example, 'value'), `${where}.examples.${name} has a value`);
    return [name, example.value];
  });
  assert.ok(list.length > 0, `${where} has an example`);
  return list;
}

type Operation = { readonly path: string; readonly method: string; readonly operation: Node };

function operations(): Operation[] {
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    assert.match(path, /^\/[a-z0-9/_-]*$/, 'a path has no template in this contract');
    const methods = node(item, path);
    onlyKeys(methods, [...METHODS, 'summary', 'description', 'parameters', 'servers'], path);
    for (const method of METHODS) if (methods[method] !== undefined) found.push({ path, method, operation: node(methods[method], `${method} ${path}`) });
  }
  return found;
}

// The JSON answer the fake would give: the first 2xx response's first example.
function firstAnswer(operation: Node, where: string): { status: number; media: Node } {
  const responses = node(operation.responses, `${where}.responses`);
  const code = Object.keys(responses).find((status) => /^2[0-9][0-9]$/.test(status));
  assert.ok(code, `${where} has a 2xx response`);
  const response = node(responses[code], `${where}.responses.${code}`);
  return { status: Number(code), media: node(node(response.content, `${where}.responses.${code}.content`)[JSON_TYPE], `${where}.responses.${code} ${JSON_TYPE}`) };
}

test('the document is OpenAPI 3.1 with its required keys, and only keys OpenAPI 3.1 defines', () => {
  onlyKeys(root, ['openapi', 'info', 'jsonSchemaDialect', 'servers', 'paths', 'webhooks', 'components', 'security', 'tags', 'externalDocs'], 'the document');
  assert.match(String(root.openapi), /^3\.1\.[0-9]+$/);
  const info = node(root.info, 'info');
  assert.equal(typeof info.title, 'string');
  assert.equal(typeof info.version, 'string');
  onlyKeys(node(root.components, 'components'), ['schemas'], 'components');
});

test('the operations are POST /check and GET /health, each with an operationId', () => {
  const found = operations().map(({ path, method, operation }) => `${method.toUpperCase()} ${path} ${String(operation.operationId)}`);
  assert.deepEqual(found, ['POST /check check', 'GET /health health']);
});

test('every response has a description, and every JSON answer has an example that fits its schema', () => {
  for (const { path, method, operation } of operations()) {
    const where = `${method} ${path}`;
    onlyKeys(operation, ['operationId', 'summary', 'description', 'requestBody', 'responses', 'parameters', 'tags', 'deprecated'], where);
    const responses = node(operation.responses, `${where}.responses`);
    for (const [status, raw] of Object.entries(responses)) {
      assert.match(status, /^[1-5][0-9][0-9]$/, `${where}: a status code`);
      const response = node(raw, `${where} ${status}`);
      onlyKeys(response, ['description', 'headers', 'content', 'links'], `${where} ${status}`);
      assert.equal(typeof response.description, 'string', `${where} ${status} has a description`);
      if (response.content === undefined) continue;
      const media = node(node(response.content, `${where} ${status}.content`)[JSON_TYPE], `${where} ${status} ${JSON_TYPE}`);
      const schema = node(media.schema, `${where} ${status} schema`);
      for (const [name, value] of examples(media, `${where} ${status}`)) conforms(value, schema, `${where} ${status} example ${name}`);
    }
    firstAnswer(operation, where);
  }
});

test('the request body of POST /check is required JSON, and each of its examples fits its schema', () => {
  const body = node(node(node(paths['/check'], '/check').post, 'post /check').requestBody, 'post /check requestBody');
  assert.equal(body.required, true);
  const media = node(node(body.content, 'requestBody.content')[JSON_TYPE], `requestBody ${JSON_TYPE}`);
  const schema = node(media.schema, 'requestBody schema');
  for (const [name, value] of examples(media, 'requestBody')) conforms(value, schema, `requestBody example ${name}`);
});

test('the fake answers POST /check with an accepted text, so the guestbook stores entries in a trial', () => {
  const [first] = examples(firstAnswer(node(node(paths['/check'], '/check').post, 'post /check'), 'post /check').media, 'post /check 200');
  assert.deepEqual(first?.[1], { ok: true, words: [] });
});

let server: Server;
let base = '';

before(async () => {
  server = createApp(await loadWords());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('each request example of POST /check gets from the app exactly the response example of the same name', async () => {
  const post = node(node(paths['/check'], '/check').post, 'post /check');
  const requests = examples(node(node(node(post.requestBody, 'requestBody').content, 'content')[JSON_TYPE], 'request'), 'request');
  const { status, media } = firstAnswer(post, 'post /check');
  const answers = new Map(examples(media, 'post /check 200'));
  assert.deepEqual([...answers.keys()], requests.map(([name]) => name), 'one answer per request, in the same order');
  for (const [name, body] of requests) {
    const response = await fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': JSON_TYPE }, body: JSON.stringify(body) });
    assert.equal(response.status, status, name);
    assert.deepEqual(await response.json(), answers.get(name), name);
  }
});

test('GET /health gets from the app exactly its example', async () => {
  const { status, media } = firstAnswer(node(node(paths['/health'], '/health').get, 'get /health'), 'get /health');
  const [first] = examples(media, 'get /health 200');
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), first?.[1]);
});
