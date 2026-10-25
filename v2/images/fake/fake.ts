// The fake of a service (milestone 2 plan, decision 20): when a sibling of a
// session cannot run for real (the service declares no `run`, or its ticket
// layer cannot be built), Cleared runs this server in its place, built from
// the service's contract. OpenAPI 3 in milestone 2 (plan question 5), in YAML
// (the subset yaml.ts reads) or JSON; JSON Schema, protobuf and events in
// milestone 3 (owner decision O11, matrix M11), each read into the same
// operations by its own reader:
//   jsonschema  GET /<name> answers the example of the schema (GET / its root,
//               GET /<name> each of its $defs), see schema.ts
//   protobuf    POST /<package>.<Service>/<Method> answers the example of the
//               rpc's response message, proto3 JSON mapping, see proto.ts
//   events      GET and POST /events/<channel>, see events.ts
//
// Each operation answers its first example: its first 2xx response, then
// `content`, `application/json`, then `example`, or the first entry of
// `examples` and its `value` (the path lane 28's log entry fixes). An
// operation with none answers 501 with its name. GET /__fake/calls answers
// how many calls it answered, per operation, for the proofs to read.
//
// Settings (environment):
//   FAKE_CONTRACT  the contract file, mounted read only
//   FAKE_FORMAT    openapi (default), jsonschema, protobuf or events
//   FAKE_PORT      default 8080
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { eventOperations } from './events.ts';
import { readProto, ProtoError } from './proto.ts';
import { generate, isObject, OMIT, SchemaError } from './schema.ts';
import { parseYaml, YamlError, type Yaml } from './yaml.ts';

// The formats a contract can be in; api/types.ts names the same ones (a test checks).
export const CONTRACT_FORMATS = ['openapi', 'jsonschema', 'protobuf', 'events'] as const;
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];

export class ContractError extends Error {
  override name = 'ContractError';
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type Operation = {
  readonly method: string;                       // upper case
  readonly path: string;                         // the contract's template: /items/{id}
  readonly name: string;                         // its operationId, else "METHOD path"
  readonly answer: { readonly status: number; readonly body: unknown } | null;
};

export type Contract = { readonly operations: readonly Operation[]; readonly servers: readonly string[] };

export type Answer = { readonly status: number; readonly body: unknown };

// The first example of an operation's first 2xx JSON response.
function firstExample(responses: unknown): Operation['answer'] {
  if (!isObject(responses)) return null;
  const code = Object.keys(responses).find((key) => /^2[0-9][0-9]$/.test(key));
  if (code === undefined) return null;
  const json = (responses[code] as { content?: Record<string, unknown> } | undefined)?.content?.['application/json'];
  if (!isObject(json)) return null;
  if ('example' in json) return { status: Number(code), body: json.example };
  if (isObject(json.examples)) {
    const first = Object.values(json.examples)[0];
    if (isObject(first) && 'value' in first) return { status: Number(code), body: first.value };
  }
  return null;
}

function parse(text: string, file: string): unknown {
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new ContractError(`${file} cannot be read: ${error instanceof YamlError || error instanceof SyntaxError ? error.message : String(error)}`);
  }
}

// A contract in `format` (OpenAPI 3 when none is given), as operations.
export function readContract(text: string, file: string, format: ContractFormat = 'openapi'): Contract {
  try {
    if (format === 'jsonschema') return readJsonSchema(parse(text, file), file);
    if (format === 'protobuf') return { operations: readProto(text, file).map((op) => ({ method: 'POST', path: op.path, name: op.name, answer: { status: 200, body: op.body } })), servers: [] };
    if (format === 'events') return { operations: eventOperations(parse(text, file), file).map((op) => ({ ...op, name: `${op.method} ${op.path}` })), servers: [] };
  } catch (error) {
    if (error instanceof SchemaError || error instanceof ProtoError) throw new ContractError(error.message);
    throw error;
  }
  if (format !== 'openapi') throw new ContractError(`${file}: format ${JSON.stringify(format)} is not one of ${CONTRACT_FORMATS.join(', ')}`);
  return readOpenApi(parse(text, file), file);
}

const SCHEMA_KEYS = ['$schema', 'type', 'properties', '$defs', 'definitions', '$ref', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'items'];

function readJsonSchema(document: unknown, file: string): Contract {
  if (isObject(document) && typeof document.openapi === 'string') throw new SchemaError(`${file} is an OpenAPI document: name its format openapi`);
  if (!isObject(document) || !SCHEMA_KEYS.some((key) => key in document)) throw new SchemaError(`${file} is not a JSON Schema`);
  const answer = (schema: unknown, stack: readonly string[] = []): Operation['answer'] => {
    const body = generate(schema, document, stack);
    return { status: 200, body: body === OMIT ? null : body };
  };
  const operations: Operation[] = [{ method: 'GET', path: '/', name: typeof document.title === 'string' && document.title ? document.title : 'schema', answer: answer(document) }];
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = document[key];
    if (!isObject(defs)) continue;
    for (const [name, schema] of Object.entries(defs)) {
      if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw new SchemaError(`${file}: the definition ${name} must be letters, digits and _ . : - only, to be one path of the fake`);
      operations.push({ method: 'GET', path: `/${name}`, name, answer: answer(schema, [`#/${key}/${name}`]) });
    }
  }
  return { operations, servers: [] };
}

function readOpenApi(document: Yaml | unknown, file: string): Contract {
  if (!isObject(document) || typeof document.openapi !== 'string' || !document.openapi.startsWith('3.'))
    throw new ContractError(`${file} is not an OpenAPI 3 document: milestone 2 reads OpenAPI 3 only`);
  if (!isObject(document.paths)) throw new ContractError(`${file} has no paths`);
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith('/') || !isObject(item)) throw new ContractError(`${file}: "${path}" is not a path of the contract`);
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const name = typeof operation.operationId === 'string' && operation.operationId ? operation.operationId : `${method.toUpperCase()} ${path}`;
      operations.push({ method: method.toUpperCase(), path, name, answer: firstExample(operation.responses) });
    }
  }
  const servers = Array.isArray(document.servers) ? document.servers.flatMap((server) => (isObject(server) && typeof server.url === 'string' ? [server.url] : [])) : [];
  return { operations, servers };
}

// The port of the contract's first server address, when it names one.
export function contractPort(contract: Contract): number | undefined {
  const first = contract.servers[0];
  if (first === undefined) return undefined;
  try {
    const port = Number(new URL(first).port);
    return port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

// A template's segments match the same number of segments; {name} matches
// any one that is not empty.
function matches(template: string, path: string): boolean {
  const want = template.split('/');
  const have = path.split('/');
  return want.length === have.length && want.every((part, i) => (/^\{[^}]+\}$/.test(part) ? have[i] !== '' : part === have[i]));
}

export type Fake = {
  handle(method: string, url: string): Answer;
};

export function createFake(contract: Contract): Fake {
  const calls = new Map<string, number>();
  let total = 0;
  return {
    handle(method, url) {
      const path = url.split('?')[0] ?? '/';
      if (method === 'GET' && path === '/__fake/calls') return { status: 200, body: { total, operations: Object.fromEntries(calls) } };
      const onPath = contract.operations.filter((operation) => matches(operation.path, path));
      if (onPath.length === 0) return { status: 404, body: { error: `${path} is not a path of the contract` } };
      const operation = onPath.find((candidate) => candidate.method === method);
      if (!operation) return { status: 405, body: { error: `${method} is not an operation of ${path} in the contract` } };
      total += 1;
      calls.set(operation.name, (calls.get(operation.name) ?? 0) + 1);
      if (!operation.answer) return { status: 501, body: { error: `${operation.name} has no example in the contract: the fake cannot answer it` } };
      return operation.answer;
    },
  };
}

// The request's body is read and dropped: the answer does not depend on it.
export function createFakeServer(fake: Fake): Server {
  return createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer = fake.handle(request.method ?? 'GET', request.url ?? '/');
      const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
      response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
      response.end(text);
    });
  });
}

function main(): void {
  const file = process.env.FAKE_CONTRACT || '/etc/cleared/fake/openapi.yaml';
  const format = (process.env.FAKE_FORMAT || 'openapi') as ContractFormat;
  const port = Number(process.env.FAKE_PORT || 8080);
  const log = (line: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
  let contract: Contract;
  try {
    contract = readContract(readFileSync(file, 'utf8'), file, format);
  } catch (error) {
    log({ error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  // Inside its container, on the session's internal network only.
  createFakeServer(createFake(contract)).listen(port, '0.0.0.0', () => log({ listening: `0.0.0.0:${port}`, operations: contract.operations.length }));
}

if (import.meta.main) main();
