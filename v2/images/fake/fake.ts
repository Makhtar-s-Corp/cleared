// The fake of a service (milestone 2 plan, decision 20): when a sibling of a
// session cannot run for real (the service declares no `run`, or its ticket
// layer cannot be built), Cleared runs this server in its place, built from
// the service's contract. OpenAPI 3 only in milestone 2 (plan question 5),
// in YAML (the subset yaml.ts reads) or JSON.
//
// Each operation answers its first example: its first 2xx response, then
// `content`, `application/json`, then `example`, or the first entry of
// `examples` and its `value` (the path lane 28's log entry fixes). An
// operation with none answers 501 with its name. GET /__fake/calls answers
// how many calls it answered, per operation, for the proofs to read.
//
// Settings (environment):
//   FAKE_CONTRACT  the contract file, mounted read only
//   FAKE_PORT      default 8080
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { parseYaml, YamlError, type Yaml } from './yaml.ts';

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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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

export function readContract(text: string, file: string): Contract {
  let document: Yaml | unknown;
  try {
    document = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new ContractError(`${file} cannot be read: ${error instanceof YamlError || error instanceof SyntaxError ? error.message : String(error)}`);
  }
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
  const port = Number(process.env.FAKE_PORT || 8080);
  const log = (line: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
  let contract: Contract;
  try {
    contract = readContract(readFileSync(file, 'utf8'), file);
  } catch (error) {
    log({ error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  // Inside its container, on the session's internal network only.
  createFakeServer(createFake(contract)).listen(port, '0.0.0.0', () => log({ listening: `0.0.0.0:${port}`, operations: contract.operations.length }));
}

if (import.meta.main) main();
